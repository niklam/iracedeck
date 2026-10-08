import { VERSION_CHECK_STARTUP_GRACE_MS } from "@iracedeck/deck-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createFakeExtension, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import type { PluginExtension } from "../types.js";
import { initAudio } from "./audio.js";
import { initCore } from "./core.js";
import { initSettings } from "./settings.js";
import { initVoicePacks } from "./voice-packs.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/deck-iracing", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/event-bus", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/sim-events-iracing", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-service", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-scenarios", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/rasterizer", async () => (await import("../test-support/module-mocks.js")).rasterizerMock());
vi.mock("@iracedeck/race-engineer-wiring", async () =>
  (await import("../test-support/module-mocks.js")).raceEngineerWiringMock(),
);
vi.mock("../actions.js", async () => (await import("../test-support/module-mocks.js")).actionsMock());

function boot(extension?: PluginExtension) {
  const handlerDeps: Record<string, unknown>[] = [];
  const listeners: ((settings: unknown) => void)[] = [];
  implement("createSettingsWindowCommandHandler", (deps) => handlerDeps.push(deps as Record<string, unknown>));
  // The store-ready block calls `.then(…)` on this; a stub is never thenable.
  implement("createSettingsWindowController().ensureStarted", () => new Promise(() => undefined));
  const host = createHost(extension);
  const core = initCore(host);
  const audio = initAudio(core);
  const voicePacks = initVoicePacks(core, audio);
  implement("onGlobalSettingsChange", (listener) => listeners.push(listener as never));
  const settings = initSettings(core, audio, voicePacks);

  return { host, handlerDeps, listeners, settings, voicePacks, audio };
}

/**
 * Drive the version check: the store-ready block sets the startup flag and
 * arms the #870 grace timer; the first-run check declines the start, so the
 * changelog check runs with the deps captured here.
 */
async function versionCheckDeps(extension?: PluginExtension): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  vi.useFakeTimers();
  implement("isSettingsStoreReady", () => true);
  implement("getGlobalSettings", () => ({}));
  implement("runFirstRunCheck", () => Promise.resolve(false));
  implement("runVersionCheck", (deps) => {
    seen.push(deps as Record<string, unknown>);

    return Promise.resolve();
  });
  const { listeners } = boot(extension);

  listeners.at(-1)?.({});
  await vi.advanceTimersByTimeAsync(VERSION_CHECK_STARTUP_GRACE_MS);

  return seen;
}

