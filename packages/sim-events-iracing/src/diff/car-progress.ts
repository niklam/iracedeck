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
 * Which way a tick may lie from the last read and still be corrected against
 * it (issue #1682). `"forward"` — `0 <= since <= CAR_PROGRESS_LINE_MAX_SPAN_S`
 * — is the live rule: live telemetry only moves forward, so a tick dated
 * before the last read is a break. `"both"` — `|since| <= …` — is the replay
 * rule: a replay rewinds as often as it plays (the 2026-11-10 capture steps
 * `SessionTime` back 0.2 s a tick), and `readCarProgress` is symmetric, so a
 * rewind across the line is corrected like a forward crossing.
 */
export type CarProgressSpan = "forward" | "both";

/**
 * Whether a reading at `sessionTime` may be corrected against progress last
 * read at `lastReadSessionTime`: the one span rule every reader applies (the
 * live progress step and the translator's pair-gap reading forwards, the
 * replay step both ways; {@link CarProgressSpan}). `null` is no read.
 */
export function withinCorrectionSpan(
  lastReadSessionTime: number | null,
  sessionTime: number,
  span: CarProgressSpan = "forward",
): boolean {
  if (lastReadSessionTime === null) return false;

  const since = sessionTime - lastReadSessionTime;

  if (span === "both") return Math.abs(since) <= CAR_PROGRESS_LINE_MAX_SPAN_S;

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
 * A car's race progress this tick, from its `CarIdxLapCompleted` (finite and
 * non-negative) and `CarIdxLapDistPct` (finite, and a fraction by the
 * reader's policy: non-negative live, above `-LAP_FRACTION_LINE_TOLERANCE` on
 * a replay frame through `readLapFraction`, where a hair below zero is the
 * line and the sum stays continuous across it) and the CONFIRMED
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
 * used only when its lap count is exactly one off the counter's (the arrays
 * disagree by one step of the counter, never more), it is within
 * {@link CAR_PROGRESS_LINE_MAX_TICK_STEP} of the last progress (the car could
 * have driven there in a tick) AND the fraction is within
 * {@link CAR_PROGRESS_LINE_GUARD_PCT} of the line (the only place the arrays
 * disagree). Anything else — a tow, a teleport to the pits, a hop across the
 * line, a counter rewound mid-lap or by several laps at the line — is returned
 * as the plain sum and stays the discontinuity it is.
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

  const laps = Math.round(previous - lapDistPct);

  // The arrays disagree by one lap, never more: a counter several laps off is rewound.
  if (Math.abs(laps - lapCompleted) !== 1) return raw;

  const candidate = lapDistPct + laps;

  return Math.abs(candidate - previous) <= CAR_PROGRESS_LINE_MAX_TICK_STEP ? candidate : raw;
}

/**
 * Whether a lap fraction is within {@link CAR_PROGRESS_LINE_GUARD_PCT} of the
 * start/finish line, on either side: the only stretch where a car's lap
 * counter and lap fraction can disagree. A fraction a hair below zero (a
 * replay reading through `readLapFraction`) is near the line too.
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
 * readings that began inside the band and has not left it. The one rule for
 * every LIVE reader that puts a raw reading on the traces' scale through
 * {@link readCarProgress}: the step itself, and the translator's pair reading
 * (`getLiveGapBetween`).
 *
 * The replay step (`replay-progress.ts`, issue #1682) is the one exception, by
 * policy rather than by a rule of its own ({@link confirmsCarProgress} with
 * `confirmByRun`): there a run of three continuing readings at distinct
 * `SessionTime`s confirms too, because on pit road at pit speed a car sits
 * inside the band for hundreds of ticks before its crossing, and the
 * band-exit rule alone would leave that crossing uncorrected. The live step
 * keeps the band-exit rule; whether it adopts the run is #1742's call.
 */
export function confirmedLastProgress(slice: CarProgressState, carIdx: number): number | undefined {
  return slice.lastProgressConfirmed[carIdx] === true ? slice.lastProgress[carIdx] : undefined;
}

