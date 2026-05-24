/**
 * Unit tests for the pit-box count-in diff (issue #600).
 *
 * Pins:
 *   - fires each distance mark once per pit-road visit as the car closes on
 *     the box (five 120 m → pit-now 20 m)
 *   - no repeat while the car stays within one band
 *   - entering pit road already within range skips the earlier marks
 *   - beyond the first mark (>120 m) or after the box is passed (distance
 *     wraps to ~a full lap) nothing fires
 *   - silent when the box position or track length is unknown
 *   - no fire while parked in the stall (connect-in-stall / arrived)
 *   - leaving pit road resets the spoken set so a second stop counts down again
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffPitBoxCountdown } from "./pit-box-countdown.js";
import type { PendingEvent } from "./types.js";

// 1000 m track keeps the math readable: 1% of the lap = 10 m.
const TRACK_LENGTH = 1000;
// Box at 20% of the lap. remaining = ((BOX - lapDistPct + 1) % 1) * 1000.
const BOX_PCT = 0.2;

/** lapDistPct that leaves `meters` of distance to the box (within the lap). */
function pctForRemaining(meters: number): number {
  return BOX_PCT - meters / TRACK_LENGTH;
}

function tick(lapDistPct: number, opts: { onPitRoad?: boolean; inPitStall?: boolean } = {}): TelemetryData {
  return {
    OnPitRoad: opts.onPitRoad ?? true,
    PlayerCarInPitStall: opts.inPitStall ?? false,
    LapDistPct: lapDistPct,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function marks(events: PendingEvent[]): string[] {
  return events.filter((e) => e.event === "pitBox.countdown").map((e) => (e.data as { mark: string }).mark);
}

describe("diffPitBoxCountdown — normal approach", () => {
  it("counts five → pit-now as the car closes on the box, one mark per band", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Mid-band remaining distances: 110, 90, 70, 50, 30, 10 m.
    for (const remaining of [110, 90, 70, 50, 30, 10]) {
      diffPitBoxCountdown(state, tick(pctForRemaining(remaining)), BOX_PCT, TRACK_LENGTH, emit);
    }

    expect(marks(events)).toEqual(["five", "four", "three", "two", "one", "pit-now"]);
  });

  it("does not repeat a mark while the car stays within its band", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(118)), BOX_PCT, TRACK_LENGTH, emit); // five
    diffPitBoxCountdown(state, tick(pctForRemaining(112)), BOX_PCT, TRACK_LENGTH, emit); // still five band
    diffPitBoxCountdown(state, tick(pctForRemaining(105)), BOX_PCT, TRACK_LENGTH, emit); // still five band

    expect(marks(events)).toEqual(["five"]);
  });

  it("fires pit-now exactly at the 20 m threshold", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(20)), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual(["pit-now"]);
  });
});

describe("diffPitBoxCountdown — entering within range", () => {
  it("skips the earlier marks when the car appears on pit road already close", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // First tick at 50 m — the 'two' band. five/four/three were never observed.
    diffPitBoxCountdown(state, tick(pctForRemaining(50)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(30)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(10)), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual(["two", "one", "pit-now"]);
  });

  it("stays silent beyond the first mark (>120 m to the box)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(200)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(130)), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual([]);
  });
});

describe("diffPitBoxCountdown — box passed", () => {
  it("does not fire once the car is past the box (distance wraps to ~a full lap)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(10)), BOX_PCT, TRACK_LENGTH, emit); // pit-now

    // Now just past the box: lapDistPct slightly beyond BOX_PCT — remaining
    // distance folds to ~1000 m, no band matches.
    diffPitBoxCountdown(state, tick(BOX_PCT + 0.01), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual(["pit-now"]);
  });
});

describe("diffPitBoxCountdown — gating", () => {
  it("stays silent when the box position is unknown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(50)), null, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual([]);
  });

  it("stays silent when the track length is unknown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(50)), BOX_PCT, null, emit);

    expect(marks(events)).toEqual([]);
  });

  it("does not fire when the car is parked in the stall", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Connecting / sitting in the stall: remaining ~0 would otherwise be the
    // pit-now band, but an arrived car needs no count-in.
    diffPitBoxCountdown(state, tick(pctForRemaining(5), { inPitStall: true }), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual([]);
  });

  it("stays silent when not on pit road", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(50), { onPitRoad: false }), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual([]);
  });
});

describe("diffPitBoxCountdown — per-visit reset", () => {
  it("counts down again on a second pit-road visit", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // First visit: full count-in.
    for (const remaining of [110, 90, 70, 50, 30, 10]) {
      diffPitBoxCountdown(state, tick(pctForRemaining(remaining)), BOX_PCT, TRACK_LENGTH, emit);
    }

    // Leave pit road — resets the spoken set.
    diffPitBoxCountdown(state, tick(0.5, { onPitRoad: false }), BOX_PCT, TRACK_LENGTH, emit);
    const afterFirst = marks(events).length;

    // Second visit: counts again from the start.
    diffPitBoxCountdown(state, tick(pctForRemaining(110)), BOX_PCT, TRACK_LENGTH, emit);

    expect(afterFirst).toBe(6);
    expect(marks(events).slice(afterFirst)).toEqual(["five"]);
  });

  it("clears the spoken set when leaving pit road", () => {
    const state = createInitialState();
    const { emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(110)), BOX_PCT, TRACK_LENGTH, emit);
    expect(state.pitBoxMarksSpoken.size).toBeGreaterThan(0);

    diffPitBoxCountdown(state, tick(0.5, { onPitRoad: false }), BOX_PCT, TRACK_LENGTH, emit);
    expect(state.pitBoxMarksSpoken.size).toBe(0);
  });
});