describe("initSettings", () => {
  let exitListenersBefore: Set<unknown>;

  beforeEach(() => {
    resetRecorder();
    exitListenersBefore = new Set(process.listeners("exit"));
  });
  afterEach(() => {
    vi.useRealTimers();

    // Each boot registers two exit flushes; never let them pile up on the worker.
    for (const listener of process.listeners("exit")) {
      if (!exitListenersBefore.has(listener)) process.removeListener("exit", listener);
    }
  });
  afterAll(() => cleanupTempBinDirs());

  it("passes the window no switchProfile without a host extension (Mirabox, Ulanzi)", () => {
    const { handlerDeps } = boot();

    expect(handlerDeps).toHaveLength(1);
    // Positive control: the handler did get its other deps.
    expect(handlerDeps[0]).toHaveProperty("writeSettings");
    expect(handlerDeps[0]).not.toHaveProperty("switchProfile");
  });

  it("routes the window's profile buttons to the extension (Stream Deck)", () => {
    const { handlerDeps } = boot(createFakeExtension());

    expect(handlerDeps[0]).toHaveProperty("switchProfile");
    (handlerDeps[0].switchProfile as (d: string, p: string) => void)("dev", "Default");

    expect(callLog).toContain("extension.switchProfile");
  });

  it("gives the version check no deviceType without a host extension (Mirabox, Ulanzi)", async () => {
    const seen = await versionCheckDeps();

    expect(seen).toHaveLength(1);
    expect(seen[0].deviceType).toBeUndefined();
    expect(callLog).not.toContain("extension.getConnectedDeviceType");
  });

  it("gives the version check the extension's connected device type (Stream Deck)", async () => {
    const seen = await versionCheckDeps(createFakeExtension());

    expect(seen).toHaveLength(1);
    expect(seen[0].deviceType).toBe(7);
    expect(callLog).toContain("extension.getConnectedDeviceType");
  });

  it("hands the window every voice-pack command from the voice-pack phase", () => {
    const { handlerDeps, voicePacks } = boot();
    const commands = Object.entries(voicePacks.windowCommands);

    expect(commands.length).toBeGreaterThan(0);

    for (const [name, command] of commands) {
      expect(handlerDeps[0][name], name).toBe(command);
    }
  });

  it("runs the store-ready block once: migrations, then the startup gates, then arms the gate sync", () => {
    vi.useFakeTimers();
    implement("isSettingsStoreReady", () => true);
    const { listeners } = boot();
    const big = listeners.at(-1);
    callLog.length = 0;

    big?.({});
    big?.({});

    const sequence = callLog.filter((n) =>
      [
        "deleteGlobalSettings",
        "migrateLfeIntensityBindingKeys",
        "migrateStartupPolicies",
        "applyStartupFeatureGates",
        "armFeatureGateSync",
      ].includes(n),
    );
    expect(sequence).toEqual([
      "deleteGlobalSettings",
      "deleteGlobalSettings",
      "migrateLfeIntensityBindingKeys",
      "migrateStartupPolicies",
      "applyStartupFeatureGates",
      "armFeatureGateSync",
    ]);
  });

  it("gives the startup policies the audio phase's feature-gate logger", () => {
    vi.useFakeTimers();
    implement("isSettingsStoreReady", () => true);
    const loggers: unknown[] = [];
    implement("migrateStartupPolicies", (logger) => loggers.push(logger));
    implement("applyStartupFeatureGates", (logger) => loggers.push(logger));
    const { listeners, audio } = boot();

    listeners.at(-1)?.({});

    expect(loggers).toEqual([audio.featureGateLogger, audio.featureGateLogger]);
  });

  it("never starts the voice-pack launch step from the store-ready block (#1034 ruling 2)", () => {
    vi.useFakeTimers();
    implement("isSettingsStoreReady", () => true);
    const { listeners } = boot();
    callLog.length = 0;

    listeners.at(-1)?.({});

    // Positive control: the store-ready block did run.
    expect(callLog).toContain("armFeatureGateSync");
    expect(callLog).not.toContain("createVoicePackLaunchStep().start");
  });

  it("re-pushes the voice-pack lists, qualifies the voice id and re-asserts the banner on every settings arrival", () => {
    // Store not ready: only the every-arrival tail runs.
    implement("isSettingsStoreReady", () => false);
    const { listeners, voicePacks } = boot();
    const calls: string[] = [];
    implement("migrateRaceEngineerVoiceId", (voices, logger) => {
      expect(voices).toBe(voicePacks.state.raceEngineerVoices);
      expect(logger).toBe(voicePacks.logger);
      calls.push("migrateRaceEngineerVoiceId");
    });
    vi.spyOn(voicePacks.push, "raceEngineerVoices").mockImplementation(() => calls.push("raceEngineerVoices"));
    vi.spyOn(voicePacks.push, "driverNames").mockImplementation(() => calls.push("driverNames"));
    vi.spyOn(voicePacks.push, "packList").mockImplementation(() => calls.push("packList"));
    vi.spyOn(voicePacks, "reassertVoiceScriptWarning").mockImplementation(() => calls.push("reassert"));

    listeners.at(-1)?.({});

    expect(calls).toEqual(["raceEngineerVoices", "driverNames", "packList", "migrateRaceEngineerVoiceId", "reassert"]);
    expect(callLog).not.toContain("armFeatureGateSync");
  });

  it("re-pushes the devices, the voice-pack lists and the installer status when a PI appears", () => {
    const { host, voicePacks } = boot();
    const calls: string[] = [];
    vi.spyOn(voicePacks.push, "raceEngineerVoices").mockImplementation(() => calls.push("raceEngineerVoices"));
    vi.spyOn(voicePacks.push, "driverNames").mockImplementation(() => calls.push("driverNames"));
    vi.spyOn(voicePacks.push, "packList").mockImplementation(() => calls.push("packList"));
    callLog.length = 0;

    expect(host.adapter.propertyInspectorDidAppearListeners).toHaveLength(1);
    host.adapter.propertyInspectorDidAppearListeners[0]();

    expect(callLog).toContain("getAudio().getAudioDevices");
    expect(calls).toEqual(["raceEngineerVoices", "driverNames", "packList"]);
    expect(callLog).toContain("createVoicePackInstaller().republishStatus");
  });

  it("flushes both stores on the way out", () => {
    boot();
    const added = process.listeners("exit").filter((l) => !exitListenersBefore.has(l));
    callLog.length = 0;

    expect(added).toHaveLength(2);

    for (const listener of added) (listener as () => void)();

    expect(callLog).toEqual(["createFileSettingsStore().flushSync", "initializeReplaySessionStore().flushSync"]);
  });

  it("builds its loggers under today's scopes", () => {
    const { host } = boot();

    // The voice-pack phase's two come first; the rest are this phase's, in order.
    expect(host.adapter.scopes.slice(host.adapter.scopes.indexOf("VoicePackCatalog") + 1)).toEqual([
      "VersionCheck",
      "SettingsStore",
      "ReplaySessionStore",
      "SettingsWindow",
      "CpuProfile",
      "UpdateCheck",
    ]);
  });

  it("asks the catalog on the way to opening the window (#1100)", () => {
    const { settings } = boot();
    callLog.length = 0;

    void settings.openSettingsWindow();

    const refresh = callLog.indexOf("createVoicePackInstaller().refreshCatalog");
    const open = callLog.indexOf("createSettingsWindowController().open");
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeLessThan(open);
  });
});
