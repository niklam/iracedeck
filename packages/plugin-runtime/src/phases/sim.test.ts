import {
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
} from "@iracedeck/audio-scenarios/pit-crew";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initCore } from "./core.js";
import { initSim } from "./sim.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
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

  it("constructs the translator, feeds live positions, then hands out the runtime", () => {
    const core = initCore(createHost());
    callLog.length = 0;

    initSim(core);

    expect(
      callLog.filter((n) => !n.startsWith("getController") || n.includes(".")).filter((n) => n !== "getGlobalSettings"),
    ).toEqual([
      "initializeSimEventsIracing",
      "getController().setLivePositionsProvider",
      "createIracingSimRuntime",
    ]);
  });

  it("returns the runtime createIracingSimRuntime built", () => {
    const runtime = { isRaceFinished: () => false };
    implement("createIracingSimRuntime", () => runtime);

    expect(initSim(initCore(createHost()))).toBe(runtime);
  });

  it("reads each translator option live through its sanitizer, and the opponent-flag opt-ins by callout key", () => {
    const optionsSeen: Record<string, (...args: unknown[]) => unknown>[] = [];
    implement("initializeSimEventsIracing", (_bus, _controller, _logger, options) =>
      optionsSeen.push(options as never),
    );
    const flag = Object.keys(OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID)[0];
    const key = OPPONENT_FLAG_CALLOUT_SETTING_KEYS[OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID[flag as never]];
    let settings: Record<string, unknown> = {};
    implement("getGlobalSettings", () => settings);

    initSim(initCore(createHost()));
    const options = optionsSeen[0];

    expect(Object.keys(options).sort()).toEqual([
      "getCornerCalloutLeadSeconds",
      "getFuelLapsLeftMarginLaps",
      "getGapAlertThresholdSeconds",
      "getGapMinChangeSeconds",
      "getOpponentFlagCalloutEnabled",
      "getOpponentFlagRangeSeconds",
    ]);
    expect(options.getOpponentFlagCalloutEnabled(flag)).toBe(true);
    settings = { [key]: false };
    expect(options.getOpponentFlagCalloutEnabled(flag)).toBe(false);
  });
});
