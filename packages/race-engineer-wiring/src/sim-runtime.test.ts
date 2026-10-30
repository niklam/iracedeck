import * as translator from "@iracedeck/sim-events-iracing";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createIracingSimRuntime, type SimRuntime } from "./sim-runtime.js";

/**
 * Each declared member against the translator getter that implements it.
 * The interface is declared by hand (#1378), so this is what keeps a getter
 * whose signature moves from drifting away from the declaration unnoticed.
 */
const IMPLEMENTED_BY: { readonly [K in keyof SimRuntime]: keyof typeof translator } = {
  getCautionEpisode: "getCautionEpisode",
  getCautionGap: "getCautionGap",
  getCautionPhase: "getCautionPhase",
  getDriverSetupName: "getDriverSetupName",
  getLatestTelemetry: "getLatestTelemetry",
  getLiveCarPosition: "getLiveCarPosition",
  getLiveGaps: "getLiveGaps",
  getLivePosition: "getLivePosition",
  getNearestCarGapMeters: "getNearestCarGapMeters",
  getOvertakeTelemetryGate: "getOvertakeTelemetryGate",
  getPaceLineup: "getPaceLineup",
  getQualifyingInvalidationSnapshot: "getQualifyingInvalidationSnapshot",
  getRaceStartConditions: "getRaceStartConditions",
  getReadbackSnapshot: "getReadbackSnapshot",
  getRollingStartFormation: "getRollingStartFormation",
  getSessionStartConditions: "getSessionStartConditions",
  getSessionType: "getSessionType",
  getTrackDirection: "getTrackDirection",
  isDamageRepairNeeded: "isDamageRepairNeeded",
  isPitActionsAllowed: "isPitActionsAllowed",
  isRaceFinished: "isRaceFinished",
  isStandingStart: "getStandingStart",
  isUnderFullCourseCaution: "isUnderFullCourseCaution",
};

describe("createIracingSimRuntime", () => {
  it("hands out the translator's own query functions, unwrapped, one per declared member", () => {
    const sim = createIracingSimRuntime();

    expect(Object.keys(sim).sort()).toEqual(Object.keys(IMPLEMENTED_BY).sort());

    for (const [name, implementedBy] of Object.entries(IMPLEMENTED_BY)) {
      expect(sim[name as keyof SimRuntime], name).toBe(translator[implementedBy]);
    }

    expect(Object.keys(sim)).toHaveLength(23);
  });

  it("pins each iRacing getter to the declared signature of the member it implements (type test)", () => {
    // `toEqualTypeOf` in both directions: a getter returning a narrower type
    // than the declaration, or the declaration drifting wider than the
    // getter, both fail `pnpm typecheck` here.
    expectTypeOf(translator.getCautionEpisode).toEqualTypeOf<SimRuntime["getCautionEpisode"]>();
    expectTypeOf(translator.getCautionGap).toEqualTypeOf<SimRuntime["getCautionGap"]>();
    expectTypeOf(translator.getCautionPhase).toEqualTypeOf<SimRuntime["getCautionPhase"]>();
    expectTypeOf(translator.getDriverSetupName).toEqualTypeOf<SimRuntime["getDriverSetupName"]>();
    expectTypeOf(translator.getLatestTelemetry).toEqualTypeOf<SimRuntime["getLatestTelemetry"]>();
    expectTypeOf(translator.getLiveCarPosition).toEqualTypeOf<SimRuntime["getLiveCarPosition"]>();
    expectTypeOf(translator.getLiveGaps).toEqualTypeOf<SimRuntime["getLiveGaps"]>();
    expectTypeOf(translator.getLivePosition).toEqualTypeOf<SimRuntime["getLivePosition"]>();
    expectTypeOf(translator.getNearestCarGapMeters).toEqualTypeOf<SimRuntime["getNearestCarGapMeters"]>();
    expectTypeOf(translator.getOvertakeTelemetryGate).toEqualTypeOf<SimRuntime["getOvertakeTelemetryGate"]>();
    expectTypeOf(translator.getPaceLineup).toEqualTypeOf<SimRuntime["getPaceLineup"]>();
    expectTypeOf(translator.getQualifyingInvalidationSnapshot).toEqualTypeOf<
      SimRuntime["getQualifyingInvalidationSnapshot"]
    >();
    expectTypeOf(translator.getRaceStartConditions).toEqualTypeOf<SimRuntime["getRaceStartConditions"]>();
    expectTypeOf(translator.getReadbackSnapshot).toEqualTypeOf<SimRuntime["getReadbackSnapshot"]>();
    expectTypeOf(translator.getRollingStartFormation).toEqualTypeOf<SimRuntime["getRollingStartFormation"]>();
    expectTypeOf(translator.getSessionStartConditions).toEqualTypeOf<SimRuntime["getSessionStartConditions"]>();
    expectTypeOf(translator.getSessionType).toEqualTypeOf<SimRuntime["getSessionType"]>();
    expectTypeOf(translator.getTrackDirection).toEqualTypeOf<SimRuntime["getTrackDirection"]>();
    expectTypeOf(translator.isDamageRepairNeeded).toEqualTypeOf<SimRuntime["isDamageRepairNeeded"]>();
    expectTypeOf(translator.isPitActionsAllowed).toEqualTypeOf<SimRuntime["isPitActionsAllowed"]>();
    expectTypeOf(translator.isRaceFinished).toEqualTypeOf<SimRuntime["isRaceFinished"]>();
    expectTypeOf(translator.getStandingStart).toEqualTypeOf<SimRuntime["isStandingStart"]>();
    expectTypeOf(translator.isUnderFullCourseCaution).toEqualTypeOf<SimRuntime["isUnderFullCourseCaution"]>();
  });

  it("answers the no-translator values for the four reads added in #1378 before the translator is initialised", () => {
    translator._resetSimEventsIracing();
    const sim = createIracingSimRuntime();

    expect(sim.getLatestTelemetry()).toBeNull();
    expect(sim.getSessionType()).toBe("");
    expect(sim.isStandingStart()).toBe(false);
    expect(sim.isDamageRepairNeeded()).toBeNull();
  });
});
