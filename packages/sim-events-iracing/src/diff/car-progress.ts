/**
 * The per-tick car-progress step (issue #1572).
 *
 * Reads every car's race progress (`CarIdxLapCompleted + CarIdxLapDistPct`)
 * once per live tick, records it in the car's crossing-time trace (issue
 * #933) and hands the tick's readings on as a value. It is the one place that
 * states when race progress is read at all — in a race, past the green, while
 * the player is racing — so the gap diff (`diffGaps`) and the sector timer,
 * which both take its result, cannot disagree about it, and neither re-derives
 * the gate.
 *
 * It also states once what a car's progress IS at the start/finish line,
 * where iRacing's two arrays can disagree for a tick ({@link readCarProgress}).
 *
 * It publishes nothing. All math on a trace lives in `@iracedeck/iracing-sdk`
 * `gap-utils.ts`; this module only sequences it against its slice.
 */
import {
  appendProgressSample,
  isPreGreen,
  type ReadonlyProgressTrace,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

import type { CarProgressState } from "../state.js";

/**
 * How close to the start/finish line (lap fraction, either side of it) a
 * car's `CarIdxLapDistPct` must be for {@link readCarProgress} to read a
 * whole-lap step as the two arrays disagreeing rather than as the car having
 * moved. The disagreement lasts a tick, so the fraction is within one tick's
 * travel of the line: 0.05 lap is the most a car can drive between two
 * recorded samples at all (`GAP_TRACE_MAX_STEP`), and far more than a tick.
 * A whole-lap step anywhere else on the lap is a real discontinuity.
 */
export const CAR_PROGRESS_LINE_GUARD_PCT = 0.05;

/**
 * The longest `SessionTime` gap (seconds) since the last read across which the
 * line correction still trusts the confirmed progress (CodeRabbit CLI,
 * #1572). The counter and the fraction disagree for a tick at the line, so
 * the correction is a tick-to-tick rule; after a longer gap (ticks the step
 * was never called on, telemetry that stalled) the car may have driven a whole
 * lap, and a reading near the line taken against the stale progress would
 * hide that lap as a 0.005 step. Past the bound the reading is taken as it
 * stands, so a real lap reads as the discontinuity it is. Half a second allows
 * a few dropped ticks.
 */
export const CAR_PROGRESS_LINE_MAX_SPAN_S = 0.5;

/**
 * Whether a reading at `sessionTime` may be corrected against progress last
 * read at `lastReadSessionTime`: the one span rule both readers apply (the
 * progress step and the translator's pair-gap reading). `null` is no read.
 */
export function withinCorrectionSpan(lastReadSessionTime: number | null, sessionTime: number): boolean {
  if (lastReadSessionTime === null) return false;

  const since = sessionTime - lastReadSessionTime;

  return since >= 0 && since <= CAR_PROGRESS_LINE_MAX_SPAN_S;
}

/**
 * The furthest (laps) a corrected reading may be from the last progress: one
 * tick's travel, not the 0.05 lap that `GAP_TRACE_MAX_STEP` allows between
 * two recorded SAMPLES of a trace. The disagreement {@link readCarProgress}
 * reads through leaves the car where one tick of driving put it. At 60 Hz
 * even a 15 s lap is 0.0011 lap per tick, so 0.01 lap covers any car on any
 * track with several dropped ticks to spare, while a hop across the line
 * with the counter unchanged (5.98 to 5.02, a teleport that the trace's own
 * bound would pass as a 0.04 lap drive to 6.02) stays the discontinuity it
 * is.
 */
export const CAR_PROGRESS_LINE_MAX_TICK_STEP = 0.01;

/**
 * The furthest (laps) a reading may be from the last progress and still be
 * taken as continuing it. A lap counter and a lap fraction that disagree put
 * the sum a whole lap off, so half a lap separates "the car moved on" from
 * "a lap appeared or vanished": {@link readCarProgress} looks for the
 * disagreement only beyond it, and the step confirms a last progress only
 * within it.
 */
const CAR_PROGRESS_CONTINUOUS_LAPS = 0.5;

/**
 * A car's race progress this tick, from its `CarIdxLapCompleted` and
 * `CarIdxLapDistPct` (both finite and non-negative) and the CONFIRMED
 * progress last read for it ({@link confirmedLastProgress}; `undefined` =
 * none, and the reading is the plain sum).
 *
 * Normally the plain sum. At the start/finish line the two arrays do not
 * always move on the same tick (issue #1572; a replay capture of 2026-11-10
 * showed it on 8 of 24 crossings, and `leader-finish.ts` records it in either
 * direction): the counter steps a tick before the fraction wraps (6.9999 →
 * 8.0 → 7.0001) or a tick after it (6.9999 → 6.0001 → 7.0002). The sum is
 * then a whole lap off for that tick, which reads as a discontinuity twice
 * over though the car drove on without a break.
 *
 * So when the sum is more than half a lap from the last progress, the lap
 * count is taken from the last progress instead: the fraction plus the whole
 * number of laps that puts it nearest the last progress. That candidate is
 * used only when it is within {@link CAR_PROGRESS_LINE_MAX_TICK_STEP} of the
 * last progress (the car could have driven there in a tick) AND the fraction
 * is within
 * {@link CAR_PROGRESS_LINE_GUARD_PCT} of the line (the only place the arrays
 * disagree). Anything else — a tow, a teleport to the pits, a hop across the
 * line, a counter rewound mid-lap — is returned as the plain sum and stays
 * the discontinuity it is.
 *
 * `previous` must be a confirmed progress, never merely the last one. A car's
 * first reading can itself be taken on a disagreeing tick (the player's is at
 * every race start where the counter leads: the gate opens on the tick
 * `LapCompleted` steps from -1 to 0), a whole lap off; correcting the next,
 * true reading against that would carry the wrong lap on until the car left
 * the guard band.
 */
export function readCarProgress(previous: number | undefined, lapCompleted: number, lapDistPct: number): number {
  const raw = lapCompleted + lapDistPct;

  if (previous === undefined || Math.abs(raw - previous) <= CAR_PROGRESS_CONTINUOUS_LAPS) return raw;

  if (!isNearLine(lapDistPct)) return raw;

  const candidate = lapDistPct + Math.round(previous - lapDistPct);

  return Math.abs(candidate - previous) <= CAR_PROGRESS_LINE_MAX_TICK_STEP ? candidate : raw;
}

/**
 * Whether a lap fraction is within {@link CAR_PROGRESS_LINE_GUARD_PCT} of the
 * start/finish line, on either side: the only stretch where a car's lap
 * counter and lap fraction can disagree.
 */
function isNearLine(lapDistPct: number): boolean {
  return lapDistPct <= CAR_PROGRESS_LINE_GUARD_PCT || lapDistPct >= 1 - CAR_PROGRESS_LINE_GUARD_PCT;
}

/**
 * The progress last read for a car, when a reading may be corrected against
 * it: only once it is confirmed. A reading is confirmed when it continued the
 * reading before it (within half a lap) AND either that one was confirmed
 * already or this one was read clear of the line guard band. Agreement alone
 * is not enough near the line: a disagreement that lasts two ticks gives two
 * wrong readings that agree with each other, so a car first read inside the
 * band stays unconfirmed until it is read outside it, where the two arrays
 * cannot disagree. The cost is accepted: a car first read (after a blink,
 * say) within the band and crossing on a disagreeing tick is not corrected
 * there, and loses that crossing to a trace reset — a missing lap for the
 * sector timer, never a wrong one.
 *
 * `undefined` for a car with no reading on the last tick, for a first reading
 * after none, for one that did not continue the last, and for a run of
 * readings that began inside the band and has not left it. The one rule for every reader that puts a raw reading on
 * the traces' scale through {@link readCarProgress}: the step itself, and the
 * translator's pair reading (`getLiveGapBetween`).
 */
export function confirmedLastProgress(slice: CarProgressState, carIdx: number): number | undefined {
  return slice.lastProgressConfirmed[carIdx] === true ? slice.lastProgress[carIdx] : undefined;
}

/**
 * One live tick's race progress for every car: what {@link stepCarProgress}
 * read and did.
 *
 * **Continuity across ticks.** A consumer that keeps a car's reading from one
 * tick to measure against the next (the sector timer's crossing
 * interpolation) may bridge from the tick it last consumed only when this
 * tick's {@link CarProgressTick.previousSessionTime} equals that tick's
 * `sessionTime`. Otherwise a tick in between broke the chain — the gate
 * refused it, the step threw on it, or the consumer skipped a tick the step
 * read — and EVERY car's continuity is broken, whatever `traceReset` says: a
 * reset proves a discontinuity, but no reset proves nothing about such a
 * tick.
 *
 * **What the rule does not see.** Only a tick the step was CALLED on and
 * refused or threw on breaks the chain. A tick on which the step was not
 * called at all (the canonical order threw, so the translator skipped every
 * step that consumes it, this one and its consumers alike) leaves
 * `lastReadSessionTime` standing, so the next tick names the tick before the
 * gap as its previous one and is bridged across it. That is the same as a
 * telemetry tick that never arrived: a wider tick pair, which the consumer
 * bounds for itself (the sector timer measures no crossing across a pair
 * more than `SECTOR_MAX_TICK_SPAN_S` apart).
 */
export type CarProgressTick = {
  /** The tick's `SessionTime`, finite. */
  sessionTime: number;
  /**
   * The `sessionTime` of the tick the step read directly before this one, or
   * null when it read none: the first tick, the tick after one the gate
   * refused, and the tick after one the step threw on. A tick the step was
   * not called on is not seen here, so the two may be further apart than one
   * tick (see the type's note).
   */
  previousSessionTime: number | null;
  /**
   * Per car: its progress ({@link readCarProgress}: `CarIdxLapCompleted +
   * CarIdxLapDistPct`, corrected at the line) when both readings are finite
   * and non-negative, else null. Sized to the shorter of the two arrays
   * (`min(CarIdxLapCompleted.length, CarIdxLapDistPct.length)`), so an index
   * past it reads `undefined`: no reading either.
   */
  progress: readonly (number | null)[];
  /** Per car: true when this tick's sample reset the car's trace. Sized as `progress` is. */
  traceReset: readonly boolean[];
  /**
   * The traces after this tick's samples, sparse-indexed by carIdx. Live: the
   * slice's own array, which the next tick's samples are appended to, so it
   * is valid only for the tick it came with — read it during that tick and
   * keep no reference to it or to a trace in it.
   */
  traces: readonly (ReadonlyProgressTrace | undefined)[];
};

/**
 * Read this tick's race progress and append each valid reading to its car's
 * trace.
 *
 * Returns `null` — nothing read, nothing appended — unless all of these hold:
 * a race session, both `CarIdx` progress arrays present, a finite
 * `SessionTime`, a player car index, a canonical order (`frozenPositions`),
 * past the green, and the player racing (not `LapCompleted < 0`). The traces
 * are kept on such a tick: a brief gate flicker must not wipe a lap of
 * history, and a session change recreates the whole state anyway. Every
 * car's last progress is dropped, though: the line correction never reads
 * across a tick that was not read.
 *
 * Otherwise every car up to the shorter of the two arrays gets an entry: its
 * progress, or `null` for a reading that is not finite or is negative (a car
 * out of the world reads `-1`), which leaves its trace untouched and drops
 * its last progress. A reading is corrected at the line only against a last
 * progress that is confirmed ({@link confirmedLastProgress}); a first reading
 * after none is taken as it stands, and if it was a lap off (taken on a
 * disagreeing tick) the next true reading replaces it at the cost of one
 * trace reset, rather than inheriting its lap. A run of readings that began
 * near the line confirms only once the car is read clear of it. The tick also says which tick
 * was read directly before it (`previousSessionTime`), null unless that one
 * read every car. `traceReset` is true only where `appendProgressSample`
 * answered `"reset"`: the reading was a discontinuity (a backwards step, or a
 * forward one past `GAP_TRACE_MAX_STEP`), so the car's motion since its last
 * sample was not continuous.
 */
export function stepCarProgress(
  slice: CarProgressState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  playerCarIdx: number,
  /** The canonical live order this tick (`race-positions.md`); `null` = none, which fails the gate. */
  frozenPositions: readonly number[] | null,
): CarProgressTick | null {
  // Cleared before anything can fail and written last, so it is null on the
  // next tick unless this one read every car: a refused gate and a throw in
  // the loop both read as "no previous tick".
  const previousSessionTime = slice.lastReadSessionTime;

  slice.lastReadSessionTime = null;

  const lc = telemetry.CarIdxLapCompleted as number[] | undefined;
  const pct = telemetry.CarIdxLapDistPct as number[] | undefined;
  // Finite, not merely numeric: `typeof NaN === "number"`, and a NaN session
  // time would be stamped into every trace and surface as a NaN gap.
  const rawSessionTime = telemetry.SessionTime;
  const sessionTime = typeof rawSessionTime === "number" && Number.isFinite(rawSessionTime) ? rawSessionTime : null;
  const playerRacing = !(typeof telemetry.LapCompleted === "number" && telemetry.LapCompleted < 0);

  if (
    !isRaceSession ||
    !Array.isArray(lc) ||
    !Array.isArray(pct) ||
    sessionTime === null ||
    playerCarIdx < 0 ||
    frozenPositions === null ||
    isPreGreen(telemetry) ||
    !playerRacing
  ) {
    slice.lastProgress.length = 0;
    slice.lastProgressConfirmed.length = 0;

    return null;
  }

  const carCount = Math.min(lc.length, pct.length);
  // The correction reads only across a short gap since the last read
  // (CAR_PROGRESS_LINE_MAX_SPAN_S); otherwise every reading stands as it is.
  const correctionBaseline = withinCorrectionSpan(previousSessionTime, sessionTime);
  const progress = new Array<number | null>(carCount).fill(null);
  const traceReset = new Array<boolean>(carCount).fill(false);

  for (let i = 0; i < carCount; i++) {
    const laps = lc[i]!;
    const dist = pct[i]!;

    // Finite check first: `NaN < 0` is false, so a bare range guard lets a
    // NaN sample through — and a NaN in a trace is permanent, since every
    // comparison in `appendProgressSample` (backwards reset, dedupe, prune)
    // is false against it. The trace would then grow unbounded and every
    // crossing-time lookup on it would return garbage.
    if (!Number.isFinite(laps) || !Number.isFinite(dist) || laps < 0 || dist < 0) {
      slice.lastProgress[i] = undefined;
      slice.lastProgressConfirmed[i] = false;
      continue;
    }

    const previous = slice.lastProgress[i];
    const previousConfirmed = slice.lastProgressConfirmed[i] === true;
    const carProgress = readCarProgress(correctionBaseline ? confirmedLastProgress(slice, i) : undefined, laps, dist);
    let trace = slice.traces[i];

    if (!trace) {
      trace = [];
      slice.traces[i] = trace;
    }

    progress[i] = carProgress;
    traceReset[i] = appendProgressSample(trace, carProgress, sessionTime) === "reset";
    // Confirmed when it continues the reading before it AND that one was
    // confirmed or this one is clear of the line: inside the guard band two
    // readings can agree with each other and both be a lap off (a
    // disagreement lasting two ticks), so agreement there confirms nothing.
    // After a gap past the span the reading is a first reading again: it
    // continues nothing, and confirms only on the next one.
    slice.lastProgressConfirmed[i] =
      correctionBaseline &&
      previous !== undefined &&
      Math.abs(carProgress - previous) <= CAR_PROGRESS_CONTINUOUS_LAPS &&
      (previousConfirmed || !isNearLine(dist));
    slice.lastProgress[i] = carProgress;
  }

  // A car the arrays no longer reach has no reading either.
  if (slice.lastProgress.length > carCount) slice.lastProgress.length = carCount;

  if (slice.lastProgressConfirmed.length > carCount) slice.lastProgressConfirmed.length = carCount;

  slice.lastReadSessionTime = sessionTime;

  return { sessionTime, previousSessionTime, progress, traceReset, traces: slice.traces };
}
