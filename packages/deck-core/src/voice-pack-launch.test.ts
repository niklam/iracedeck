import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoicePackInstaller, VoicePackInstallResult } from "./voice-pack-installer.js";
import {
  createVoicePackLaunchStep,
  ENSURED_VOICE_PACK_ID,
  isManagedVoicePack,
  VOICE_PACK_RETRY_DELAYS_MS,
  VOICE_PACK_RETRY_STEADY_MS,
} from "./voice-pack-launch.js";
import type { VoicePackCatalogState, VoicePackOffer } from "./voice-pack-status.js";

const logger: ILogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: () => logger,
  withLevel: () => logger,
} as unknown as ILogger;

function offer(partial: Partial<VoicePackOffer> & Pick<VoicePackOffer, "id" | "verdict">): VoicePackOffer {
  return { label: partial.id, version: "1.0.0", bytes: 1, ...partial };
}

function ok(packs: VoicePackOffer[]): VoicePackCatalogState {
  return { state: "ok", packs, checkedAt: 0 };
}

const installed: VoicePackInstallResult = { ok: true, outcome: "installed" };

function fakeInstaller(
  catalog: VoicePackCatalogState | (() => VoicePackCatalogState),
  install: VoicePackInstaller["install"] = vi.fn<VoicePackInstaller["install"]>(async () => installed),
) {
  return {
    sweep: vi.fn(async () => ({ removed: 0, failed: 0, kept: 0 })),
    seed: vi.fn(async () => ({ outcome: "skipped" as const, reason: "nothing-bundled" as const })),
    refreshCatalog: vi.fn(async () => (typeof catalog === "function" ? catalog() : catalog)),
    install,
    republishStatus: vi.fn(),
  } satisfies Pick<VoicePackInstaller, "sweep" | "seed" | "refreshCatalog" | "install" | "republishStatus">;
}

