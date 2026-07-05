/**
 * Unit tests for the validated per-lap fuel consumption tracker (issue #465).
 *
 * The diff maintains a `FuelLapTracker` — a rolling, validity-flagged history
 * of per-lap fuel consumption — and emits NO bus events. The tracker lives on
 * the translator INSTANCE (not `TranslatorState`) so replay/garage visits and
 * session changes don't destroy it; `computeFuelStats` is the pure accessor
 * the Session Info fuel sub-modes consume via `getFuelStats()`.
 *
 * Pins:
 *   - first tick seeds silently; the first (partial) segment after seeding is
 *     discarded at its crossing so a mid-lap connect never records a partial lap
 *   - a lap crossing requires BOTH the LapDistPct wrap and the Lap counter
 *     increment; either signal alone records nothing
 *   - min-lap-time floor absorbs jitter crossings without recording
 *   - refuel-aware accounting: mid-lap FuelLevel increases are accumulated so
 *     `fuelUsed = lapStartFuel + accumulatedRefuel − fuelLevel` (never negative)
 *   - validity gates: out-lap / in-lap / towed / non-positive fuelUsed
 *   - a session restart (Lap decrease + clock rewind) clears the history; a
 *     backward line crossing or a negative-Lap sentinel tick preserves it
 *   - `resumePartial` re-anchors after a replay/garage gap WITHOUT touching
 *     the history, so garage adjustments never lose the accumulated stats
 *   - `pendingSessionWipe` holds the old stats for display until the driver
 *     is live in the car past the new session's pre-green phase
 *   - history is capped at FUEL_LAP_HISTORY_CAP
 *   - computeFuelStats averages over the last N VALID laps only
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  computeFuelStats,
  createFuelLapTracker,
  diffFuelLaps,
  FUEL_LAP_CROSSING_WINDOW_S,
  FUEL_LAP_HISTORY_CAP,
  FUEL_LAP_MIN_LAP_TIME_S,
  type FuelLap,
  type FuelLapTracker,
} from "./fuel-laps.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    FuelLevel: 50,
    LapDistPct: 0.5,
    Lap: 1,
    SessionTime: 0,
    OnPitRoad: false,
    PlayerCarTowTime: 0,
    IsOnTrack: true,
    ...overrides,
  } as unknown as TelemetryData;
}

/**
 * Seed the tracker and open a clean measured lap starting at `lap` / `time` /
 * `fuel`: the seed tick lands mid-previous-lap, then a crossing discards the
 * partial first segment and resets the segment baseline to the given values.
 */
function prime(t: FuelLapTracker, { lap = 1, time = 100, fuel = 50 } = {}): void {
  diffFuelLaps(t, tick({ Lap: lap - 1, LapDistPct: 0.9, SessionTime: time - 60, FuelLevel: fuel }));
  diffFuelLaps(t, tick({ Lap: lap, LapDistPct: 0.05, SessionTime: time, FuelLevel: fuel }));
}

/**
 * Complete the currently open lap with a two-tick crossing sequence: a
 * pre-crossing tick high in the lap, then the wrap + counter tick.
 * `lap` is the Lap counter value DURING the lap being completed.
 */
function cross(
  t: FuelLapTracker,
  { lap, time, fuel, onPitRoad = false }: { lap: number; time: number; fuel: number; onPitRoad?: boolean },
): void {
  diffFuelLaps(t, tick({ Lap: lap, LapDistPct: 0.9, SessionTime: time - 1, FuelLevel: fuel, OnPitRoad: onPitRoad }));
  diffFuelLaps(t, tick({ Lap: lap + 1, LapDistPct: 0.05, SessionTime: time, FuelLevel: fuel, OnPitRoad: onPitRoad }));
}