/**
 * How many consecutive continuing readings, each at a distinct `SessionTime`
 * and each a different progress from the one before, confirm a car's progress
 * under a policy with `confirmByRun` (issue #1682). The counter and the
 * fraction disagree for one tick in every capture, so three readings in a row
 * that each continue the one before cannot all be a lap off. A repeated
 * reading adds nothing, whatever the clock does: a paused saved replay
 * repeats its `SessionTime`, but arrays that stand still while `SessionTime`
 * runs on (an in-session replay paused at its live edge, where the arrays are
 * the replay's and the clock is live) repeat the reading, and either way one
 * frame, the disagreeing one included, must not confirm itself.
 */
export const CAR_PROGRESS_CONFIRM_RUN = 3;

/**
 * How a reader applies the one line-progress reading (issue #1682): the span
 * it corrects across, whether a run confirms, and which lap fractions are
 * readings at all. The rules are this module's; a policy only picks between
 * them. {@link LIVE_CAR_PROGRESS_POLICY} is the live step's; the replay step's
 * is `REPLAY_CAR_PROGRESS_POLICY` (`replay-progress.ts`).
 */
export type CarProgressPolicy = {
  /** Which way a tick may lie from the last read ({@link CarProgressSpan}). */
  readonly span: CarProgressSpan;
  /**
   * Whether {@link CAR_PROGRESS_CONFIRM_RUN} continuing readings at distinct
   * `SessionTime`s confirm a reading inside the line guard band.
   */
  readonly confirmByRun: boolean;
  /** A `CarIdxLapDistPct` as a reading, or `null` when it is none. */
  readonly readLapFraction: (value: unknown) => number | null;
};

/**
 * The live lap-fraction test: finite and non-negative. Kept deliberately
 * stricter than `readLapFraction` (`@iracedeck/iracing-sdk`), which takes a
 * hair below zero as the line, until #1742 decides the live readers together.
 */
function readNonNegativeLapFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The live car-progress step's policy (issue #1572): forward span, confirmed
 * only by continuing a confirmed reading or by a reading clear of the band,
 * and a non-negative lap fraction.
 */
export const LIVE_CAR_PROGRESS_POLICY: CarProgressPolicy = {
  span: "forward",
  confirmByRun: false,
  readLapFraction: readNonNegativeLapFraction,
};

/**
 * Whether a reading confirms its car's progress, so the next reading may be
 * corrected against it ({@link confirmedLastProgress}): it continues the last
 * reading (`continues`: inside the span and within half a lap) AND the last
 * was confirmed, or it was read clear of the line guard band, or — only under
 * a policy with `confirmByRun` — `run` (the consecutive continuing readings
 * at distinct `SessionTime`s that each moved, this one included) has reached
 * {@link CAR_PROGRESS_CONFIRM_RUN}. The one confirmation rule; a reader picks
 * only whether the run counts.
 */
export function confirmsCarProgress(
  continues: boolean,
  previousConfirmed: boolean,
  lapDistPct: number,
  run: number,
  policy: CarProgressPolicy,
): boolean {
  return (
    continues &&
    (previousConfirmed || !isNearLine(lapDistPct) || (policy.confirmByRun && run >= CAR_PROGRESS_CONFIRM_RUN))
  );
}

/** What the last read left for one car, as {@link readCarLineProgress} takes it. */
export type CarProgressMemory = {
  /** The progress last read, `undefined` = none. */
  readonly progress: number | undefined;
  /** Whether it was confirmed ({@link confirmsCarProgress}). */
  readonly confirmed: boolean;
  /** The continuing run it ended; 0 for a reader that keeps none. */
  readonly run: number;
};

/** What a tick says about every car's reading at once. */
export type CarProgressTickContext = {
  /** The tick lies within the policy's span of the last read ({@link withinCorrectionSpan}). */
  readonly inSpan: boolean;
  /** The tick's `SessionTime` differs from the last read's: a paused replay's repeat does not. */
  readonly distinctSessionTime: boolean;
};

/** One car's reading: its progress and the memory it leaves for the next tick. */
export type CarProgressReading = {
  /** `CarIdxLapCompleted + CarIdxLapDistPct`, corrected at the line ({@link readCarProgress}). */
  readonly progress: number;
  /** Whether it may be corrected against next tick ({@link confirmsCarProgress}). */
  readonly confirmed: boolean;
  /** The continuing run it ends ({@link CarProgressMemory.run}). */
  readonly run: number;
};

