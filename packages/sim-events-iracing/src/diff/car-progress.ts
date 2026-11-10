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
  GAP_TRACE_MAX_STEP,
  isPreGreen,
  type ProgressTrace,
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
 * A car's race progress this tick, from its `CarIdxLapCompleted` and
 * `CarIdxLapDistPct` (both finite and non-negative) and the progress last
 * read for it (`undefined` = none).
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
 * used only when it is within `GAP_TRACE_MAX_STEP` of the last progress (the
 * car could have driven there) AND the fraction is within
 * {@link CAR_PROGRESS_LINE_GUARD_PCT} of the line (the only place the arrays
 * disagree). Anything else — a tow, a teleport to the pits, a counter rewound
 * mid-lap — is returned as the plain sum and stays the discontinuity it is.
 */
export function readCarProgress(previous: number | undefined, lapCompleted: number, lapDistPct: number): number {
  const raw = lapCompleted + lapDistPct;

  if (previous === undefined || Math.abs(raw - previous) <= 0.5) return raw;

  const nearLine = lapDistPct <= CAR_PROGRESS_LINE_GUARD_PCT || lapDistPct >= 1 - CAR_PROGRESS_LINE_GUARD_PCT;

  if (!nearLine) return raw;

  const candidate = lapDistPct + Math.round(previous - lapDistPct);

  return Math.abs(candidate - previous) <= GAP_TRACE_MAX_STEP ? candidate : raw;
}

/** One live tick's race progress for every car: what {@link stepCarProgress} read and did. */
export type CarProgressTick = {
  /** The tick's `SessionTime`, finite. */
  sessionTime: number;
  /**
   * Per car: its progress ({@link readCarProgress}: `CarIdxLapCompleted +
   * CarIdxLapDistPct`, corrected at the line) when both readings are finite
   * and non-negative, else null.
   */
  progress: readonly (number | null)[];
  /** Per car: true when this tick's sample reset the car's trace. */
  traceReset: readonly boolean[];
  /** The traces after this tick's samples (the slice's own array, read-only to consumers). */
  traces: readonly (ProgressTrace | undefined)[];
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
 * its last progress. `traceReset`
 * is true only where `appendProgressSample` answered `"reset"`: the reading
 * was a discontinuity (a backwards step, or a forward one past
 * `GAP_TRACE_MAX_STEP`), so the car's motion since its last sample was not
 * continuous.
 */
export function stepCarProgress(
  slice: CarProgressState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  playerCarIdx: number,
  /** The canonical live order this tick (`race-positions.md`); `null` = none, which fails the gate. */
  frozenPositions: readonly number[] | null,
): CarProgressTick | null {
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

    return null;
  }

  const carCount = Math.min(lc.length, pct.length);
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
      continue;
    }

    const carProgress = readCarProgress(slice.lastProgress[i], laps, dist);
    let trace = slice.traces[i];

    if (!trace) {
      trace = [];
      slice.traces[i] = trace;
    }

    progress[i] = carProgress;
    traceReset[i] = appendProgressSample(trace, carProgress, sessionTime) === "reset";
    slice.lastProgress[i] = carProgress;
  }

  // A car the arrays no longer reach has no reading either.
  if (slice.lastProgress.length > carCount) slice.lastProgress.length = carCount;

  return { sessionTime, progress, traceReset, traces: slice.traces };
}
