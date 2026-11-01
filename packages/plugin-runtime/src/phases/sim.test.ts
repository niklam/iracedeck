import { PROFILE_SWITCH_SESSION_KINDS } from "@iracedeck/app-constants";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
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

describe("initSim", () => {
  beforeEach(() => resetRecorder());
  afterAll(() => cleanupTempBinDirs());

  it("builds the translator's options, constructs the translator, feeds live positions through core.controller, then hands out the runtime and the host's sim", () => {
    const host = createHost();
    const core = initCore(host);
    callLog.length = 0;
    host.adapter.scopes.length = 0;

    initSim(core);

    // Unfiltered but for the settings reads: a bare "getController" here would
    // mean the phase went back to the singleton instead of core.controller.
    // Building the host's sim calls nothing: each member calls through when used.
    expect(callLog.filter((n) => n !== "getGlobalSettings")).toEqual([
      "createIracingTranslatorOptions",
      "initializeSimEventsIracing",
      "getController().setLivePositionsProvider",
      "createIracingSimRuntime",
    ]);
    expect(host.adapter.scopes).toEqual(["SimEventsIracing"]);
  });

  it("returns the runtime createIracingSimRuntime built", () => {
    const runtime = { isRaceFinished: () => false };
    implement("createIracingSimRuntime", () => runtime);

    expect(initSim(initCore(createHost())).runtime).toBe(runtime);
  });

  describe("the host's sim (#1500)", () => {
    it("reads the session kind and the raw session type from the translator", () => {
      implement("getSessionKind", () => "qualifying");
      implement("getSessionType", () => "Lone Qualify");
      const { host } = initSim(initCore(createHost()));
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
      const { host } = initSim(initCore(createHost()));
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
      const { host } = initSim(initCore(createHost()));
      callLog.length = 0;
      const listener = (): void => undefined;

      expect(host.onSimTerminated(listener)).toBe(unsubscribe);
      expect(registered).toEqual([listener]);
      expect(callLog).toEqual(["onIRacingTerminated"]);
    });
  });

  it("hands the translator the options the Race Engineer's wiring built, untouched (#1378)", () => {
    const options = { getFuelLapsLeftMarginLaps: () => 0.5 };
    implement("createIracingTranslatorOptions", () => options);
    const seen: unknown[][] = [];
    implement("initializeSimEventsIracing", (...args) => seen.push(args));

    const core = initCore(createHost());
    initSim(core);

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(core.bus);
    expect(seen[0][1]).toBe(core.controller);
    expect(seen[0][3]).toBe(options);
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
