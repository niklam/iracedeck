/**
 * Validated per-lap fuel consumption tracking (issue #465).
 *
 * Maintains a `FuelLapTracker` — a rolling history of per-lap fuel usage with
 * validity gating — and emits NO bus events. Consumers read it through the
 * translator's `getFuelStats()` accessor (Session Info fuel sub-modes; the
 * Race Engineer fuel readout in #466 consumes the same accessor). The tracker
 * lives on the translator instance so it survives the replay guard's state
 * wipes and the per-session reset — see `FuelLapTracker`.
 *
 * A naive rolling mean over `FuelLevel` lap deltas produces garbage on
 * refuels, out/in laps, tows, and session resets, so every lap record is
 * gated before it can contribute to an average:
 *
 *   - **Lap crossing** requires BOTH signals: the `LapDistPct` wrap
 *     (high→low) and the `Lap` counter increment — either alone has failure
 *     modes (position glitches wrap without a counter change; garage exits
 *     and tick gaps advance the counter without an observable wrap). The two
 *     signals pair within `FUEL_LAP_CROSSING_WINDOW_S`; a counter advance
 *     that never pairs re-anchors the segment as partial (teleport / missed
 *     crossing) so a multi-lap segment is never recorded.
 *   - **Min-lap-time floor** absorbs jitter crossings (line wobble,
 *     teleports past the line) without recording.
 *   - **Refuel-aware accounting** accumulates debounced mid-lap `FuelLevel`
 *     increases so `fuelUsed = lapStartFuel + accumulatedRefuel − fuelLevel`
 *     stays correct (and non-negative) across a pit stop.
 *   - **Validity** — `fuelUsed > 0 && lapTime ≥ floor && !outLap && !inLap
 *     && !towed`. Invalid laps stay in the history (they carry the lap
 *     number sequence) but never contribute to stats.
 *   - **Reset fencing** — a session restart (the `Lap` counter AND the
 *     session clock both rewinding) clears the history immediately; a lone
 *     `Lap` decrease (a backward start/finish crossing in a spin) or a
 *     negative-`Lap` sentinel tick leaves the history intact. A session
 *     change instead arms a DEFERRED wipe (`pendingSessionWipe`) that
 *     executes on the first live-in-car tick past the pre-green phase of the
 *     new session, and replay/garage visits merely re-anchor the open
 *     segment (`resumePartial`) — in both cases the previous stats keep
 *     displaying while the driver is out of the car. Disconnects reset the
 *     tracker entirely (`handleDisconnect`).
 *
 * Segments that don't start at a clean line crossing (tracker seed, reset
 * fence, teleport re-anchor) are marked `partial` and discarded at their
 * first crossing, so a mid-lap connect never records a partial lap.
 *
 * A seam for IQR outlier rejection over the valid set is deliberately left
 * open in `computeFuelStats` — the gates above remove systematic error, so
 * IQR is out of scope here (issue #465).
 */
