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

  it("builds the translator's options, constructs the translator, feeds live positions through core.controller, then hands out the runtime", () => {
    const host = createHost();
    const core = initCore(host);
    callLog.length = 0;
    host.adapter.scopes.length = 0;

    initSim(core);

    // Unfiltered but for the settings reads: a bare "getController" here would
    // mean the phase went back to the singleton instead of core.controller.
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

    expect(initSim(initCore(createHost()))).toBe(runtime);
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
