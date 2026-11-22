import { PROFILE_SWITCH_SESSION_KINDS } from "@iracedeck/app-constants";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import type { TrackData } from "../types.js";
import { initCore } from "./core.js";
import { initSim } from "./sim.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/diagnostics", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
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

/** A track store whose `load` answers `section` and keeps what it was asked. */
function trackData(section: unknown = null): TrackData & { loads: unknown[] } {
  const loads: unknown[] = [];

  return {
    loads,
    directory: "C:/data/Track Data",
    store: {
      directory: "C:/data/Track Data",
      load: (track) => {
        loads.push(track);

        return section as ReturnType<TrackData["store"]["load"]>;
      },
      recordSample: () => true,
      flushSync: () => undefined,
    },
  };
}

describe("initSim", () => {
  beforeEach(() => {
    resetRecorder();
    // The camera catalog registers an exit flush; keep it off the test worker.
    vi.spyOn(process, "on").mockReturnValue(process);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => cleanupTempBinDirs());

  it("builds the translator's options, constructs the translator, feeds live positions through core.controller, starts the camera catalog, then hands out the runtime and the host's sim", () => {
    const host = createHost();
    const core = initCore(host);
    callLog.length = 0;
    host.adapter.scopes.length = 0;

    initSim(core, trackData());

    // Unfiltered but for the settings reads: a bare "getController" here would
    // mean the phase went back to the singleton instead of core.controller.
    // Building the host's sim calls nothing: each member calls through when used.
    expect(callLog.filter((n) => n !== "getGlobalSettings")).toEqual([
      "createIracingTranslatorOptions",
      "initializeSimEventsIracing",
      "getController().setLivePositionsProvider",
      // The camera catalog (#1653): its path beside the settings file, its banner, its load.
      "getPluginPlatform",
      "resolveSettingsStorePath",
      "resolveCameraCatalogPath",
      "createCameraCatalogRejectionReporter",
      "createCameraCatalogService",
      "createCameraCatalogService().start",
      "createIracingSimRuntime",
    ]);
    expect(host.adapter.scopes).toEqual(["SimEventsIracing", "CameraCatalog"]);
  });

  it("builds the camera catalog beside the settings file, with the rejection banner, flushes it on exit and hands it out (#1653)", () => {
    const catalog = { start: vi.fn(() => Promise.resolve()), flushSync: vi.fn() };
    const serviceOptions: Record<string, unknown>[] = [];
    const reporter = (): void => undefined;
    implement("getPluginPlatform", () => "mirabox");
    implement("resolveSettingsStorePath", (options) => {
      expect(options).toEqual({ platform: "mirabox", env: process.env });

      return "C:/data/Settings/Mirabox/global-settings.json";
    });
    implement("resolveCameraCatalogPath", (settingsPath) => `${String(settingsPath)} -> cameras.json`);
    implement("createCameraCatalogRejectionReporter", () => reporter);
    implement("createCameraCatalogService", (options) => {
      serviceOptions.push(options as Record<string, unknown>);

      return catalog;
    });

    const sim = initSim(initCore(createHost()), trackData());

    expect(sim.cameraCatalog).toBe(catalog);
    expect(serviceOptions).toHaveLength(1);
    expect(serviceOptions[0].path).toBe("C:/data/Settings/Mirabox/global-settings.json -> cameras.json");
    expect(serviceOptions[0].onRejected).toBe(reporter);
    expect(catalog.start).toHaveBeenCalledOnce();

    const exitHandlers = vi
      .mocked(process.on)
      .mock.calls.filter(([event]) => event === "exit")
      .map(([, handler]) => handler as () => void);

    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0]();
    expect(catalog.flushSync).toHaveBeenCalledOnce();
  });

  it("returns the runtime createIracingSimRuntime built", () => {
    const runtime = { isRaceFinished: () => false };
    implement("createIracingSimRuntime", () => runtime);

    expect(initSim(initCore(createHost()), trackData()).runtime).toBe(runtime);
  });

  describe("the host's sim (#1500)", () => {
    it("reads the session kind and the raw session type from the translator", () => {
      implement("getSessionKind", () => "qualifying");
      implement("getSessionType", () => "Lone Qualify");
      const { host } = initSim(initCore(createHost()), trackData());
      callLog.length = 0;

      expect(host.getSessionKind()).toBe("qualifying");
      expect(host.getRawSessionType()).toBe("Lone Qualify");
      expect(callLog).toEqual(["getSessionKind", "getSessionType"]);
    });

    it("subscribes a tick listener through the translator's after-tick registry and hands back its unsubscribe", () => {
      const unsubscribe = (): void => undefined;
      const registered: unknown[] = [];
      implement("onTranslatorTick", (listener) => {
        registered.push(listener);

        return unsubscribe;
      });
      const { host } = initSim(initCore(createHost()), trackData());
      callLog.length = 0;
      const listener = (): void => undefined;

      expect(host.onTick(listener)).toBe(unsubscribe);
      expect(registered).toEqual([listener]);
      expect(callLog).toEqual(["onTranslatorTick"]);
    });

    it("subscribes a sim-terminated listener through the app monitor and hands back its unsubscribe", () => {
      const unsubscribe = (): void => undefined;
      const registered: unknown[] = [];
      implement("onIRacingTerminated", (listener) => {
        registered.push(listener);

        return unsubscribe;
      });
      const { host } = initSim(initCore(createHost()), trackData());
      callLog.length = 0;
      const listener = (): void => undefined;

      expect(host.onSimTerminated(listener)).toBe(unsubscribe);
      expect(registered).toEqual([listener]);
      expect(callLog).toEqual(["onIRacingTerminated"]);
    });
  });

  it.each([
    [{ trafficRejoin: true }, true],
    [{ trafficRejoin: false }, false],
    [{}, false],
  ])(
    "hands the translator the build's trafficRejoin flag: %o runs the rejoin detector = %s (#1113)",
    (features, on) => {
      const seen: unknown[][] = [];
      implement("initializeSimEventsIracing", (...args) => seen.push(args));

      initSim({ ...initCore(createHost()), features }, trackData());

      expect((seen[0][3] as Record<string, unknown>).trafficRejoin).toBe(on);
    },
  );

  it("hands the translator the options the Race Engineer's wiring built, untouched (#1378), beside the track store's reader (#1112)", () => {
    const fuelMargin = (): number => 0.5;
    const options = { getFuelLapsLeftMarginLaps: fuelMargin };
    implement("createIracingTranslatorOptions", () => options);
    const seen: unknown[][] = [];
    implement("initializeSimEventsIracing", (...args) => seen.push(args));
    const section = { name: "pit-lane section" };
    const store = trackData(section);

    const core = initCore(createHost());
    initSim(core, store);

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(core.bus);
    expect(seen[0][1]).toBe(core.controller);
    const passed = seen[0][3] as Record<string, unknown>;
    // Every option the wiring built, the same function, and only the loader and the rejoin flag added.
    expect(Object.keys(passed).sort()).toEqual(["getFuelLapsLeftMarginLaps", "loadPitLaneLandmarks", "trafficRejoin"]);
    expect(passed.getFuelLapsLeftMarginLaps).toBe(fuelMargin);
    // A config.json carrying no flags runs no rejoin detector (#1113).
    expect(passed.trafficRejoin).toBe(false);
    // The wiring's own object is not written to: the scenario harness builds the same options.
    expect(Object.keys(options)).toEqual(["getFuelLapsLeftMarginLaps"]);

    // The loader asks the store only when the translator calls it, and answers what the store answers.
    expect(store.loads).toEqual([]);
    const track = {
      sim: "iracing",
      trackId: 7,
      trackName: "t",
      trackConfigName: "c",
      trackLength: "1 km",
      trackLengthM: 1000,
      trackVersion: null,
    };
    expect((passed.loadPitLaneLandmarks as (track: unknown) => unknown)(track)).toBe(section);
    expect(store.loads).toEqual([track]);
  });
});

describe("the session kinds the profile switch maps (#1500)", () => {
  // iRacing's SessionType strings, the classifier's and two it does not know,
  // each in a live session, a saved replay and with no SimMode at all.
  // `phases/sim.ts` checks that the two kind types agree; this checks that the
  // translator's classifier can produce each kind, so one both types gain
  // without a classifier entry fails here.
  const SESSION_TYPES = [
    "Offline Testing",
    "Practice",
    "Lone Practice",
    "Warmup",
    "Open Qualify",
    "Lone Qualify",
    "Race",
    "Heat Race",
    "",
  ];
  const SIM_MODES = ["full", "replay", undefined];

  it("are each produced by the translator's classifier for some input", async () => {
    const { classifySessionKind } = await vi.importActual<typeof import("@iracedeck/sim-events-iracing")>(
      "@iracedeck/sim-events-iracing",
    );
    const produced = new Set(
      SESSION_TYPES.flatMap((type) => SIM_MODES.map((mode) => classifySessionKind(type, mode))).filter(
        (kind) => kind !== null,
      ),
    );

    expect([...produced].sort()).toEqual([...PROFILE_SWITCH_SESSION_KINDS].sort());
  });
});
