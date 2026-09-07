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

  it("runs sweep, then seed, then publishes status, then waits for the settings load, then asks the catalog", async () => {
    const order: string[] = [];
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
    installer.republishStatus.mockImplementation(() => {
      order.push("republish");
    });
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
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    // The status is published BEFORE the settle wait, so `_voicePackStatus` is
    // in the cache for the settings window from the start rather than only once
    // the first (possibly slow) catalog fetch has come back.
    expect(order).toEqual(["sweep", "seed", "republish"]);
    release();
    await expect(started).resolves.toEqual({ state: "current" });
    expect(order).toEqual(["sweep", "seed", "republish", "settled", "catalog", "republish"]);
  });

  it("installs default when the catalog offers it as missing, and reports current afterwards", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "install" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "current" });
    expect(installer.install).toHaveBeenCalledWith("default");
  });

  describe("a managed pack whose record says installed but whose clips are gone (isPackUsable)", () => {
    function usable(packs: VoicePackOffer[], isPackUsable: (id: string) => boolean) {
      const installer = fakeInstaller(ok(packs));
      const step = createVoicePackLaunchStep({
        installer,
        settled: () => Promise.resolve(),
        isPackUsable,
        isRaceEngineerEnabled: () => true,
        logger,
      });

      return { installer, step };
    }

    it("force-reinstalls default when the scanner lists no usable copy of it", async () => {
      const { installer, step } = usable([offer({ id: "default", verdict: "installed" })], () => false);
      await expect(step.start()).resolves.toEqual({ state: "current" });
      expect(installer.install).toHaveBeenCalledTimes(1);
      expect(installer.install).toHaveBeenCalledWith("default", { force: true });
      expect(logger.warn).toHaveBeenCalledWith(
        "Voice packs: the managed pack is installed but unusable; reinstalling it",
      );
      expect(logger.debug).toHaveBeenCalledWith('Voice pack "default": record present, no usable voice on disk');
    });

    it("leaves a usable default alone", async () => {
      const { installer, step } = usable([offer({ id: "default", verdict: "installed" })], () => true);
      await expect(step.start()).resolves.toEqual({ state: "current" });
      expect(installer.install).not.toHaveBeenCalled();
    });

    it("never force-reinstalls another pack, however unusable — only the managed pack is the plugin's to replace", async () => {
      const { installer, step } = usable(
        [offer({ id: "default", verdict: "installed" }), offer({ id: "luca", verdict: "installed" })],
        (id) => id !== "luca",
      );
      await expect(step.start()).resolves.toEqual({ state: "current" });
      expect(installer.install).not.toHaveBeenCalled();
    });

    it("installs an ordinary target without the force option", async () => {
      const { installer, step } = usable([offer({ id: "default", verdict: "update" })], () => true);
      await expect(step.start()).resolves.toEqual({ state: "current" });
      expect(installer.install).toHaveBeenCalledWith("default");
    });
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
      isPackUsable: () => true,
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
      isPackUsable: () => true,
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
      isPackUsable: () => true,
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
      isPackUsable: () => true,
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
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(retrying.start()).resolves.toMatchObject({ state: "retry-scheduled" });

    const permanentInstaller = fakeInstaller(
      catalog,
      vi.fn(async () => permanent),
    );
    const givenUp = createVoicePackLaunchStep({
      installer: permanentInstaller,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(givenUp.start()).resolves.toMatchObject({ state: "given-up" });
    // Given up for THIS catalog answer, not for the process: re-observed on
    // the hour whatever the gate says, so a captive portal or a momentarily
    // wrong catalog does not cost the rest of the session.
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(givenUp.lastOutcome()).toMatchObject({ state: "given-up" });
    expect(permanentInstaller.refreshCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(
      VOICE_PACK_RETRY_STEADY_MS.engineerOff - VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2,
    );
    expect(permanentInstaller.refreshCatalog).toHaveBeenCalledTimes(2);
    expect(permanentInstaller.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
  });

  it("gives up when the catalog says default needs a newer plugin, and re-asks hourly rather than never", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "unsupported", minPluginVersion: "9.0.0" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "given-up", reason: expect.stringContaining("9.0.0") });
    expect(installer.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff - 1);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
    expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
    expect(step.lastOutcome()).toMatchObject({ state: "given-up" });
    // And again an hour later: a give-up re-arms itself.
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(3);
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
      isPackUsable: () => true,
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

  it.each(["verify", "extract", "invalid-pack"] as const)(
    "classes %s as permanent for this catalog answer: given up, and re-observed hourly rather than on the failure schedule",
    async (code) => {
      const failure: VoicePackInstallResult = { ok: false, code, reason: "The archive is wrong." };
      const installer = fakeInstaller(
        ok([offer({ id: "default", verdict: "install" })]),
        vi.fn(async () => failure),
      );
      const step = createVoicePackLaunchStep({
        installer,
        settled: () => Promise.resolve(),
        isPackUsable: () => true,
        isRaceEngineerEnabled: () => true,
        logger,
      });
      await expect(step.start()).resolves.toMatchObject({ state: "given-up" });
      await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
      expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
    },
  );

  it("gives up when the catalog answers but names no default pack, rather than calling that up to date", async () => {
    const installer = fakeInstaller(ok([offer({ id: "luca", verdict: "installed" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "given-up", reason: 'the catalog names no "default" pack' });
    expect(installer.install).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("stop cancels the hourly re-observation a give-up armed", async () => {
    const installer = fakeInstaller(ok([offer({ id: "luca", verdict: "installed" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toMatchObject({ state: "given-up" });
    step.stop();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOff * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("installs its targets one after another, never concurrently — each promote stops playback and rescans", async () => {
    const pending = new Map<string, (r: VoicePackInstallResult) => void>();
    const install = vi.fn(
      (id: string) =>
        new Promise<VoicePackInstallResult>((r) => {
          pending.set(id, r);
        }),
    );
    const installer = fakeInstaller(
      ok([offer({ id: "default", verdict: "update" }), offer({ id: "luca", verdict: "update" })]),
      install,
    );
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(install.mock.calls.map(([id]) => id)).toEqual(["default"]);
    pending.get("default")?.(installed);
    await vi.advanceTimersByTimeAsync(0);
    expect(install.mock.calls.map(([id]) => id)).toEqual(["default", "luca"]);
    pending.get("luca")?.(installed);
    await expect(started).resolves.toEqual({ state: "current" });
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
      isPackUsable: () => true,
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

  it("a poke before start has passed the settle wait runs nothing, and the first ensure then bypasses the catalog TTLs for it", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
    let release!: () => void;
    const settled = new Promise<void>((r) => {
      release = r;
    });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => settled,
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    step.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(installer.refreshCatalog).not.toHaveBeenCalled();
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    step.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(installer.refreshCatalog).not.toHaveBeenCalled();
    release();
    await expect(started).resolves.toEqual({ state: "current" });
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    // The person pressed Rescan while the step was still waiting: they asked
    // for a request, and the ensure that covers the poke honours that.
    expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
    expect(logger.debug).toHaveBeenCalledWith("Voice pack poke deferred until the launch step is ready");
  });

  it("a start with no poke behind it asks the catalog conditionally", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "current" });
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: false });
  });

  describe("the Race Engineer gate (onSettingsChange)", () => {
    function gated(initiallyEnabled: boolean) {
      let enabled = initiallyEnabled;
      let listener: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const onSettingsChange = vi.fn((l: () => void) => {
        listener = l;

        return unsubscribe;
      });
      const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
      const step = createVoicePackLaunchStep({
        installer,
        settled: () => Promise.resolve(),
        isPackUsable: () => true,
        isRaceEngineerEnabled: () => enabled,
        onSettingsChange,
        logger,
      });

      return {
        step,
        installer,
        onSettingsChange,
        unsubscribe,
        settle(next: boolean) {
          enabled = next;
          listener?.();
        },
      };
    }

    it("pokes on the gate turning on, once per edge", async () => {
      const { step, installer, settle, onSettingsChange } = gated(false);
      await step.start();
      expect(onSettingsChange).toHaveBeenCalledTimes(1);
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
      expect(installer.refreshCatalog).toHaveBeenLastCalledWith({ bypassTtl: true });
      // Still on: not an edge.
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(2);
      // Off, then on again: a second edge.
      settle(false);
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(3);
    });

    it("does nothing for a settings arrival that leaves the gate where it was, or turns it off", async () => {
      const { step, installer, settle } = gated(true);
      await step.start();
      settle(true);
      settle(false);
      settle(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    });

    it("subscribes only once start has passed the settle wait, and stop unsubscribes", async () => {
      const { step, onSettingsChange, unsubscribe, installer, settle } = gated(false);
      expect(onSettingsChange).not.toHaveBeenCalled();
      await step.start();
      expect(onSettingsChange).toHaveBeenCalledTimes(1);
      step.stop();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
    });

    it("never subscribes when stopped before the settle wait passed", async () => {
      const { step, onSettingsChange, unsubscribe } = gated(false);
      step.stop();
      await step.start();
      expect(onSettingsChange).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
    });
  });

  it("stop mid-ensure: the failure that lands afterwards is given up as stopped, with no timer", async () => {
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
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    const started = step.start();
    await vi.advanceTimersByTimeAsync(0);
    step.stop();
    resolveInstall({ ok: false, code: "download", reason: "The network dropped." });
    await expect(started).resolves.toEqual({ state: "given-up", reason: "stopped" });
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("arms the retry on the injected timers, unrefs the handle, and clears it through the injected clearTimeout on stop", async () => {
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof globalThis.setTimeout>;
    const setTimeoutFn = vi.fn<typeof globalThis.setTimeout>().mockReturnValue(handle);
    const clearTimeoutFn = vi.fn<typeof globalThis.clearTimeout>();
    const installer = fakeInstaller({ state: "unknown" });
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });
    await expect(step.start()).resolves.toMatchObject({ state: "retry-scheduled" });
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0]);
    expect((handle as unknown as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalledTimes(1);
    step.stop();
    expect(clearTimeoutFn).toHaveBeenCalledTimes(1);
    expect(clearTimeoutFn).toHaveBeenCalledWith(handle);
  });

  it("never rejects — a throwing sweep is logged, and the seed, the settle wait and the ensure still run", async () => {
    const installer = fakeInstaller(ok([offer({ id: "default", verdict: "installed" })]));
    installer.sweep.mockRejectedValue(new Error("disk"));
    const settled = vi.fn(() => Promise.resolve());
    const step = createVoicePackLaunchStep({
      installer,
      settled,
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toEqual({ state: "current" });
    expect(logger.error).toHaveBeenCalled();
    expect(installer.seed).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("never rejects — a throwing catalog read is logged and scheduled for retry", async () => {
    const installer = fakeInstaller({ state: "unknown" });
    installer.refreshCatalog.mockRejectedValue(new Error("boom"));
    const step = createVoicePackLaunchStep({
      installer,
      settled: () => Promise.resolve(),
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await expect(step.start()).resolves.toMatchObject({
      state: "retry-scheduled",
      inMs: VOICE_PACK_RETRY_DELAYS_MS.engineerOn[0],
    });
    expect(logger.error).toHaveBeenCalled();
    // Twice: the startup publish after the seed, then the ensure's own `finally`
    // — the point here being that the second one still happens when the catalog
    // read threw.
    expect(installer.republishStatus).toHaveBeenCalledTimes(2);
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
      isPackUsable: () => true,
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
      isPackUsable: () => true,
      isRaceEngineerEnabled: () => true,
      logger,
    });
    await step.start();
    step.stop();
    await vi.advanceTimersByTimeAsync(VOICE_PACK_RETRY_STEADY_MS.engineerOn * 2);
    expect(installer.refreshCatalog).toHaveBeenCalledTimes(1);
  });
});