describe("diffFuelLaps — seeding", () => {
  it("seeds silently on the first tick without recording", () => {
    const t = createFuelLapTracker();

    diffFuelLaps(t, tick());

    expect(t.initialized).toBe(true);
    expect(t.history).toHaveLength(0);
  });

  it("discards the partial first segment after a mid-lap connect", () => {
    const t = createFuelLapTracker();

    // Connect mid-lap at 50% distance, then cross the line — the segment only
    // covers half a lap and must not be recorded.
    diffFuelLaps(t, tick({ Lap: 3, LapDistPct: 0.5, SessionTime: 100, FuelLevel: 40 }));
    diffFuelLaps(t, tick({ Lap: 3, LapDistPct: 0.9, SessionTime: 140, FuelLevel: 39 }));
    diffFuelLaps(t, tick({ Lap: 4, LapDistPct: 0.05, SessionTime: 145, FuelLevel: 38.8 }));

    expect(t.history).toHaveLength(0);

    // The following full lap records normally.
    cross(t, { lap: 4, time: 235, fuel: 36 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(2.8);
  });

  it("ignores ticks with missing fuel/lap/time fields", () => {
    const t = createFuelLapTracker();

    diffFuelLaps(t, { OnPitRoad: false } as unknown as TelemetryData);

    expect(t.initialized).toBe(false);
  });

  it("ignores ticks with NaN fields", () => {
    const t = createFuelLapTracker();

    diffFuelLaps(t, tick({ FuelLevel: NaN }));

    expect(t.initialized).toBe(false);

    // A NaN mid-lap must not poison the segment baselines.
    prime(t, { lap: 5, time: 100, fuel: 50 });
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.9, SessionTime: 189, FuelLevel: NaN }));
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
    expect(t.history[0]!.isValidForCalc).toBe(true);
  });
});

describe("diffFuelLaps — lap crossing detection", () => {
  it("records a valid lap with correct fuelUsed, lapTime, and lapNumber", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);
    const lap = t.history[0]!;
    expect(lap.lapNumber).toBe(5);
    expect(lap.fuelUsed).toBeCloseTo(3);
    expect(lap.lapTime).toBeCloseTo(90);
    expect(lap.isValidForCalc).toBe(true);
    expect(lap.isOutLap).toBe(false);
    expect(lap.isInLap).toBe(false);
    expect(lap.wasTowed).toBe(false);
  });

  it("records nothing on a LapDistPct wrap without a Lap counter increment", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // Wrap (e.g. a position glitch) but the counter never advances.
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.9, SessionTime: 189, FuelLevel: 47 }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.05, SessionTime: 190, FuelLevel: 47 }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.1, SessionTime: 195, FuelLevel: 46.9 }));

    expect(t.history).toHaveLength(0);
  });

  it("finalizes when the counter increment arrives shortly after the wrap", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.9, SessionTime: 189, FuelLevel: 47.1 }));
    // Wrap tick — counter still lags.
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.02, SessionTime: 190, FuelLevel: 47.05 }));
    // Counter catches up two ticks later.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.03, SessionTime: 190.1, FuelLevel: 47 }));

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.lapNumber).toBe(5);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
  });

  it("expires a pending wrap once the crossing window passes without a counter increment", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.9, SessionTime: 189, FuelLevel: 47 }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.05, SessionTime: 190, FuelLevel: 47 }));
    // Window passes, then the counter finally increments (unrelated later event)
    // — the stale wrap must not pair with it.
    diffFuelLaps(
      t,
      tick({ Lap: 5, LapDistPct: 0.1, SessionTime: 190 + FUEL_LAP_CROSSING_WINDOW_S + 1, FuelLevel: 46.8 }),
    );
    diffFuelLaps(
      t,
      tick({ Lap: 6, LapDistPct: 0.12, SessionTime: 190 + FUEL_LAP_CROSSING_WINDOW_S + 2, FuelLevel: 46.8 }),
    );

    expect(t.history).toHaveLength(0);
  });

  it("discards a segment spanning more than one counter increment (missed wrap)", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // The lap-6 wrap is missed (tick gap); counter advances to 6 silently.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.3, SessionTime: 200, FuelLevel: 46.5 }));
    // Next crossing: counter is now 2 ahead of the segment start — a two-lap
    // segment would be garbage, so nothing is recorded.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.9, SessionTime: 279, FuelLevel: 44.2 }));
    diffFuelLaps(t, tick({ Lap: 7, LapDistPct: 0.05, SessionTime: 280, FuelLevel: 44 }));

    expect(t.history).toHaveLength(0);

    // Tracking recovers on the following lap.
    cross(t, { lap: 7, time: 370, fuel: 41 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
  });

  it("does not let a transient counter blip discard the next genuine crossing", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // One-tick counter blip mid-lap (no wrap), then back to the baseline —
    // the pending-counter timestamp must clear, not go stale.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.5, SessionTime: 150, FuelLevel: 48.4 }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.51, SessionTime: 150.1, FuelLevel: 48.4 }));
    // Genuine crossing where the counter increments a tick BEFORE the wrap.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.95, SessionTime: 189, FuelLevel: 47 }));
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.05, SessionTime: 190, FuelLevel: 47 }));

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.lapNumber).toBe(5);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
  });

  it("absorbs a sub-minimum-lap-time crossing without recording", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // A "crossing" only a few seconds after the lap opened (line wobble /
    // teleport past the line) — below the floor, discarded.
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.9, SessionTime: 100 + FUEL_LAP_MIN_LAP_TIME_S - 2, FuelLevel: 49.9 }));
    diffFuelLaps(
      t,
      tick({ Lap: 6, LapDistPct: 0.05, SessionTime: 100 + FUEL_LAP_MIN_LAP_TIME_S - 1, FuelLevel: 49.9 }),
    );

    expect(t.history).toHaveLength(0);

    // The segment restarted at the discarded crossing; the next full lap records.
    cross(t, { lap: 6, time: 100 + FUEL_LAP_MIN_LAP_TIME_S - 1 + 90, fuel: 47 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(2.9);
  });
});

