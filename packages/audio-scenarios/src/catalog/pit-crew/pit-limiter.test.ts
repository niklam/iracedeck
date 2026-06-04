/**
 * Pit-limiter scenario `where:` predicates (issue #639).
 *
 * These four scenarios are not yet registered in `registerPitCrew`, so the
 * predicates are unit-tested directly here. The key behaviour: on a car with
 * no pit limiter (`dcPitSpeedLimiterToggle` absent ⇒ `hasPitLimiter` false),
 * none of them fire.
 */
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import type { Scenario } from "../../dsl.js";
import { LIMITER_DROPPED, LIMITER_MISSING, LIMITER_ON_TRACK, LIMITER_SPEEDING } from "./pit-limiter.js";

const WITH_LIMITER: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false };
const NO_LIMITER: Partial<TelemetryData> = {};

function envelope(event: string, data: unknown, telemetry: Partial<TelemetryData> | null): SimEventOf<SimEventName> {
  return { event, timestamp: 0, telemetry, data } as unknown as SimEventOf<SimEventName>;
}

function fires(scenario: Scenario, env: SimEventOf<SimEventName>): boolean {
  const where = scenario.when?.where;

  if (!where) throw new Error(`${scenario.id} is expected to have a where predicate`);

  return where(env);
}

describe("pit-limiter where: predicates — no-limiter suppression (issue #639)", () => {
  describe("LIMITER_ON_TRACK (carControl.limiterToggled)", () => {
    it("fires on a limiter-equipped car when toggled on while not on pit road", () => {
      expect(
        fires(
          LIMITER_ON_TRACK,
          envelope("carControl.limiterToggled", { on: true }, { ...WITH_LIMITER, OnPitRoad: false }),
        ),
      ).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(
        fires(
          LIMITER_ON_TRACK,
          envelope("carControl.limiterToggled", { on: true }, { ...NO_LIMITER, OnPitRoad: false }),
        ),
      ).toBe(false);
    });

    it("does NOT fire when the limiter was toggled off (regardless of capability)", () => {
      expect(
        fires(
          LIMITER_ON_TRACK,
          envelope("carControl.limiterToggled", { on: false }, { ...WITH_LIMITER, OnPitRoad: false }),
        ),
      ).toBe(false);
    });

    it("does NOT fire when on pit road (expected behaviour, even with a limiter)", () => {
      expect(
        fires(
          LIMITER_ON_TRACK,
          envelope("carControl.limiterToggled", { on: true }, { ...WITH_LIMITER, OnPitRoad: true }),
        ),
      ).toBe(false);
    });
  });

  describe.each([
    ["LIMITER_MISSING", LIMITER_MISSING, "limiter.missing"],
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
