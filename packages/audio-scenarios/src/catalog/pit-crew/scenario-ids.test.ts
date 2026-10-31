/**
 * The scenario ids of every family #1378 rebuilt over injected sim reads,
 * pinned to what the catalog exported at `e876631a2`, before the change
 * (dumped once off the built dist). Each of these lists is now derived from
 * a build with no sim wired; a read can never change an id, and this proves
 * the rebuild changed none — nor their order, which is the registration
 * order.
 */
import { describe, expect, it } from "vitest";

import { CAUTION_SCENARIO_IDS } from "./caution.js";
import { DAMAGE_SCENARIO_IDS } from "./damage-alerts.js";
import { FLAG_SCENARIO_IDS } from "./flag-alerts.js";
import { PIT_LIMITER_SCENARIO_IDS } from "./pit-limiter.js";
import {
  PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID,
  PIT_STATUS_REPEAT_SCENARIO_IDS,
  PIT_STATUS_SCENARIO_IDS,
} from "./pit-status.js";
import { RACE_START_SCENARIO_IDS } from "./race-start.js";
import { ROLLING_START_SCENARIO_IDS } from "./rolling-start.js";
import { SESSION_START_SCENARIO_IDS } from "./session-start.js";
import { SPOTTER_SCENARIO_IDS } from "./spotter-engine.js";
import { START_LIGHT_SCENARIO_IDS } from "./start-lights.js";

describe("scenario ids are unchanged by the injected sim reads (issue #1378)", () => {
  it("FLAG_SCENARIO_IDS", () => {
    expect(FLAG_SCENARIO_IDS).toEqual([
      "pit-crew.flag-yellow-local",
      "pit-crew.flag-yellow-full",
      "pit-crew.flag-yellow-cleared",
      "pit-crew.flag-green",
      "pit-crew.flag-blue",
      "pit-crew.flag-white",
      "pit-crew.flag-white-last-lap",
      "pit-crew.flag-white-leader",
      "pit-crew.flag-red",
      "pit-crew.flag-black",
      "pit-crew.flag-checkered",
      "pit-crew.flag-debris",
      "pit-crew.flag-meatball",
      "pit-crew.flag-disqualify",
      "pit-crew.flag-furled",
      "pit-crew.flag-furled-cleared",
      "pit-crew.flag-dq-scoring-invalid",
      "pit-crew.flag-crossed",
      "pit-crew.flag-green-held",
      "pit-crew.flag-ten-to-go",
      "pit-crew.flag-five-to-go",
      "pit-crew.flag-yellow-waving",
      "pit-crew.flag-caution-waving",
    ]);
  });

  it("CAUTION_SCENARIO_IDS", () => {
    expect(CAUTION_SCENARIO_IDS).toEqual([
      "pit-crew.caution-follow",
      "pit-crew.caution-pace-car-out",
      "pit-crew.caution-field-caught",
      "pit-crew.caution-extra-lap",
      "pit-crew.caution-one-to-go",
      "pit-crew.caution-lineup-changed",
      "pit-crew.caution-catch-up",
      "pit-crew.caution-catch-up-reminder",
      "pit-crew.caution-position",
      "pit-crew.caution-pace-car-off",
      "pit-crew.caution-restart",
    ]);
  });

  it("ROLLING_START_SCENARIO_IDS", () => {
    expect(ROLLING_START_SCENARIO_IDS).toEqual([
      "pit-crew.rolling-start-pace-car",
      "pit-crew.flag-one-pace-lap-to-go",
      "pit-crew.rolling-start-lineup-changed",
    ]);
  });

  it("PIT_LIMITER_SCENARIO_IDS", () => {
    expect(PIT_LIMITER_SCENARIO_IDS).toEqual([
      "pit-crew.limiter-on-track",
      "pit-crew.limiter-missing",
      "pit-crew.limiter-dropped",
      "pit-crew.limiter-speeding",
    ]);
  });

  it("PIT_STATUS_SCENARIO_IDS", () => {
    expect(PIT_STATUS_SCENARIO_IDS).toEqual([
      "pit-crew.pit-status-in-progress",
      "pit-crew.pit-status-complete",
      "pit-crew.pit-status-too-far-left",
      "pit-crew.pit-status-too-far-right",
      "pit-crew.pit-status-too-far-forward",
      "pit-crew.pit-status-too-far-back",
      "pit-crew.pit-status-bad-angle",
      "pit-crew.pit-status-cant-fix-that",
    ]);
  });

  it("PIT_STATUS_REPEAT_SCENARIO_IDS", () => {
    expect(PIT_STATUS_REPEAT_SCENARIO_IDS).toEqual([
      "pit-crew.pit-status-too-far-left-repeat",
      "pit-crew.pit-status-too-far-right-repeat",
      "pit-crew.pit-status-too-far-forward-repeat",
      "pit-crew.pit-status-too-far-back-repeat",
      "pit-crew.pit-status-bad-angle-repeat",
    ]);
  });

  it("PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID", () => {
    expect(PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID).toEqual("pit-crew.pit-status-nothing-to-do");
  });

  it("DAMAGE_SCENARIO_IDS", () => {
    expect(DAMAGE_SCENARIO_IDS).toEqual([
      "pit-crew.damage-repair-needed",
    ]);
  });

  it("START_LIGHT_SCENARIO_IDS", () => {
    expect(START_LIGHT_SCENARIO_IDS).toEqual([
      "pit-crew.start-light-ready",
      "pit-crew.start-light-go",
      "pit-crew.start-light-countdown-90",
      "pit-crew.start-light-countdown-60",
      "pit-crew.start-light-countdown-30",
      "pit-crew.start-light-countdown-10",
    ]);
  });

  it("RACE_START_SCENARIO_IDS", () => {
    expect(RACE_START_SCENARIO_IDS).toEqual([
      "pit-crew.race-start",
    ]);
  });

  it("SESSION_START_SCENARIO_IDS", () => {
    expect(SESSION_START_SCENARIO_IDS).toEqual([
      "pit-crew.session-start",
    ]);
  });

  it("SPOTTER_SCENARIO_IDS", () => {
    expect(SPOTTER_SCENARIO_IDS).toEqual([
      "pit-crew.spotter-call",
      "pit-crew.spotter-info",
    ]);
  });
});