describe("diffFuelLaps — refuel accounting", () => {
  it("excludes a mid-lap refuel from fuelUsed", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 20 });
    // Pit stop mid-lap: fuel climbs 18 → 60 over several ticks.
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.4, SessionTime: 140, FuelLevel: 18, OnPitRoad: true }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.4, SessionTime: 145, FuelLevel: 40, OnPitRoad: true }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.4, SessionTime: 150, FuelLevel: 60, OnPitRoad: true }));
    cross(t, { lap: 5, time: 220, fuel: 59 });

    expect(t.history).toHaveLength(1);
    const lap = t.history[0]!;
    // Used = 20 (start) + 42 (refuel) − 59 (end) = 3 — positive, not −39.
    expect(lap.fuelUsed).toBeCloseTo(3);
    expect(lap.fuelUsed).toBeGreaterThan(0);
    expect(lap.isInLap).toBe(true);
    expect(lap.isValidForCalc).toBe(false);
  });

  it("keeps the lap after a refuel stop correct", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 20 });
    // Refuel lap (in-lap, invalid).
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.4, SessionTime: 145, FuelLevel: 60, OnPitRoad: true }));
    cross(t, { lap: 5, time: 220, fuel: 59 });
    // Out-lap after the stop (started on pit road? no — the car left the pits
    // mid-lap-5, so lap 6 starts on track and is a full flying lap).
    cross(t, { lap: 6, time: 310, fuel: 56.2 });

    expect(t.history).toHaveLength(2);
    expect(t.history[1]!.fuelUsed).toBeCloseTo(2.8);
    expect(t.history[1]!.isValidForCalc).toBe(true);
  });
});

