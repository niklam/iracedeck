/**
 * Pit-limiter scenario `where:` predicates.
 *
 * Two contracts live here.
 *
 * The equipment gate (issue #639): on a car with no pit limiter
 * (`dcPitSpeedLimiterToggle` absent ⇒ `hasPitLimiter` false), none of them fire.
 * Since #1051 that is not merely suppression — the no-limiter car gets its own
 * family instead, so the complementary half of this contract lives in
 * `no-limiter.test.ts`, which asserts the two partition the field rather than
 * leaving a gap.
 *
 * The telemetry SOURCE (issue #1051): `LIMITER_ON_TRACK` and `LIMITER_MISSING`
 * are `triggerDelay` scenarios whose predicates read `getLatestTelemetry()`
 * rather than the event envelope, because the interpreter re-runs `where:`
 * after the delay with the ORIGINAL envelope — whose telemetry was captured
 * before the window. So the tests below drive the LIVE snapshot, and hand the
 * envelope a contradicting one wherever the two could be confused: a predicate
 * "simplified" back to `e.telemetry` fails them. The end-to-end half of that
 * contract — publish, flip the live snapshot inside the window, hear nothing —
 * needs the real engine and lives in `register-pit-crew.test.ts`.
 */
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Scenario } from "../../dsl.js";
import { LIMITER_DROPPED, LIMITER_MISSING, LIMITER_ON_TRACK, LIMITER_SPEEDING } from "./pit-limiter.js";

// Live-telemetry feed for the two delayed predicates, mirroring how
// `flag-alerts.test.ts` drives its speak-time `Furled` gate. `null` (the
// default) is "no live signal", which every predicate here must read as "cannot
// see the car" and stay silent on.
const mockLatestTelemetry = vi.fn((): unknown => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getLatestTelemetry: () => mockLatestTelemetry(),
}));

const WITH_LIMITER: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false };
const NO_LIMITER: Partial<TelemetryData> = {};

// Live snapshots for the two delayed scenarios. `hasPitLimiter` tests for the
// PRESENCE of `dcPitSpeedLimiterToggle`, never its value, so all four of these
// are equipped cars.
const ENGAGED_OFF_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: true, OnPitRoad: false };
const DISENGAGED_OFF_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false, OnPitRoad: false };
const ENGAGED_ON_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: true, OnPitRoad: true };
const DISENGAGED_ON_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false, OnPitRoad: true };

function envelope(event: string, data: unknown, telemetry: Partial<TelemetryData> | null): SimEventOf<SimEventName> {
  return { event, timestamp: 0, telemetry, data } as unknown as SimEventOf<SimEventName>;
}

function fires(scenario: Scenario, env: SimEventOf<SimEventName>): boolean {
  const where = scenario.when?.where;

  if (!where) throw new Error(`${scenario.id} is expected to have a where predicate`);

  return where(env);
}

/**
 * Evaluate a delayed predicate against a live snapshot.
 *
 * The envelope deliberately carries a snapshot the predicate must IGNORE:
 * `null` telemetry, which every predicate here treats as "cannot see the car,
 * stay silent". So an `e.telemetry`-reading predicate can only ever return
 * false through this helper, and each `toBe(true)` below is an assertion about
 * the source as much as about the condition.
 */
function firesLive(scenario: Scenario, event: string, live: Partial<TelemetryData> | null): boolean {
  mockLatestTelemetry.mockReturnValue(live);

  return fires(scenario, envelope(event, {}, null));
}

beforeEach(() => {
  mockLatestTelemetry.mockReturnValue(null);
});

describe("pit-limiter where: predicates — no-limiter suppression (issue #639)", () => {
  describe("LIMITER_ON_TRACK (pitLane.exited, delayed)", () => {
    it("fires on a limiter-equipped car still holding the limiter out on track", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", ENGAGED_OFF_PIT_ROAD)).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", { ...NO_LIMITER, OnPitRoad: false })).toBe(false);
    });

    it("does NOT fire once the limiter is disengaged", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", DISENGAGED_OFF_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire while still on pit road (expected behaviour, even with a limiter)", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", ENGAGED_ON_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire when live telemetry is unknown", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", null)).toBe(false);
    });

    // The source assertion stated head-on: the envelope says everything the
    // callout wants to hear, while the live snapshot says the driver has
    // already switched the limiter off. Reading the envelope scolds that driver.
    it("reads the LIVE snapshot, not the envelope's stale one", () => {
      mockLatestTelemetry.mockReturnValue(DISENGAGED_OFF_PIT_ROAD);

      expect(fires(LIMITER_ON_TRACK, envelope("pitLane.exited", {}, ENGAGED_OFF_PIT_ROAD))).toBe(false);
    });
  });

  describe("LIMITER_MISSING (limiter.missing, delayed)", () => {
    it("fires on a limiter-equipped car still on pit road without it engaged", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", DISENGAGED_ON_PIT_ROAD)).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", { ...NO_LIMITER, OnPitRoad: true })).toBe(false);
    });

    it("does NOT fire once the limiter is engaged — the earlier nudge was heeded", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", ENGAGED_ON_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire once the car has left pit road", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", DISENGAGED_OFF_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire when live telemetry is unknown", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", null)).toBe(false);
    });

    // Mirror of the LIMITER_ON_TRACK case above: the envelope still shows the
    // limiter off on pit road, the live snapshot shows it engaged.
    it("reads the LIVE snapshot, not the envelope's stale one", () => {
      mockLatestTelemetry.mockReturnValue(ENGAGED_ON_PIT_ROAD);

      expect(fires(LIMITER_MISSING, envelope("limiter.missing", {}, DISENGAGED_ON_PIT_ROAD))).toBe(false);
    });
  });

  // The two undelayed scenarios, which read the envelope and only the envelope.
  describe.each([
    ["LIMITER_DROPPED", LIMITER_DROPPED, "limiter.dropped"],
    ["LIMITER_SPEEDING", LIMITER_SPEEDING, "limiter.speeding"],
  ] as const)("%s (%s)", (_name, scenario, event) => {
    it("fires on a limiter-equipped car", () => {
      expect(fires(scenario, envelope(event, {}, WITH_LIMITER))).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(fires(scenario, envelope(event, {}, NO_LIMITER))).toBe(false);
    });

    it("does NOT fire when telemetry is null", () => {
      expect(fires(scenario, envelope(event, {}, null))).toBe(false);
    });
  });
});