/**
 * One car's line progress this tick (issue #1682): the ONE per-car reading
 * every progress step applies, the live step and the replay step alike. A
 * reading is valid when `CarIdxLapCompleted` is finite and non-negative and
 * the policy reads `CarIdxLapDistPct` as a fraction; otherwise `null`, and
 * the caller drops the car's memory. A valid one is {@link readCarProgress}
 * against the last progress when that is confirmed and the tick is inside the
 * span, then judged by {@link confirmsCarProgress}. It continues the last
 * reading when the tick is inside the span and it lies within half a lap of
 * it; the run grows by one only at a distinct `SessionTime` AND a progress
 * other than the last (a repeated reading is the same frame again), and a
 * reading that continues nothing starts it again at 0.
 */
export function readCarLineProgress(
  lapCompleted: unknown,
  lapDistPct: unknown,
  last: CarProgressMemory,
  tick: CarProgressTickContext,
  policy: CarProgressPolicy,
): CarProgressReading | null {
  const fraction = policy.readLapFraction(lapDistPct);

  // Finite check first: `NaN < 0` is false, so a bare range guard lets a NaN
  // sample through — and a NaN in a trace is permanent, since every
  // comparison in `appendProgressSample` (backwards reset, dedupe, prune) is
  // false against it.
  if (typeof lapCompleted !== "number" || !Number.isFinite(lapCompleted) || lapCompleted < 0 || fraction === null) {
    return null;
  }

  const progress = readCarProgress(tick.inSpan && last.confirmed ? last.progress : undefined, lapCompleted, fraction);
  // After a gap past the span the reading is a first reading again: it
  // continues nothing, and confirms only on a later one.
  const continues =
    tick.inSpan && last.progress !== undefined && Math.abs(progress - last.progress) <= CAR_PROGRESS_CONTINUOUS_LAPS;
  const moved = progress !== last.progress;
  const run = !continues ? 0 : tick.distinctSessionTime && moved ? last.run + 1 : last.run;

  return { progress, confirmed: confirmsCarProgress(continues, last.confirmed, fraction, run, policy), run };
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
  const tick: CarProgressTickContext = {
    inSpan: withinCorrectionSpan(previousSessionTime, sessionTime, LIVE_CAR_PROGRESS_POLICY.span),
    distinctSessionTime: sessionTime !== previousSessionTime,
  };
  const progress = new Array<number | null>(carCount).fill(null);
  const traceReset = new Array<boolean>(carCount).fill(false);

  for (let i = 0; i < carCount; i++) {
    // An invalid reading never reaches a trace: a NaN there would be
    // permanent, the trace would grow unbounded and every crossing-time lookup
    // on it would return garbage. The live policy keeps no run: inside the
    // guard band two readings can agree with each other and both be a lap off
    // (a disagreement lasting two ticks), so only a confirmed predecessor or a
    // reading clear of the line confirms.
    const reading = readCarLineProgress(
      lc[i],
      pct[i],
      { progress: slice.lastProgress[i], confirmed: slice.lastProgressConfirmed[i] === true, run: 0 },
      tick,
      LIVE_CAR_PROGRESS_POLICY,
    );

    if (reading === null) {
      slice.lastProgress[i] = undefined;
      slice.lastProgressConfirmed[i] = false;
      continue;
    }

    let trace = slice.traces[i];

    if (!trace) {
      trace = [];
      slice.traces[i] = trace;
    }

    progress[i] = reading.progress;
    traceReset[i] = appendProgressSample(trace, reading.progress, sessionTime) === "reset";
    slice.lastProgressConfirmed[i] = reading.confirmed;
    slice.lastProgress[i] = reading.progress;
  }

  // A car the arrays no longer reach has no reading either.
  if (slice.lastProgress.length > carCount) slice.lastProgress.length = carCount;

  if (slice.lastProgressConfirmed.length > carCount) slice.lastProgressConfirmed.length = carCount;

  slice.lastReadSessionTime = sessionTime;

  return { sessionTime, previousSessionTime, progress, traceReset, traces: slice.traces };
}