describe("voice-pack launch step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("names the managed pack", () => {
    expect(ENSURED_VOICE_PACK_ID).toBe("default");
    expect(isManagedVoicePack("default")).toBe(true);
    expect(isManagedVoicePack("luca")).toBe(false);
  });

  it("runs sweep, then seed, then waits for the settings load, then asks the catalog", async () => {
    const order: string[] = [];
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
    installer.sweep.mockImplementation(async () => {
      order.push("sweep");

      return { removed: 0, failed: 0, kept: 0 };
    });
    installer.seed.mockImplementation(async () => {
      order.push("seed");

      return { outcome: "skipped", reason: "nothing-bundled" };
    });
    installer.refreshCatalog.mockImplementation(async () => {
      order.push("catalog");

      return ok([offer({ id: "default", verdict: "installed" })]);
    });
    let release!: () => void;
    const settled = new Promise<void>((r) => {
      release = () => {
        order.push("settled");
        r();
      };
    });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => settled,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["sweep", "seed"]);
    release();
    await expect(started).resolves.toEqual({ state: "current" });
    expect(order).toEqual(["sweep", "seed", "settled", "catalog"]);
    expect(installer.republishStatus).toHaveBeenCalled();
  });

  it("installs default when the catalog offers it as missing, and reports current afterwards", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "install" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "current" });
    expect(installer.install).toHaveBeenCalledWith("default");
  });

  it("updates default and every other catalog-installed pack that is behind, but never installs another pack that is merely absent", async () => {
    const installer = fakeInstaller(
      ok([
        offer({ id: "default", verdict: "update" }),
        offer({ id: "luca", verdict: "update" }),
        offer({ id: "nina", verdict: "install" }),
        offer({ id: "old", verdict: "unsupported" }),
      ]),
    );
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "current" });
    expect(vi.mocked(installer.install).mock.calls.map(([id]) => id)).toEqual(["default", "luca"]);
  });

  it("retries on the engineer-on schedule while the catalog is unknown, bypassing the failure TTL, and stops once it answers", async () => {
    let answer: VoicePackCatalogState = { state: "unknown" };
    const installer = fakeInstaller(() => answer);
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const first = await step.start();
    expect(first).toEqual({
      state: "retry-scheduled",
      inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0],
      reason: expect.any(String),
    });
    expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: false });

    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0]);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
    expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
    expect(step.lastOutcome()).toMatchObject({
      state: "retry-scheduled",
      inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOn[1],
    });

    answer = ok([offer({ id: "default", verdict: "installed" })]);
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_DELAYS_MS.engineerOn[1]);
    expect(step.lastOutcome()).toEqual({ state: "current" });
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 3);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(3);
  });

  it("settles into the steady interval after the schedule runs out", async () => {
    const installer = fakeInstaller({ state: "unknown" });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => false,
      logger,
    });
    await step.start();

    for (const delay of VOICE_PACK_RETRY_DELAYS_MS.engineerOff) await vi.advanceTimersByTimeAsync(delay);

    expect(step.lastOutcome()).toMatchObject({ inMs: VOICE_PACK_RETRY_STEADY_MS.engineerOff });
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff);
    expect(step.lastOutcome()).toMatchObject({ inMs: VOICE_PACK_RETRY_STEADY_MS.engineerOff });
  });

  it("reads the Race Engineer gate live: the schedule tightens when the gate turns on", async () => {
    let enabled = false;
    const installer = fakeInstaller({ state: "unknown" });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => enabled,
      logger,
    });
    await step.start();
    expect(step.lastOutcome()).toMatchObject({ inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOff[0] });
    enabled = true;
    step.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
    expect(step.lastOutcome()).toMatchObject({ inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0] });
  });

  it("retries a transient install failure and gives up on one a retry cannot fix", async () => {
    const transient: VoicePackInstallResult = { ok: false, code: "download", reason: "The network dropped." };
    const permanent: VoicePackInstallResult = { ok: false, code: "unsupported", reason: "Needs a newer plugin." };
    const catalog = ok([offer({ id: "default", verdict: "install" })]);

    const retrying = createVoicePackLaunchStep({
      installer: fakeInstaller(
        catalog,
        vi.fn(async () => transient),
      ),
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(retrying.start()).resolves.toMatchObject({ state: "retry-scheduled" });

    const stopped = createVoicePackLaunchStep({
      installer: fakeInstaller(
        catalog,
        vi.fn(async () => permanent),
      ),
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(stopped.start()).resolves.toMatchObject({ state: "given-up" });
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(stopped.lastOutcome()).toMatchObject({ state: "given-up" });
  });

  it("gives up without a timer when the catalog says default needs a newer plugin", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "unsupported", minPluginVersion: "9.0.0" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "given-up", reason: expect.stringContaining("9.0.0") });
    expect(installer.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("a failure set that mixes permanent and transient still retries, since a retry can fix part of it", async () => {
    const results: Record<string, VoicePackInstallResult> = {
      default: { ok: false, code: "download", reason: "The network dropped." },
      luca: { ok: false, code: "invalid-pack", reason: "Not a voice pack." },
    };
    const installer = fakeInstaller(
      ok([offer({ id: "default", verdict: "install" }), offer({ id: "luca", verdict: "update" })]),
      vi.fn(async (id: string) => results[id]),
    );
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toMatchObject({
      state: "retry-scheduled",
      inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0],
    });
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0]);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("a poke during an ensure runs one more ensure after it, not a concurrent one", async () => {
    let resolveInstall!: (r: VoicePackInstallResult) => void;
    const install = vi.fn(
      () =>
        new Promise<VoicePackInstallResult>((r) => {
          resolveInstall = r;
        }),
    );
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "install" })]), install);
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    step.poke();
    step.poke();
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    resolveInstall(installed);
    await started;
    await vi.advanceTimersByTimeAsync(0);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("never rejects — a throwing installer is logged and scheduled for retry", async () => {
    const installer = fakeInstaller(
      ok([offer({ id: "default", verdict: "install" })]),
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toMatchObject({ state: "retry-scheduled" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("stop cancels a scheduled retry", async () => {
    const installer = fakeInstaller({ state: "unknown" });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await step.start();
    step.stop();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });
});