describe("diffFuelLaps — validity gates", () => {
  it("flags a lap started on pit road as an out-lap (invalid)", () => {
    const t = createFuelLapTracker();

    // Prime with the crossing tick on pit road → the newly opened lap is an out-lap.
    diffFuelLaps(t, tick({ Lap: 4, LapDistPct: 0.9, SessionTime: 40, FuelLevel: 50, OnPitRoad: true }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.05, SessionTime: 100, FuelLevel: 50, OnPitRoad: true }));
    // Leaves the pits early in the lap, completes it normally.
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.isOutLap).toBe(true);
    expect(t.history[0]!.isValidForCalc).toBe(false);

    // First full flying lap after the out-lap is valid.
    cross(t, { lap: 6, time: 280, fuel: 44 });

    expect(t.history).toHaveLength(2);
    expect(t.history[1]!.isOutLap).toBe(false);
    expect(t.history[1]!.isValidForCalc).toBe(true);
  });

  it("does not flag an out-lap as an in-lap while it starts on pit road", () => {
    const t = createFuelLapTracker();

    diffFuelLaps(t, tick({ Lap: 4, LapDistPct: 0.9, SessionTime: 40, FuelLevel: 50, OnPitRoad: true }));
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.05, SessionTime: 100, FuelLevel: 50, OnPitRoad: true }));
    // Still rolling down the pit lane at the start of the lap...
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.1, SessionTime: 110, FuelLevel: 49.8, OnPitRoad: true }));
    // ...then on track for the rest.
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history[0]!.isOutLap).toBe(true);
    expect(t.history[0]!.isInLap).toBe(false);
  });

  it("flags entering the pits during a lap as an in-lap (invalid)", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.7, SessionTime: 170, FuelLevel: 48, OnPitRoad: true }));
    cross(t, { lap: 5, time: 200, fuel: 47.5, onPitRoad: true });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.isInLap).toBe(true);
    expect(t.history[0]!.isValidForCalc).toBe(false);
  });

  it("flags a towed lap as towed (invalid)", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.6, SessionTime: 160, FuelLevel: 48, PlayerCarTowTime: 20 }));
    cross(t, { lap: 5, time: 260, fuel: 47.5 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.wasTowed).toBe(true);
    expect(t.history[0]!.isValidForCalc).toBe(false);
  });

  it("flags a lap with non-positive fuelUsed as invalid", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // Fuel level unchanged across the whole lap (e.g. engine off, being pushed).
    cross(t, { lap: 5, time: 190, fuel: 50 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBe(0);
    expect(t.history[0]!.isValidForCalc).toBe(false);
  });
});

describe("diffFuelLaps — reset fencing", () => {
  it("clears the history on a session restart (Lap decrease + session clock rewind)", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);

    // Session restart: Lap drops back to 0 AND SessionTime rewinds.
    diffFuelLaps(t, tick({ Lap: 0, LapDistPct: 0.5, SessionTime: 10, FuelLevel: 60 }));

    expect(t.history).toHaveLength(0);

    // New run: the lap-0 → lap-1 line crossing discards the partial lap-0
    // segment and opens lap 1, which then records normally.
    cross(t, { lap: 0, time: 30, fuel: 60 });
    cross(t, { lap: 1, time: 120, fuel: 57 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
    expect(t.history[0]!.lapNumber).toBe(1);
  });

  it("preserves the history on a backward start/finish crossing (Lap decrement, clock advancing)", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);

    // Spin at the line: the car rolls backwards across start/finish, iRacing
    // decrements Lap by one — NOT a session restart, the clock keeps running.
    diffFuelLaps(t, tick({ Lap: 5, LapDistPct: 0.98, SessionTime: 250, FuelLevel: 46 }));

    expect(t.history).toHaveLength(1);

    // Recover forward across the line (partial post-spin segment discarded),
    // then the next full lap records on top of the preserved history.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.05, SessionTime: 260, FuelLevel: 45.9 }));
    cross(t, { lap: 6, time: 350, fuel: 43 });

    expect(t.history).toHaveLength(2);
    expect(t.history[1]!.fuelUsed).toBeCloseTo(2.9);
    expect(t.history[1]!.isValidForCalc).toBe(true);
  });

  it("ignores transient negative Lap sentinel ticks", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    // One not-in-world blip tick (tow despawn / connection blink) — iRacing
    // snaps Lap/LapDistPct to -1 for a tick.
    diffFuelLaps(t, tick({ Lap: -1, LapDistPct: -1, SessionTime: 150, FuelLevel: 48 }));
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
    expect(t.history[0]!.isValidForCalc).toBe(true);
  });
});

