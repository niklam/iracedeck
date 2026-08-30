/**
 * No-limiter scenario predicates, and the property that matters
 * most about the two-family split (issue #1051).
 *
 * The families are meant to partition the field: a car either has a pit limiter
 * or it does not, and exactly one family should speak to it. The tests below
 * pin that as mutual exclusivity plus joint exhaustiveness over KNOWN telemetry,
 * with both families silent when telemetry is unknown — which is the case a
 * bare `!hasPitLimiter(t)` would have got wrong, loudly.
 */
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import type { Scenario } from "../../dsl.js";
import { lacksPitLimiter, NO_LIMITER_ENTRY, NO_LIMITER_SPEEDING } from "./no-limiter.js";
import { LIMITER_SPEEDING } from "./pit-limiter.js";

const WITH_LIMITER: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false };
const NO_LIMITER: Partial<TelemetryData> = {};

function envelope(event: string, telemetry: Partial<TelemetryData> | null): SimEventOf<SimEventName> {
  return { event, timestamp: 0, telemetry, data: {} } as unknown as SimEventOf<SimEventName>;
}

function fires(scenario: Scenario, env: SimEventOf<SimEventName>): boolean {
  const where = scenario.when?.where;

  if (!where) throw new Error(`${scenario.id} is expected to have a where predicate`);

  return where(env);
}

describe("lacksPitLimiter — the negated gate is not a bare negation", () => {
  it("is false for null telemetry, so the family stays silent when it cannot see the car", () => {
    // The regression this exists for: `hasPitLimiter(null)` is false, so a bare
    // `!hasPitLimiter(t)` would return TRUE here and fire the no-limiter
    // callouts on unknown data — including for cars that DO have a limiter.
    expect(lacksPitLimiter(null)).toBe(false);
  });

  it("is true only when telemetry is present and the capability field is absent", () => {
    expect(lacksPitLimiter(NO_LIMITER as TelemetryData)).toBe(true);
  });

  it("is false when the car has a limiter, whatever the field's value", () => {
    expect(lacksPitLimiter({ dcPitSpeedLimiterToggle: false } as TelemetryData)).toBe(false);
    expect(lacksPitLimiter({ dcPitSpeedLimiterToggle: true } as TelemetryData)).toBe(false);
  });
});

describe("no-limiter where: predicates", () => {
  for (const [name, scenario, event] of [
    ["NO_LIMITER_SPEEDING", NO_LIMITER_SPEEDING, "limiter.speeding"],
    ["NO_LIMITER_ENTRY", NO_LIMITER_ENTRY, "pitLane.entered"],
  ] as const) {
    describe(name, () => {
      it("fires on a car with no pit limiter", () => {
        expect(fires(scenario, envelope(event, NO_LIMITER))).toBe(true);
      });

      it("does NOT fire on a limiter-equipped car — that is the other family's line", () => {
        expect(fires(scenario, envelope(event, WITH_LIMITER))).toBe(false);
      });

      it("does NOT fire on unknown telemetry", () => {
        expect(fires(scenario, envelope(event, null))).toBe(false);
      });
    });
  }
});

describe("the two families partition the field (issue #1051)", () => {
  const speeding = (telemetry: Partial<TelemetryData> | null): boolean[] => [
    fires(LIMITER_SPEEDING, envelope("limiter.speeding", telemetry)),
    fires(NO_LIMITER_SPEEDING, envelope("limiter.speeding", telemetry)),
  ];

  it("speaks exactly once to a car that has a limiter", () => {
    expect(speeding(WITH_LIMITER)).toEqual([true, false]);
  });

  it("speaks exactly once to a car that has none — the driver who most needs telling", () => {
    expect(speeding(NO_LIMITER)).toEqual([false, true]);
  });

  it("stays silent on both when telemetry is unknown, rather than guessing", () => {
    expect(speeding(null)).toEqual([false, false]);
  });
});
