import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startPlugin } from "./start-plugin.js";
import { cleanupTempBinDirs, createFakeExtension, createHost } from "./test-support/fake-host.js";
import { callLog, describeFirstDifference, implement, resetRecorder } from "./test-support/recorder.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("./test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/event-bus", async (io) => (await import("./test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/sim-events-iracing", async (io) =>
  (await import("./test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-service", async (io) => (await import("./test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-scenarios", async (io) =>
  (await import("./test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) => (await import("./test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-native", async (io) => (await import("./test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/rasterizer", async () => (await import("./test-support/module-mocks.js")).rasterizerMock());
vi.mock("@iracedeck/race-engineer-wiring", async () =>
  (await import("./test-support/module-mocks.js")).raceEngineerWiringMock(),
);
vi.mock("./actions.js", async () => (await import("./test-support/module-mocks.js")).actionsMock());

/**
 * Today's plugin.ts order (309 → 1796), one entry per recorded call. Derived
 * from the Stream Deck file under the default settings state the tests
 * implement (`getGlobalSettings` → `{}`, `pngRasterization` on, as all three
 * `platform-features.json` set it); Mirabox and Ulanzi run the same sequence
 * without the profile switcher and the deck-device listeners, which are what
 * `extension.start` stands for. The Race Engineer subscriptions plugin.ts made
 * between the scenario engine and `setScripts` are `wireRaceEngineer` now.
 */
function expectedOrder(withExtension: boolean): string[] {
  return [
    // 1 initCore
    "initPluginConfig",
    "onGlobalSettingsChange", // debug logging
    "adapter.setLogLevel",
    "startMainThreadWatchdog",
    "startResourceMonitor",
    "onGlobalSettingsChange", // setup-warning validation
    "validateSetupWarningPatterns",
    "initializeSDK",
    "initializeEventBus",
    // 2 initSim
    "initializeSimEventsIracing",
    "getController().setLivePositionsProvider",
    "createIracingSimRuntime",
    // 3 initInput
    "new IRacingNative",
    "initializeKeyboard",
    "initializeClipboard",
    "createSvgRasterizer",
    "initializeRasterizer",
    // 4 initAudio
    "new AudioNative",
    "initializeAudio",
    "getAudio().init",
    "onGlobalSettingsChange", // applyAudioState
    "onGlobalSettingsChange", // syncFeatureGates
    "applyRadarVolume",
    "applyRadarEnabled",
    "applyRaceEngineerAudio",
    // 5 initVoicePacks
    "createVoiceScriptWarningReporter",
    "createVoicePackService",
    "createVoicePackService().refresh",
    "createVoicePackStorage",
    "createVoicePackCatalogService",
    "createVoicePackInstaller",
    "createVoicePackLaunchStep",
    // 6 initRaceEngineer
    "initializeAudioScenarios",
    "wireRaceEngineer",
    "getScenarioEngine().setScripts",
    // 7 initSettings
    "onIRacingTerminated",
    "createFileSettingsStore",
    "initializeReplaySessionStore",
    "initializeEventBus().subscribe", // replay.lapStarted
    "initializeEventBus().subscribe", // replay.lapTimed
    "createSettingsChannelPublisher",
    "initializeCpuProfileCapture",
    "createUpdateCheckService",
    "createSettingsWindowCommandHandler",
    "createSettingsWindowController",
    "onGlobalSettingsChange", // the big listener
    "adapter.onPropertyInspectorDidAppear",
    // 8 registerActions
    "initWindowFocus",
    "initMousePointer",
    "adapter.onKeyDown",
    "adapter.onDialDown",
    "adapter.onDialRotate",
    "adapter.registerAction*",
    // 9 startServices
    "initGlobalSettings",
    "createVoicePackLaunchStep().start",
    "migrateGlobalSettingsKeys",
    "seedBindingDefaultsIfAbsent",
    ...(withExtension ? ["extension.start"] : []),
    "adapter.onOpenSettingsRequest",
    "initializeSimHub",
    "initializeBindingDispatcher",
    "initAppMonitor",
    "getController().subscribe", // elevation check
    "getController().subscribe", // replay session
    // 10
    "adapter.connect",
  ];
}

/** The recorded calls the expectation names, with each run of registrations collapsed to one entry. */
function observed(expected: readonly string[]): string[] {
  const names = new Set(expected.map((name) => (name === "adapter.registerAction*" ? "adapter.registerAction" : name)));

  return callLog
    .filter((name) => names.has(name))
    .map((name) => (name === "adapter.registerAction" ? "adapter.registerAction*" : name))
    .filter((name, i, all) => !(name === "adapter.registerAction*" && all[i - 1] === name));
}

describe("startPlugin (#1349)", () => {
  beforeEach(() => {
    resetRecorder();
    // The default settings branch, set explicitly: an unimplemented stub is truthy (see recorder.ts).
    implement("getGlobalSettings", () => ({}));
    vi.stubGlobal("__FEATURE_PNG_RASTERIZATION__", true);
    // The settings phase registers two exit flushes; keep them off the test worker.
    vi.spyOn(process, "on").mockReturnValue(process);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(() => cleanupTempBinDirs());

  it("runs every startup step in today's order (Stream Deck: with the extension)", () => {
    const host = createHost(createFakeExtension(["sd.switch-profile"]));

    startPlugin(host);

    const expected = expectedOrder(true);
    const actual = observed(expected);
    expect(actual, describeFirstDifference(actual, expected)).toEqual(expected);
    expect(host.adapter.registered).toEqual(["shared.a", "shared.b", "sd.switch-profile"]);
  });

  it("runs the same order without an extension (Mirabox, Ulanzi), registering only the shared list", () => {
    const host = createHost();

    startPlugin(host);

    const expected = expectedOrder(false);
    const actual = observed(expected);
    expect(actual, describeFirstDifference(actual, expected)).toEqual(expected);
    expect(host.adapter.registered).toEqual(["shared.a", "shared.b"]);
    expect(callLog.filter((name) => name.startsWith("extension."))).toEqual([]);
  });

  it("creates the last two phases' loggers under the scopes plugin.ts always used", () => {
    const host = createHost(createFakeExtension(["sd.switch-profile"]));

    startPlugin(host);

    const first = host.adapter.scopes.indexOf("WindowFocus");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(host.adapter.scopes.slice(first)).toEqual([
      // 8 registerActions — the mocked action lists use each UUID as its scope
      "WindowFocus",
      "MousePointer",
      "shared.a",
      "shared.b",
      "sd.switch-profile",
      // 9 startServices
      "GlobalSettings",
      "SettingsMigration",
      "SettingsMigration",
      "SimHub",
      "BindingDispatcher",
      "AppMonitor",
      "Elevation",
      "ReplaySession",
    ]);
  });

  it("focuses iRacing ahead of every key press, dial press and dial rotation", () => {
    const host = createHost();

    startPlugin(host);
    callLog.length = 0;

    for (const listener of [
      ...host.adapter.keyDownListeners,
      ...host.adapter.dialDownListeners,
      ...host.adapter.dialRotateListeners,
    ]) {
      listener();
    }

    expect(callLog).toEqual(["focusIRacingIfEnabled", "focusIRacingIfEnabled", "focusIRacingIfEnabled"]);
  });

  it("hands the window focus, mouse pointer and elevation check the native input layer", () => {
    const focusers: (() => unknown)[] = [];
    const movers: ((x: number, y: number) => unknown)[] = [];
    const statuses: (() => unknown)[] = [];
    implement("initWindowFocus", (_logger, focus) => focusers.push(focus as () => unknown));
    implement("initMousePointer", (_logger, move) => movers.push(move as (x: number, y: number) => unknown));
    implement("createElevationCheckSubscriber", (deps) =>
      statuses.push((deps as { getStatus: () => unknown }).getStatus),
    );

    startPlugin(createHost());
    expect([focusers.length, movers.length, statuses.length]).toEqual([1, 1, 1]);
    callLog.length = 0;

    focusers[0]();
    movers[0](1, 2);
    statuses[0]();

    expect(callLog).toEqual([
      "new IRacingNative().focusIRacingWindow",
      "new IRacingNative().moveMouseToIRacingWindow",
      "new IRacingNative().getElevationStatus",
    ]);
  });

  it("gives initGlobalSettings the settings store and the replay subscriber the replay store", () => {
    const settingsStore = { name: "settings store" };
    const replayStore = { name: "replay store" };
    const globalSettingsArgs: unknown[][] = [];
    const replayDeps: { store: unknown; getSessionInfo: () => unknown }[] = [];
    implement("createFileSettingsStore", () => settingsStore);
    implement("initializeReplaySessionStore", () => replayStore);
    implement("initGlobalSettings", (...args) => globalSettingsArgs.push(args));
    implement("createReplaySessionSubscriber", (deps) => replayDeps.push(deps as (typeof replayDeps)[number]));

    startPlugin(createHost());

    expect(globalSettingsArgs).toHaveLength(1);
    expect(globalSettingsArgs[0][2]).toBe(settingsStore);
    expect(replayDeps).toHaveLength(1);
    expect(replayDeps[0].store).toBe(replayStore);

    callLog.length = 0;
    replayDeps[0].getSessionInfo();
    expect(callLog).toEqual(["getController().getSessionInfo"]);
  });

  it("opens settings without an extension, and refreshes the device list first with one", () => {
    const bare = createHost();
    startPlugin(bare);
    callLog.length = 0;
    expect(() => bare.adapter.openSettingsListeners[0]()).not.toThrow();
    // Positive control: the listener did open the window.
    expect(callLog).toContain("createSettingsWindowController().open");
    expect(callLog.filter((name) => name.startsWith("extension."))).toEqual([]);

    resetRecorder();
    implement("getGlobalSettings", () => ({}));
    const withExtension = createHost(createFakeExtension());
    startPlugin(withExtension);
    callLog.length = 0;
    withExtension.adapter.openSettingsListeners[0]();
    const refresh = callLog.indexOf("extension.refreshDevices");
    const catalog = callLog.indexOf("createVoicePackInstaller().refreshCatalog");
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(catalog).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeLessThan(catalog);
  });

  it("connects last", () => {
    startPlugin(createHost());

    expect(callLog.at(-1)).toBe("adapter.connect");
  });
});
