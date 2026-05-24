/**
 * Unit tests for the pit-box count-in diff (issue #600).
 *
 * Pins true threshold-crossing semantics:
 *   - fires each mark once as the car crosses its threshold from above
 *     (five 120 m → pit-now 20 m)
 *   - no repeat while the car stays within one band
 *   - entering pit road already inside a band only speaks marks still AHEAD —
 *     a just-passed threshold is seeded as spoken on entry and never fires
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
  it("counts five → pit-now as the car crosses each threshold, one mark per band", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Enter above the first mark (125 m) so every threshold is crossed from
    // above, then descend through each band.
    for (const remaining of [125, 115, 95, 75, 55, 35, 15]) {
      diffPitBoxCountdown(state, tick(pctForRemaining(remaining)), BOX_PCT, TRACK_LENGTH, emit);
    }

    expect(marks(events)).toEqual(["five", "four", "three", "two", "one", "pit-now"]);
  });

  it("does not repeat a mark while the car stays within its band", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(125)), BOX_PCT, TRACK_LENGTH, emit); // entry, above all marks
    diffPitBoxCountdown(state, tick(pctForRemaining(118)), BOX_PCT, TRACK_LENGTH, emit); // crossed 120 → five
    diffPitBoxCountdown(state, tick(pctForRemaining(112)), BOX_PCT, TRACK_LENGTH, emit); // still five band
    diffPitBoxCountdown(state, tick(pctForRemaining(105)), BOX_PCT, TRACK_LENGTH, emit); // still five band

    expect(marks(events)).toEqual(["five"]);
  });

  it("fires pit-now when crossing the 20 m threshold", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(25)), BOX_PCT, TRACK_LENGTH, emit); // entry above pit-now
    diffPitBoxCountdown(state, tick(pctForRemaining(20)), BOX_PCT, TRACK_LENGTH, emit); // crosses 20

    expect(marks(events)).toEqual(["pit-now"]);
  });
});

describe("diffPitBoxCountdown — entering within range (threshold-crossing)", () => {
  it("does not speak a just-passed mark on entry — joining at 70 m starts at 'two', not 'three'", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // First tick at 70 m — already past the 80 m ('three') mark. CodeRabbit's
    // example: 'three' must NOT fire; the count starts at the next mark ahead.
    diffPitBoxCountdown(state, tick(pctForRemaining(70)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(50)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(30)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(10)), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toEqual(["two", "one", "pit-now"]);
    expect(marks(events)).not.toContain("three");
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

    for (const remaining of [50, 30, 10]) {
      diffPitBoxCountdown(state, tick(pctForRemaining(remaining)), BOX_PCT, TRACK_LENGTH, emit);
    }

    const beforePass = marks(events).length;

    // Now just past the box: lapDistPct slightly beyond BOX_PCT — remaining
    // distance folds to ~1000 m, no band matches.
    diffPitBoxCountdown(state, tick(BOX_PCT + 0.01), BOX_PCT, TRACK_LENGTH, emit);

    expect(marks(events)).toContain("pit-now");
    expect(marks(events).length).toBe(beforePass);
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

    // First visit: full count-in (entry above the first mark).
    for (const remaining of [125, 115, 95, 75, 55, 35, 15]) {
      diffPitBoxCountdown(state, tick(pctForRemaining(remaining)), BOX_PCT, TRACK_LENGTH, emit);
    }

    // Leave pit road — resets the spoken set and the entry-seeded flag.
    diffPitBoxCountdown(state, tick(0.5, { onPitRoad: false }), BOX_PCT, TRACK_LENGTH, emit);
    const afterFirst = marks(events).length;

    // Second visit: entry above the first mark, then crosses 120 → counts again.
    diffPitBoxCountdown(state, tick(pctForRemaining(125)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(115)), BOX_PCT, TRACK_LENGTH, emit);

    expect(afterFirst).toBe(6);
    expect(marks(events).slice(afterFirst)).toEqual(["five"]);
  });

  it("clears the spoken set and entry-seeded flag when leaving pit road", () => {
    const state = createInitialState();
    const { emit } = collect();

    diffPitBoxCountdown(state, tick(pctForRemaining(125)), BOX_PCT, TRACK_LENGTH, emit);
    diffPitBoxCountdown(state, tick(pctForRemaining(115)), BOX_PCT, TRACK_LENGTH, emit);
    expect(state.pitBoxMarksSpoken.size).toBeGreaterThan(0);
    expect(state.pitBoxEntrySeeded).toBe(true);

    diffPitBoxCountdown(state, tick(0.5, { onPitRoad: false }), BOX_PCT, TRACK_LENGTH, emit);
    expect(state.pitBoxMarksSpoken.size).toBe(0);
    expect(state.pitBoxEntrySeeded).toBe(false);
  });
});