describe("diffFuelLaps — replay / garage resume (issue #465 follow-up)", () => {
  it("re-anchors after a gap without recording garbage or losing the history", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);

    // Garage visit: the translator pauses the diff during replay-mode ticks
    // and arms resumePartial. On return the car sits at the pit box with
    // more fuel and an advanced lap counter — none of it may record.
    t.resumePartial = true;
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.95, SessionTime: 400, FuelLevel: 60, OnPitRoad: true }));

    expect(t.resumePartial).toBe(false);
    expect(t.history).toHaveLength(1);

    // Drive out: the next crossing discards the partial post-gap segment,
    // then the following full lap records on top of the preserved history.
    diffFuelLaps(t, tick({ Lap: 6, LapDistPct: 0.98, SessionTime: 420, FuelLevel: 59.8 }));
    diffFuelLaps(t, tick({ Lap: 7, LapDistPct: 0.05, SessionTime: 425, FuelLevel: 59.7 }));
    cross(t, { lap: 7, time: 515, fuel: 57 });

    expect(t.history).toHaveLength(2);
    expect(t.history[1]!.fuelUsed).toBeCloseTo(2.7);
    expect(t.history[1]!.isValidForCalc).toBe(true);
  });
});

describe("diffFuelLaps — deferred session wipe (issue #465 follow-up)", () => {
  it("holds the old stats while out of the car and wipes on the first in-car tick", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    expect(t.history).toHaveLength(1);

    // Session change arrives; the driver is in the garage of the new session.
    t.pendingSessionWipe = true;
    diffFuelLaps(t, tick({ Lap: 0, LapDistPct: 0.3, SessionTime: 20, FuelLevel: 55, IsOnTrack: false }));

    expect(t.history).toHaveLength(1);
    expect(t.pendingSessionWipe).toBe(true);

    // Back in the car → wipe and start fresh.
    diffFuelLaps(t, tick({ Lap: 0, LapDistPct: 0.99, SessionTime: 60, FuelLevel: 55 }));

    expect(t.history).toHaveLength(0);
    expect(t.pendingSessionWipe).toBe(false);

    // The new session's first line crossing discards the partial pre-line
    // segment; lap 1 then records normally.
    diffFuelLaps(t, tick({ Lap: 1, LapDistPct: 0.05, SessionTime: 90, FuelLevel: 55 }));
    cross(t, { lap: 1, time: 180, fuel: 52 });

    expect(t.history).toHaveLength(1);
    expect(t.history[0]!.fuelUsed).toBeCloseTo(3);
    expect(t.history[0]!.lapNumber).toBe(1);
  });

  it("holds the wipe through the pre-green grid and executes at the green flag", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    // Qualifying → race with the driver auto-gridded IN the car: the old
    // consumption stats must stay visible for fuel planning until the green.
    t.pendingSessionWipe = true;
    diffFuelLaps(
      t,
      tick({ Lap: 0, LapDistPct: 0.98, SessionTime: 30, FuelLevel: 55, SessionState: SessionState.GetInCar }),
    );
    diffFuelLaps(
      t,
      tick({ Lap: 0, LapDistPct: 0.99, SessionTime: 60, FuelLevel: 55, SessionState: SessionState.ParadeLaps }),
    );

    expect(t.history).toHaveLength(1);
    expect(t.pendingSessionWipe).toBe(true);

    // Green flag → wipe, rebuild from the race's laps.
    diffFuelLaps(
      t,
      tick({ Lap: 0, LapDistPct: 0.995, SessionTime: 90, FuelLevel: 55, SessionState: SessionState.Racing }),
    );

    expect(t.history).toHaveLength(0);
    expect(t.pendingSessionWipe).toBe(false);
  });

  it("takes precedence over a pending resumePartial", () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 5, time: 100, fuel: 50 });
    cross(t, { lap: 5, time: 190, fuel: 47 });

    t.resumePartial = true;
    t.pendingSessionWipe = true;
    diffFuelLaps(t, tick({ Lap: 0, LapDistPct: 0.99, SessionTime: 60, FuelLevel: 55 }));

    expect(t.history).toHaveLength(0);
    expect(t.pendingSessionWipe).toBe(false);
    expect(t.resumePartial).toBe(false);
  });
});

