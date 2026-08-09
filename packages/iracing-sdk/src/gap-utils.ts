/**
 * Pure gap-math primitives (issue #933): crossing-time traces, class-standings
 * neighbor resolution, and trend classification. Stateless — the rolling trace
 * store that OWNS the arrays lives in the sim translator's state; these
 * functions only read/append.
 *
 * The gap model is forward-only: the gap from a chasing car to the car ahead
 * is "how long ago did the car ahead cross the chaser's current position",
 * read from the ahead car's progress→time trace. There is deliberately no
 * ±half-lap wrapping delta anywhere in this module — a wrap-relative delta
 * returns the complement (a plausible-looking, wrong number) whenever the
 * standings neighbor is more than half a lap away on track.
 */

/** One recorded point of a car's progress (laps, `lapCompleted + lapDistPct`) at a session time (s). */
export type ProgressSample = { progress: number; time: number };

/** Rolling per-car trace, ascending by progress. Owned by translator state. */
export type ProgressTrace = ProgressSample[];

/** How much history each trace keeps, in laps. Covers same-lap gaps plus margin. */
export const GAP_TRACE_SPAN_LAPS = 1.15;

/**
 * Minimum progress advance between recorded samples, in laps. 0.002 lap is
 * ~12 m on a 6 km track — linear interpolation between samples this close is
 * comfortably inside the ±0.1 s accuracy target at racing speeds.
 */
export const GAP_TRACE_MIN_STEP = 0.002;

/**
 * Largest forward progress step, in laps, that can be a car actually driving
 * between two recorded samples. Samples land ~every {@link GAP_TRACE_MIN_STEP}
 * lap while a car is in the world, so a bigger jump means the car was ABSENT
 * (towing, teleported to the pit stall, a multi-second telemetry gap) and the
 * span between the two samples was never driven.
 */
export const GAP_TRACE_MAX_STEP = 0.05;

/**
 * Append a progress sample to a trace, keeping it ascending and pruned to
 * {@link GAP_TRACE_SPAN_LAPS}. A DISCONTINUITY in either direction — a
 * backwards jump (tow, teleport, session reset) or a forward jump past
 * {@link GAP_TRACE_MAX_STEP} (a car towed to a pit stall further around the
 * lap, or a long telemetry gap) — resets the trace. Stale samples across a
 * discontinuity would lie about crossing times: `crossingTimeAt` interpolates
 * linearly between adjacent samples, so a lookup landing inside an undriven
 * span would return a time off by the whole absence.
 */
export function appendProgressSample(trace: ProgressTrace, progress: number, time: number): void {
  const last = trace.length > 0 ? trace[trace.length - 1] : undefined;

  if (last !== undefined) {
    const step = progress - last.progress;

    if (step < -GAP_TRACE_MIN_STEP || step > GAP_TRACE_MAX_STEP) {
      trace.length = 0;
    } else if (step < GAP_TRACE_MIN_STEP) {
      return;
    }
  }

  trace.push({ progress, time });

  const minProgress = progress - GAP_TRACE_SPAN_LAPS;
  let drop = 0;

  while (drop < trace.length - 1 && trace[drop]!.progress < minProgress) drop++;

  if (drop > 0) trace.splice(0, drop);
}

/**
 * Session time (s) at which the traced car crossed `progress`, linearly
 * interpolated between the bracketing samples. `null` when the trace doesn't
 * cover the point — callers fall back (cold start) rather than extrapolate.
 */
export function crossingTimeAt(trace: ProgressTrace, progress: number): number | null {
  if (trace.length === 0) return null;

  if (progress < trace[0]!.progress || progress > trace[trace.length - 1]!.progress) return null;

  // Binary search for the last sample with sample.progress <= progress.
  let lo = 0;
  let hi = trace.length - 1;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;

    if (trace[mid]!.progress <= progress) lo = mid;
    else hi = mid - 1;
  }

  const a = trace[lo]!;

  if (a.progress === progress || lo === trace.length - 1) return a.time;

  const b = trace[lo + 1]!;
  const span = b.progress - a.progress;

  if (span <= 0) return a.time;

  return a.time + ((progress - a.progress) / span) * (b.time - a.time);
}

/** Class-standings neighbor car indices; `-1` = no such car. */
export type StandingsNeighbors = {
  /** Car one class position ahead of `carIdx`. */
  aheadIdx: number;
  /** Car one class position behind `carIdx`. */
  behindIdx: number;
  /** Best-ranked car in the player's class (the player itself when leading). */
  leaderIdx: number;
};

const NO_NEIGHBORS: StandingsNeighbors = { aheadIdx: -1, behindIdx: -1, leaderIdx: -1 };

/**
 * Resolve the player's class-standings neighbors from the canonical order.
 *
 * `positions` is the 1-based overall rank array indexed by carIdx (`0` =
 * unclassified) — always the canonical live order per
 * `.claude/rules/race-positions.md`, never a local recomputation. Class
 * membership comes from `CarIdxClass`. `excludeIdx` removes the pace car
 * explicitly — the canonical order itself carries no pace-car filter, so
 * relying on class-id conventions alone is not a guarantee (issue #933).
 */
