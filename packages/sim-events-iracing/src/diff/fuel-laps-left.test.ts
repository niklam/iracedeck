/**
 * Unit tests for `diffFuelLapsLeft` (issue #838) — the mid-lap
 * laps-of-fuel-left crossing detector. The estimator and margin are stubbed
 * so every rule is exercised in isolation:
 *
 *   - silent seeding, rising-0.5-crossing sampling, once-per-lap guard
 *   - count math (raw − margin − remaining lap fraction, floored, clamped)
 *   - descending crossings only, once per stint, no stale burst
 *   - the 10-count ceiling and the count-0 box call
 *   - refuel re-arm (debounced) and jitter immunity
 *   - race / live-in-car / missing-stats / invalid-telemetry gates
 *   - race-coverage suppression (issue #866): the lap-limited remaining-laps
 *     comparison, the white-flag last-lap latch, and the post-race gate
 *   - margin sanitization (`sanitizeFuelCalloutMarginLaps`)
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffFuelLapsLeft,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_LAPS_LEFT_MAX_COUNT,
  sanitizeFuelCalloutMarginLaps,
} from "./fuel-laps-left.js";
import type { FuelStats } from "./fuel-laps.js";
import type { PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    Lap: 5,
    LapDistPct: 0.4,
    FuelLevel: 20,
    ...overrides,
  } as TelemetryData;
}

type RunOptions = {
  race?: boolean;
  avg?: number | null;
  margin?: number;
};

function makeRunner(events: PendingEvent[], state: TranslatorState = createInitialState()) {
  return {
    state,
    run(t: TelemetryData, { race = true, avg = 2, margin = FUEL_CALLOUT_DEFAULT_MARGIN_LAPS }: RunOptions = {}) {
      const stats: FuelStats =
        avg === null ? { lastLap: null, avg: null, samples: 0 } : { lastLap: avg, avg, samples: 5 };
      diffFuelLapsLeft(
        state,
        t,
        race,
        () => stats,
        () => margin,
        (e) => events.push(e),
      );
    },
  };
}

function counts(events: PendingEvent[]): number[] {
  return events.map((e) => (e.data as { count: number }).count);
}

function lapSample(
  run: ReturnType<typeof makeRunner>["run"],
  lap: number,
  fuel: number,
  options?: RunOptions,
  extra: Partial<TelemetryData> = {},
): void {
  run(tick({ Lap: lap, LapDistPct: 0.45, FuelLevel: fuel + 0.02, ...extra }), options);
  run(tick({ Lap: lap, LapDistPct: 0.55, FuelLevel: fuel, ...extra }), options);
  run(tick({ Lap: lap, LapDistPct: 0.95, FuelLevel: fuel - 0.02, ...extra }), options);
  run(tick({ Lap: lap + 1, LapDistPct: 0.05, FuelLevel: fuel - 0.04, ...extra }), options);
}

describe("diffFuelLapsLeft — sampling", () => {
  it("seeds silently on the first valid tick, even past the mid-lap mark", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.6, FuelLevel: 3 }));

    expect(events).toEqual([]);
  });

  it("emits on the rising 0.5 crossing with the issue's worked example (3.05 raw → count 2)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // raw = 6.1 / 2 = 3.05; effective = 2.75; at 50% lap distance:
    // floor(3.05 − 0.3 − 0.5) = 2.
    run(tick({ LapDistPct: 0.45, FuelLevel: 6.12 }));
    run(tick({ LapDistPct: 0.5, FuelLevel: 6.1 }));

    expect(counts(events)).toEqual([2]);
    expect((events[0]!.data as { lapsLeft: number }).lapsLeft).toBeCloseTo(2.75);
  });

  it("does not sample without a crossing, and only once per lap on a back-and-forth wobble", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.1, FuelLevel: 6.2 }));
    run(tick({ LapDistPct: 0.3, FuelLevel: 6.15 }));
    expect(events).toEqual([]);

    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }));
    expect(counts(events)).toEqual([2]); // floor(3.05 − 0.3 − 0.45) = floor(2.3)

    // Roll back below the mark and cross again on the same lap — no re-sample.
    run(tick({ LapDistPct: 0.45, FuelLevel: 6.0 }));
    run(tick({ LapDistPct: 0.55, FuelLevel: 5.9 }));
    expect(events).toHaveLength(1);
  });

  it("samples again on the next lap", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ Lap: 5, LapDistPct: 0.45, FuelLevel: 6.2 }));
    run(tick({ Lap: 5, LapDistPct: 0.55, FuelLevel: 6.1 }));
    run(tick({ Lap: 5, LapDistPct: 0.95, FuelLevel: 5.5 }));
    run(tick({ Lap: 6, LapDistPct: 0.05, FuelLevel: 5.4 }));
    run(tick({ Lap: 6, LapDistPct: 0.55, FuelLevel: 4.1 }));

    // Lap 5: floor(6.1/2 − 0.3 − 0.45) = 2. Lap 6: floor(4.1/2 − 0.3 − 0.45) = 1.
    expect(counts(events)).toEqual([2, 1]);
  });
});

describe("diffFuelLapsLeft — announcement rules", () => {
  it("never re-announces a higher or equal count (fuel saving raises the estimate)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 8.1); // floor(8.1/2 − 0.75) = 3
    expect(counts(events)).toEqual([3]);

    // Fuel saving: consumption (avg) drops, so the estimate RISES to count 4
    // even though the tank keeps draining — no re-announcement of 4.
    lapSample(run, 6, 7.6, { avg: 1.5 }); // floor(7.6/1.5 − 0.75) = 4 → silent
    lapSample(run, 7, 7.0, { avg: 1.75 }); // floor(7.0/1.75 − 0.75) = 3 — already spoken → silent
    expect(counts(events)).toEqual([3]);

    lapSample(run, 8, 5.4, { avg: 1.75 }); // floor(5.4/1.75 − 0.75) = 2 → new descending crossing
    expect(counts(events)).toEqual([3, 2]);
  });

  it("speaks only the current count when the estimate drops several counts between samples", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 12.1); // floor(6.05 − 0.75) = 5
    lapSample(run, 6, 6.1); // floor(3.05 − 0.75) = 2 — skips 4 and 3
    expect(counts(events)).toEqual([5, 2]);
  });

  it("stays silent above the 10-count ceiling without consuming the stint's floor", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 40); // raw 20 → count 19 → silent
    expect(events).toEqual([]);

    lapSample(run, 6, 22.6); // floor(11.3 − 0.75) = 10 → first announcement
    expect(counts(events)).toEqual([FUEL_LAPS_LEFT_MAX_COUNT]);
  });

  it("clamps a below-zero effective estimate to the count-0 box call", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6); // raw 0.3 → effective 0 → floor(−0.45) = −1 → 0
    expect(counts(events)).toEqual([0]);
  });

  it("re-arms every count after a refuel; tiny jitter does not re-arm", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 6.1); // count 2
    expect(counts(events)).toEqual([2]);

    // +0.005 L jitter — below the debounce floor, stays armed as spoken.
    run(tick({ Lap: 6, LapDistPct: 0.2, FuelLevel: 6.065 }));
    lapSample(run, 6, 6.02); // count 2 again — still suppressed
    expect(counts(events)).toEqual([2]);

    // A real refuel (+10 L in one tick) re-arms the stint.
    run(tick({ Lap: 7, LapDistPct: 0.2, FuelLevel: 16 }));
    lapSample(run, 7, 6.1); // count 2 speaks again for the new stint
    expect(counts(events)).toEqual([2, 2]);
  });

  it("reads the margin live at every sample", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 6.1, { margin: 0 }); // floor(3.05 − 0.45) = 2
    lapSample(run, 6, 6.0, { margin: 1.5 }); // floor(3.0 − 1.5 − 0.45) = 1
    expect(counts(events)).toEqual([2, 1]);
  });
});

describe("diffFuelLapsLeft — gates", () => {
  it("is silent outside race sessions", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }), { race: false });
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }), { race: false });

    expect(events).toEqual([]);
  });

  it("is silent when the driver is not live in the car", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2, IsOnTrack: false }));
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1, IsOnTrack: false }));

    expect(events).toEqual([]);
  });

  it("is silent until the estimator has valid samples", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }), { avg: null });
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }), { avg: null });

    expect(events).toEqual([]);
  });

  it("skips invalid telemetry ticks entirely", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }));
    run(tick({ LapDistPct: 0.55, FuelLevel: NaN }));
    run(tick({ LapDistPct: 0.55, FuelLevel: -1 }));
    run(tick({ LapDistPct: NaN, FuelLevel: 6.1 }));
    run(tick({ Lap: -1, LapDistPct: 0.55, FuelLevel: 6.1 }));

    expect(events).toEqual([]);
  });
});

describe("diffFuelLapsLeft — race-coverage suppression (issue #866)", () => {
  it("suppresses the box call on the final lap of a lap-limited race", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // SessionLapsRemainEx 1 → 0 full laps needed after the current one; even
    // the count-0 box call is noise when the race ends with this lap.
    lapSample(run, 5, 0.6, {}, { SessionLapsRemainEx: 1 });

    expect(events).toEqual([]);
  });

  it("suppresses a count that covers the remaining race laps", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 3 laps remain including the current one → 2 full laps needed after it;
    // count 2 covers exactly → silent.
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 3 });

    expect(events).toEqual([]);
  });

  it("still announces when the estimate falls short of the remaining laps", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 4 laps remain including the current one → 3 needed; count 2 falls short.
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 4 });

    expect(counts(events)).toEqual([2]);
  });

  it("keeps announcing when laps remaining is unknown (timed sentinel, invalid reading)", () => {
    // Timed race: the 32767 unlimited sentinel is not a lap count.
    const sentinelEvents: PendingEvent[] = [];
    const sentinel = makeRunner(sentinelEvents);
    lapSample(sentinel.run, 5, 6.1, {}, { SessionLapsRemainEx: 32767 });
    expect(counts(sentinelEvents)).toEqual([2]);

    // A negative reading is invalid, not a coverage determination.
    const invalidEvents: PendingEvent[] = [];
    const invalid = makeRunner(invalidEvents);
    lapSample(invalid.run, 5, 0.6, {}, { SessionLapsRemainEx: -1 });
    expect(counts(invalidEvents)).toEqual([0]);
  });

  it("suppresses the family on the player's own final lap (white-flag crossing latch)", () => {
    const events: PendingEvent[] = [];
    const runner = makeRunner(events);
    runner.state.whiteLastLapFired = true;

    // Timed race (no usable lap counter) — the #772 latch is the only signal.
    lapSample(runner.run, 5, 0.6, {}, { SessionLapsRemainEx: 32767 });

    expect(events).toEqual([]);
  });

  it("goes silent post-race (checkered / cool-down)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6, {}, { SessionState: SessionState.Checkered });
    lapSample(run, 6, 0.5, {}, { SessionState: SessionState.CoolDown });

    expect(events).toEqual([]);
  });

  it("does not suppress while racing", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6, {}, { SessionState: SessionState.Racing });

    expect(counts(events)).toEqual([0]);
  });

  it("leaves the dedup floor untouched on suppression so a later drop still announces", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Count 2 covers the 2 laps needed → suppressed, floor NOT advanced.
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 3 });
    expect(events).toEqual([]);

    // Next lap the counter reading is unavailable — coverage is unknown, so
    // the same count 2 must still announce (an advanced floor would eat it).
    lapSample(run, 6, 5.9);
    expect(counts(events)).toEqual([2]);
  });
});

describe("sanitizeFuelCalloutMarginLaps", () => {
  it("passes valid values through and parses numeric strings", () => {
    expect(sanitizeFuelCalloutMarginLaps(0)).toBe(0);
    expect(sanitizeFuelCalloutMarginLaps(0.7)).toBe(0.7);
    expect(sanitizeFuelCalloutMarginLaps("1.5")).toBe(1.5);
  });

  it("falls back to the default on missing or malformed values", () => {
    expect(sanitizeFuelCalloutMarginLaps(undefined)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps(null)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps("")).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps("abc")).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps(NaN)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
  });

  it("clamps to the slider bounds", () => {
    expect(sanitizeFuelCalloutMarginLaps(-1)).toBe(0);
    expect(sanitizeFuelCalloutMarginLaps(99)).toBe(3);
  });
});