describe("diffFuelLaps — history cap", () => {
  it(`caps the history at ${FUEL_LAP_HISTORY_CAP} laps, evicting the oldest`, () => {
    const t = createFuelLapTracker();

    prime(t, { lap: 1, time: 0, fuel: 200 });

    for (let i = 0; i < FUEL_LAP_HISTORY_CAP + 3; i++) {
      cross(t, { lap: 1 + i, time: 90 * (i + 1), fuel: 200 - 3 * (i + 1) });
    }

    expect(t.history).toHaveLength(FUEL_LAP_HISTORY_CAP);
    expect(t.history[0]!.lapNumber).toBe(4);
    expect(t.history[FUEL_LAP_HISTORY_CAP - 1]!.lapNumber).toBe(FUEL_LAP_HISTORY_CAP + 3);
  });
});

describe("computeFuelStats", () => {
  function lap(fuelUsed: number, isValidForCalc = true, extra: Partial<FuelLap> = {}): FuelLap {
    return {
      lapNumber: 1,
      fuelUsed,
      lapTime: 90,
      isValidForCalc,
      isOutLap: false,
      isInLap: false,
      wasTowed: false,
      ...extra,
    };
  }

  it("returns empty stats for an empty history", () => {
    expect(computeFuelStats([], 5)).toEqual({ lastLap: null, avg: null, samples: 0 });
  });

  it("returns empty stats when no laps are valid", () => {
    expect(computeFuelStats([lap(3, false), lap(2.5, false)], 5)).toEqual({ lastLap: null, avg: null, samples: 0 });
  });

  it("averages over the last N valid laps, skipping invalid ones", () => {
    const history = [lap(3), lap(10, false), lap(2), lap(4)];

    const stats = computeFuelStats(history, 3);

    expect(stats.avg).toBeCloseTo(3);
    expect(stats.lastLap).toBeCloseTo(4);
    expect(stats.samples).toBe(3);
  });

  it("reports the most recent VALID lap as lastLap when the latest lap is invalid", () => {
    const history = [lap(3), lap(2.8), lap(12, false)];

    const stats = computeFuelStats(history, 5);

    expect(stats.lastLap).toBeCloseTo(2.8);
  });

  it("averages what exists when fewer valid laps than the window", () => {
    const stats = computeFuelStats([lap(2), lap(4)], 5);

    expect(stats.avg).toBeCloseTo(3);
    expect(stats.samples).toBe(2);
  });

  it("handles a window of 1", () => {
    const stats = computeFuelStats([lap(2), lap(4)], 1);

    expect(stats.avg).toBeCloseTo(4);
    expect(stats.lastLap).toBeCloseTo(4);
    expect(stats.samples).toBe(1);
  });

  it("handles a window of 20 over a smaller valid set", () => {
    const stats = computeFuelStats([lap(2), lap(3), lap(4)], 20);

    expect(stats.avg).toBeCloseTo(3);
    expect(stats.samples).toBe(3);
  });

  it("clamps a non-positive or fractional window to at least one lap", () => {
    expect(computeFuelStats([lap(2), lap(4)], 0).samples).toBe(1);
    expect(computeFuelStats([lap(2), lap(4)], 2.7).samples).toBe(2);
  });

  it("treats a non-finite window as one lap instead of silently averaging everything", () => {
    expect(computeFuelStats([lap(2), lap(3), lap(4)], NaN).samples).toBe(1);
    expect(computeFuelStats([lap(2), lap(3), lap(4)], NaN).avg).toBeCloseTo(4);
  });

  it("uses a single valid lap for both lastLap and avg", () => {
    const stats = computeFuelStats([lap(2.5)], 5);

    expect(stats).toEqual({ lastLap: 2.5, avg: 2.5, samples: 1 });
  });
});