export function resolveClassNeighbors(
  positions: number[],
  carIdxClass: number[] | undefined,
  carIdx: number,
  excludeIdx?: number | null,
): StandingsNeighbors {
  if (!Array.isArray(carIdxClass)) return { ...NO_NEIGHBORS };

  if (carIdx < 0 || carIdx >= positions.length) return { ...NO_NEIGHBORS };

  const myRank = positions[carIdx];

  if (myRank === undefined || myRank <= 0) return { ...NO_NEIGHBORS };

  const myClass = carIdxClass[carIdx];

  if (myClass === undefined) return { ...NO_NEIGHBORS };

  let aheadIdx = -1;
  let aheadRank = -1;
  let behindIdx = -1;
  let behindRank = Number.POSITIVE_INFINITY;
  let leaderIdx = carIdx;
  let leaderRank = myRank;

  for (let i = 0; i < positions.length; i++) {
    if (i === carIdx || i === excludeIdx) continue;

    const rank = positions[i];

    if (rank === undefined || rank <= 0 || carIdxClass[i] !== myClass) continue;

    if (rank < myRank && rank > aheadRank) {
      aheadRank = rank;
      aheadIdx = i;
    }

    if (rank > myRank && rank < behindRank) {
      behindRank = rank;
      behindIdx = i;
    }

    if (rank < leaderRank) {
      leaderRank = rank;
      leaderIdx = i;
    }
  }

  return { aheadIdx, behindIdx, leaderIdx };
}

/**
 * A car's recent progress rate (laps per second) over roughly the trailing
 * `windowSeconds` of wall clock, anchored on `now` — NOT on the trace's last
 * sample, so a stopped car (whose trace stops growing) decays toward 0 as
 * time passes instead of reporting its old racing pace. `null` when the
 * trace doesn't reach back far enough to measure.
 */
export function recentProgressRate(
  trace: ProgressTrace | undefined,
  currentProgress: number,
  now: number,
  windowSeconds: number,
): number | null {
  if (!trace || trace.length === 0) return null;

  const cutoff = now - windowSeconds;
  let ref: ProgressSample | null = null;

  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i]!.time <= cutoff) {
      ref = trace[i]!;
      break;
    }
  }

  if (ref === null) return null;

  const dt = now - ref.time;

  if (dt <= 0) return null;

  return Math.max(0, (currentProgress - ref.progress) / dt);
}

/** Direction the gap is moving. "closing" = shrinking, "opening" = growing. */
export type GapTrendDirection = "closing" | "opening" | "steady";

/**
 * Classify a gap change (seconds; negative = the gap shrank) against a
 * deadband. Returns `null` for missing/non-finite input so callers can
 * distinguish "no data" from "steady".
 */
export function classifyGapTrend(deltaSeconds: number | null, deadbandSeconds: number): GapTrendDirection | null {
  if (deltaSeconds === null || !Number.isFinite(deltaSeconds)) return null;

  if (deltaSeconds < -deadbandSeconds) return "closing";

  if (deltaSeconds > deadbandSeconds) return "opening";

  return "steady";
}

/**
 * Whole laps the ahead car is up on the behind car (`0` = same racing lap).
 * Uses total progress (`CarIdxLapCompleted + CarIdxLapDistPct`) — note
 * `CarIdxLap` differs from `CarIdxLapCompleted` by one at the line; the
 * position primitive and this module both use `LapCompleted`.
 */
export function lapDeltaBetween(progressAhead: number, progressBehind: number): number {
  // Epsilon guards the exact-lap boundary: 8.2 − 5.2 is 2.999… in IEEE floats
  // and must still count as 3 laps.
  return Math.max(0, Math.floor(progressAhead - progressBehind + 1e-9));
}

/**
 * Coarse forward track gap from the player to a car ahead, in seconds (issue
 * #936): the forward `LapDistPct` delta folded around the lap × track length
 * ÷ the player's speed, floored at `minSpeedMps` so a stationary player
 * can't divide by zero. Deliberately NOT the crossing-time trace model (#933)
 * — this is a window boundary, never a spoken value, and it must cover
 * track-relative traffic on any lap. `null` when the track length or either
 * progress value is unusable; a missing/invalid speed uses the floor.
 */
export function coarseForwardGapSeconds(
  playerLapDistPct: number,
  carLapDistPct: number,
  trackLengthMeters: number | null,
  playerSpeedMps: number | null | undefined,
  minSpeedMps: number,
): number | null {
  if (typeof trackLengthMeters !== "number" || !Number.isFinite(trackLengthMeters) || trackLengthMeters <= 0) {
    return null;
  }

  if (
    !Number.isFinite(playerLapDistPct) ||
    !Number.isFinite(carLapDistPct) ||
    playerLapDistPct < 0 ||
    carLapDistPct < 0
  ) {
    return null;
  }

  const forwardFraction = (((carLapDistPct - playerLapDistPct) % 1) + 1) % 1;
  const speed =
    typeof playerSpeedMps === "number" && Number.isFinite(playerSpeedMps)
      ? Math.max(playerSpeedMps, minSpeedMps)
      : minSpeedMps;

  return (forwardFraction * trackLengthMeters) / speed;
}