import { isLiveOnTrack, isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";

/** Rolling history cap (laps). Also bounds the Session Info `fuelLapWindow` setting. */
export const FUEL_LAP_HISTORY_CAP = 20;

/**
 * Minimum lap duration (s) for a crossing to count as a real lap. Doubles as
 * the crossing-jitter debounce floor and the validity minimum — no real
 * circuit laps under ~10 s exist, while line wobble and teleports sit well
 * below it.
 */
export const FUEL_LAP_MIN_LAP_TIME_S = 10;

/**
 * Max seconds between the two crossing signals (`LapDistPct` wrap and `Lap`
 * counter increment) before the unpaired signal is discarded.
 */
export const FUEL_LAP_CROSSING_WINDOW_S = 5;

/** LapDistPct above this on the previous tick arms wrap detection. */
const WRAP_HIGH = 0.8;

/** LapDistPct below this on the current tick completes a wrap. */
const WRAP_LOW = 0.2;

/**
 * Minimum positive per-tick `FuelLevel` delta (L) counted as refueling.
 * Filters float jitter; a real fill adds far more than this per tick.
 */
const REFUEL_EPSILON_L = 0.01;

/** Rolling fuel consumption statistics over the validated lap history. */
export type FuelStats = {
  /** Fuel used on the most recent VALID lap (L), or `null` when none exists. */
  lastLap: number | null;
  /** Mean fuel used over the last `windowLaps` VALID laps (L), or `null`. */
  avg: number | null;
  /**
   * Mean lap duration (s) over the SAME valid-lap window as `avg`, or `null`
   * (issue #880). The validity gates (out/in/tow laps excluded, min-time
   * floor) are exactly what a pace estimate wants, so the timed-race
   * remaining-laps estimation reads its player pace here instead of keeping
   * a second tracker.
   */
  avgLapTime: number | null;
  /** Number of valid laps actually included in `avg`. */
  samples: number;
};

/**
 * One completed lap's fuel consumption record (issue #465). Produced by
 * `diffFuelLaps` and consumed via `computeFuelStats` / `getFuelStats()`.
 */
export type FuelLap = {
  lapNumber: number;
  /** Fuel consumed over the lap, liters (internal unit; callers convert for display). */
  fuelUsed: number;
  /** Lap duration in seconds, measured between line crossings via `SessionTime`. */
  lapTime: number;
  /** True when the lap is usable for consumption statistics — see `diffFuelLaps`. */
  isValidForCalc: boolean;
  /** Lap started on pit road. */
  isOutLap: boolean;
  /** Car entered pit road during the lap (after having been off it). */
  isInLap: boolean;
  /** Car was towed at some point during the lap (`PlayerCarTowTime > 0`). */
  wasTowed: boolean;
};

/**
 * Per-lap fuel consumption tracker (issue #465). Maintained by `diffFuelLaps`
 * — the current in-progress lap segment plus the rolling validated history.
 *
 * Lives on the translator INSTANCE, not `TranslatorState`, so the replay
 * guard's per-tick state wipes and the per-session reset don't destroy the
 * accumulated history — garage visits (which iRacing reports as replay-mode
 * ticks) and session changes keep the stats visible for fuel planning. Fully
 * reset only by `handleDisconnect`.
 */
export type FuelLapTracker = {
  /** Whether the tracker has seeded its baselines on the first valid tick. */
  initialized: boolean;
  /** Rolling buffer of completed lap records, capped at `FUEL_LAP_HISTORY_CAP`. */
  history: FuelLap[];
  /** `Lap` counter value when the current segment opened. */
  lapStartLap: number;
  /** `SessionTime` (s) when the current segment opened. */
  lapStartTime: number;
  /** `FuelLevel` (L) when the current segment opened. */
  lapStartFuel: number;
  /** Debounced mid-lap `FuelLevel` increases accumulated for refuel-aware accounting. */
  accumulatedRefuel: number;
  /** Previous-tick `FuelLevel`, for the per-tick refuel delta. */
  lastFuelLevel: number;
  /** Previous-tick `LapDistPct`, for wrap (high→low) detection. */
  lastDistPct: number;
  /** Current segment started on pit road. */
  isOutLap: boolean;
  /** Car has been off pit road at some point during the current segment. */
  leftPitRoad: boolean;
  /** Car entered pit road during the current segment (after having left it). */
  enteredPits: boolean;
  /** Car was towed during the current segment. */
  wasTowed: boolean;
  /**
   * `SessionTime` of an observed `LapDistPct` wrap awaiting its `Lap` counter
   * increment; expires after `FUEL_LAP_CROSSING_WINDOW_S`. `null` = none pending.
   */
  pendingWrapAt: number | null;
  /**
   * `SessionTime` when the `Lap` counter was first seen ahead of the segment
   * baseline without a wrap; a wrap arriving within the window completes the
   * crossing, otherwise the segment re-anchors as partial (teleport / missed
   * crossing). `null` = none pending.
   */
  pendingCounterAt: number | null;
  /**
   * The current segment did not start at a clean line crossing (tracker seed,
   * reset fence, or teleport re-anchor) — its eventual crossing is discarded
   * instead of recorded so partial laps never pollute the history.
   */
  partial: boolean;
  /**
   * Set by the translator on replay-mode entry (garage visits, replay
   * viewing). The next processed tick re-anchors the segment as partial at
   * the current telemetry — the gap made the open segment meaningless — while
   * the history is left untouched, so garage adjustments never lose the
   * accumulated stats.
   */
  resumePartial: boolean;
  /**
   * Set by the translator on a session change. The history is deliberately
   * NOT wiped at that moment — the previous session's consumption stays
   * visible while the driver sits in the garage planning fuel — and is
   * cleared on the first tick the driver is live in the car past the new
   * session's pre-green phase (a race grids the driver in the car well
   * before the green; the old stats hold until the flag drops). Takes
   * precedence over {@link resumePartial}.
   */
  pendingSessionWipe: boolean;
};

/** Fresh tracker with sentinel baselines — seeds silently on the first valid tick. */
export function createFuelLapTracker(): FuelLapTracker {
  return {
    initialized: false,
    history: [],
    lapStartLap: 0,
    lapStartTime: 0,
    lapStartFuel: 0,
    accumulatedRefuel: 0,
    lastFuelLevel: 0,
    lastDistPct: 0,
    isOutLap: false,
    leftPitRoad: true,
    enteredPits: false,
    wasTowed: false,
    pendingWrapAt: null,
    pendingCounterAt: null,
    partial: true,
    resumePartial: false,
    pendingSessionWipe: false,
  };
}

type SegmentAnchor = {
  lap: number;
  sessionTime: number;
  fuelLevel: number;
  onPitRoad: boolean;
  towed: boolean;
  partial: boolean;
};

function resetSegment(t: FuelLapTracker, anchor: SegmentAnchor): void {
  t.lapStartLap = anchor.lap;
  t.lapStartTime = anchor.sessionTime;
  t.lapStartFuel = anchor.fuelLevel;
  t.accumulatedRefuel = 0;
  t.isOutLap = anchor.onPitRoad;
  t.leftPitRoad = !anchor.onPitRoad;
  t.enteredPits = false;
  t.wasTowed = anchor.towed;
  t.pendingWrapAt = null;
  t.pendingCounterAt = null;
  t.partial = anchor.partial;
}

/**
 * Close the current segment at a confirmed line crossing: record it when it
 * is a clean single-lap segment above the time floor, then re-anchor the next
 * segment at the crossing (a crossing is by definition a clean lap start, so
 * the new segment is never partial).
 */
function finalizeCrossing(t: FuelLapTracker, anchor: Omit<SegmentAnchor, "partial">): void {
  const lapTime = anchor.sessionTime - t.lapStartTime;
  const counterDelta = anchor.lap - t.lapStartLap;

  if (!t.partial && counterDelta === 1 && lapTime >= FUEL_LAP_MIN_LAP_TIME_S) {
    const fuelUsed = t.lapStartFuel + t.accumulatedRefuel - anchor.fuelLevel;
    // The `lapTime ≥ floor` term of the issue-#465 validity spec is enforced
    // by the recording guard above — every record in the history already
    // satisfies it, so only the remaining gates appear here.
    const record: FuelLap = {
      lapNumber: t.lapStartLap,
      fuelUsed,
      lapTime,
      isValidForCalc: fuelUsed > 0 && !t.isOutLap && !t.enteredPits && !t.wasTowed,
      isOutLap: t.isOutLap,
      isInLap: t.enteredPits,
      wasTowed: t.wasTowed,
    };

    t.history.push(record);

    if (t.history.length > FUEL_LAP_HISTORY_CAP) t.history.shift();
  }

  resetSegment(t, { ...anchor, partial: false });
}

/**
 * Per-tick fuel lap tracking. Pure state maintenance — emits nothing. Runs
 * only on live (non-replay) ticks; the translator arms {@link
 * FuelLapTracker.resumePartial} / {@link FuelLapTracker.pendingSessionWipe}
 * around the gaps so the history survives them.
 */
export function diffFuelLaps(t: FuelLapTracker, telemetry: TelemetryData): void {
  const fuelLevel = telemetry.FuelLevel;
  const distPct = telemetry.LapDistPct;
  const lap = telemetry.Lap;
  const sessionTime = telemetry.SessionTime;

  // `Number.isFinite` (not `typeof`) — a transient NaN telemetry field on a
  // crossing tick would otherwise poison the segment baselines and silently
  // invalidate two consecutive laps. A negative Lap is iRacing's not-in-world
  // sentinel (tow despawn / connection blink) — skip the tick entirely rather
  // than let it masquerade as a session-restart Lap decrease.
  if (
    typeof fuelLevel !== "number" ||
    !Number.isFinite(fuelLevel) ||
    fuelLevel < 0 ||
    typeof distPct !== "number" ||
    !Number.isFinite(distPct) ||
    typeof lap !== "number" ||
    !Number.isFinite(lap) ||
    lap < 0 ||
    typeof sessionTime !== "number" ||
    !Number.isFinite(sessionTime)
  ) {
    return;
  }

  const onPitRoad = telemetry.OnPitRoad === true;
  const towed = typeof telemetry.PlayerCarTowTime === "number" && telemetry.PlayerCarTowTime > 0;
  const anchor = { lap, sessionTime, fuelLevel, onPitRoad, towed };

  if (!t.initialized) {
    t.initialized = true;
    resetSegment(t, { ...anchor, partial: true });
    t.lastFuelLevel = fuelLevel;
    t.lastDistPct = distPct;

    return;
  }

  // Deferred session wipe: the session changed, but the previous session's
  // stats keep displaying until the driver is genuinely back in the car — a
  // garage fuel-planning aid. `isPreGreen` extends the hold through a race
  // grid: on a qualifying → race transition the driver is often auto-gridded
  // IN the car, and wiping there would hide the consumption numbers exactly
  // when the fuel black box is still adjustable. The wipe lands at the green
  // flag instead; practice/qualifying sessions sit in `Racing` their whole
  // green period, so there the first in-car tick wipes as before.
  if (t.pendingSessionWipe) {
    if (!isLiveOnTrack(telemetry) || isPreGreen(telemetry)) return;

    t.pendingSessionWipe = false;
    t.resumePartial = false;
    t.history.length = 0;
    resetSegment(t, { ...anchor, partial: true });
    t.lastFuelLevel = fuelLevel;
    t.lastDistPct = distPct;

    return;
  }

  // Replay/garage gap: telemetry jumped while the diff was paused (position,
  // fuel, and lap counter may all have changed), so the open segment is
  // meaningless — re-anchor it as partial at the current tick. The history is
  // untouched: a garage visit must not lose the accumulated stats.
  if (t.resumePartial) {
    t.resumePartial = false;
    resetSegment(t, { ...anchor, partial: true });
    t.lastFuelLevel = fuelLevel;
    t.lastDistPct = distPct;

    return;
  }

  // Reset fence: a session restart rewinds BOTH the Lap counter and the
  // session clock — only that combination clears the history. A lone Lap
  // decrease also happens when the car rolls backwards across the start/
  // finish line (spin recovery), and a lone clock rewind shouldn't happen at
  // all — in either case the accumulated history must survive and only the
  // open segment is garbage, so it re-anchors as partial.
  const lapDecreased = lap < t.lapStartLap;
  const timeRewound = sessionTime < t.lapStartTime;

  if (lapDecreased || timeRewound) {
    if (lapDecreased && timeRewound) t.history.length = 0;

    resetSegment(t, { ...anchor, partial: true });
    t.lastFuelLevel = fuelLevel;
    t.lastDistPct = distPct;

    return;
  }

  // Latch the per-lap validity flags before any crossing is finalized so the
  // crossing tick's own state still counts toward the completed lap.
  if (onPitRoad) {
    if (t.leftPitRoad) t.enteredPits = true;
  } else {
    t.leftPitRoad = true;
  }

  if (towed) t.wasTowed = true;

  // Refuel-aware accounting: accumulate debounced mid-lap fuel increases.
  const fuelDelta = fuelLevel - t.lastFuelLevel;

  if (fuelDelta > REFUEL_EPSILON_L) t.accumulatedRefuel += fuelDelta;

  // Crossing signal bookkeeping. Expire a stale pending wrap first so it can
  // never pair with an unrelated counter increment seconds later.
  if (t.pendingWrapAt !== null && sessionTime - t.pendingWrapAt > FUEL_LAP_CROSSING_WINDOW_S) {
    t.pendingWrapAt = null;
  }

  if (t.lastDistPct > WRAP_HIGH && distPct < WRAP_LOW) {
    t.pendingWrapAt = sessionTime;
  }

  const counterIncremented = lap > t.lapStartLap;

  if (counterIncremented && t.pendingWrapAt !== null) {
    finalizeCrossing(t, anchor);
  } else if (counterIncremented) {
    if (t.pendingCounterAt === null) {
      t.pendingCounterAt = sessionTime;
    } else if (sessionTime - t.pendingCounterAt > FUEL_LAP_CROSSING_WINDOW_S) {
      // The counter advanced but no wrap ever arrived — a teleport (garage
      // return, tow drop-off) or a missed crossing (tick gap skipped the low
      // zone). The segment no longer starts at a clean line crossing, so
      // re-anchor it as partial; its eventual crossing is discarded.
      resetSegment(t, { ...anchor, partial: true });
    }
  } else {
    // Counter back at the baseline — a transient one-tick counter blip must
    // not leave a stale timestamp behind, or the next genuine crossing where
    // the increment lands a tick before the wrap would instantly read as an
    // expired teleport and drop a valid lap.
    t.pendingCounterAt = null;
  }

  t.lastFuelLevel = fuelLevel;
  t.lastDistPct = distPct;
}

/**
 * Rolling fuel statistics over the last `windowLaps` VALID laps of `history`
 * (not calendar laps — invalid laps are skipped, so a pit stop mid-window
 * never dilutes the average or flickers the display to "no data").
 *
 * `windowLaps` is clamped to at least 1 and floored to an integer; a
 * non-finite window (NaN from an unvalidated caller) also clamps to 1 —
 * `slice(-NaN)` would otherwise silently average the ENTIRE history while
 * claiming to honor the requested window. A window larger than the valid set
 * averages what exists; `samples` reports how many laps actually contributed
 * so callers can render a fallback while it is 0.
 */
export function computeFuelStats(history: readonly FuelLap[], windowLaps: number): FuelStats {
  const valid = history.filter((lap) => lap.isValidForCalc);

  if (valid.length === 0) return { lastLap: null, avg: null, avgLapTime: null, samples: 0 };

  const window = Number.isFinite(windowLaps) ? Math.max(1, Math.floor(windowLaps)) : 1;
  const included = valid.slice(-window);
  const sum = included.reduce((acc, lap) => acc + lap.fuelUsed, 0);
  const timeSum = included.reduce((acc, lap) => acc + lap.lapTime, 0);

  return {
    lastLap: valid[valid.length - 1]!.fuelUsed,
    avg: sum / included.length,
    avgLapTime: timeSum / included.length,
    samples: included.length,
  };
}
