import type { CalloutSettingKey } from "@iracedeck/callout-settings";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initCore } from "./core.js";
import { initSim } from "./sim.js";

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

describe("initSim", () => {
  beforeEach(() => resetRecorder());
  afterAll(() => cleanupTempBinDirs());

  it("constructs the translator, feeds live positions through core.controller, then hands out the runtime", () => {
    const host = createHost();
    const core = initCore(host);
    callLog.length = 0;
    host.adapter.scopes.length = 0;

    initSim(core);

    // Unfiltered but for the settings reads: a bare "getController" here would
    // mean the phase went back to the singleton instead of core.controller.
    expect(callLog.filter((n) => n !== "getGlobalSettings")).toEqual([
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

  it("hands the translator its six live options", () => {
    const optionsSeen: Record<string, (...args: unknown[]) => unknown>[] = [];
    implement("initializeSimEventsIracing", (_bus, _controller, _logger, options) =>
      optionsSeen.push(options as never),
    );

    initSim(initCore(createHost()));

    expect(Object.keys(optionsSeen[0]).sort()).toEqual([
      "getCornerCalloutLeadSeconds",
      "getFuelLapsLeftMarginLaps",
      "getGapAlertThresholdSeconds",
      "getGapMinChangeSeconds",
      "getOpponentFlagCalloutEnabled",
      "getOpponentFlagRangeSeconds",
    ]);
  });

  /**
   * Each bus flag against the settings key that must gate it, written out
   * rather than derived: the meatball arrives as `Repair`, and a mapping that
   * sent it (or any flag) to a sibling's key would silence the wrong callout.
   */
  const FLAG_KEYS: readonly (readonly [OpponentPenaltyFlag, CalloutSettingKey])[] = [
    [OpponentPenaltyFlag.Furled, "calloutEnabledOpponentFlagFurled"],
    [OpponentPenaltyFlag.Black, "calloutEnabledOpponentFlagBlack"],
    [OpponentPenaltyFlag.Repair, "calloutEnabledOpponentFlagMeatball"],
    [OpponentPenaltyFlag.Disqualify, "calloutEnabledOpponentFlagDisqualify"],
  ];

  it("has a row for every opponent penalty flag", () => {
    expect(FLAG_KEYS.map(([flag]) => flag).sort()).toEqual(Object.values(OpponentPenaltyFlag).sort());
  });

  it.each(FLAG_KEYS)("gates the %s opponent flag on %s alone, live", (flag, key) => {
    const optionsSeen: Record<string, (...args: unknown[]) => unknown>[] = [];
    implement("initializeSimEventsIracing", (_bus, _controller, _logger, options) =>
      optionsSeen.push(options as never),
    );
    let off = new Set<unknown>();
    implement("isCalloutEnabled", (asked) => !off.has(asked));

    initSim(initCore(createHost()));
    const gate = optionsSeen[0].getOpponentFlagCalloutEnabled;

    expect(gate(flag), "every key on").toBe(true);
    off = new Set(FLAG_KEYS.map(([, other]) => other).filter((other) => other !== key));
    expect(gate(flag), "every other flag's key off").toBe(true);
    off = new Set([key]);
    expect(gate(flag), "its own key off").toBe(false);
  });

  it("lets a flag the map does not know through without asking any key", () => {
    const optionsSeen: Record<string, (...args: unknown[]) => unknown>[] = [];
    implement("initializeSimEventsIracing", (_bus, _controller, _logger, options) =>
      optionsSeen.push(options as never),
    );
    const asked: unknown[] = [];
    implement("isCalloutEnabled", (key) => {
      asked.push(key);

      return false;
    });

    initSim(initCore(createHost()));

    expect(optionsSeen[0].getOpponentFlagCalloutEnabled("a-flag-added-later")).toBe(true);
    expect(asked).toEqual([]);
  });
});
