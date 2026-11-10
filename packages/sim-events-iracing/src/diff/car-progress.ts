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
 * It publishes nothing. All math on a trace lives in `@iracedeck/iracing-sdk`
 * `gap-utils.ts`; this module only sequences it against its slice.
 */
import { appendProgressSample, isPreGreen, type ProgressTrace, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { CarProgressState } from "../state.js";

/** One live tick's race progress for every car: what {@link stepCarProgress} read and did. */
export type CarProgressTick = {
  /** The tick's `SessionTime`, finite. */
  sessionTime: number;
  /** Per car: `CarIdxLapCompleted + CarIdxLapDistPct` when both are finite and non-negative, else null. */
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
 * history, and a session change recreates the whole state anyway.
 *
 * Otherwise every car up to the shorter of the two arrays gets an entry: its
 * progress, or `null` for a reading that is not finite or is negative (a car
 * out of the world reads `-1`), which leaves its trace untouched. `traceReset`
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
    if (!Number.isFinite(laps) || !Number.isFinite(dist) || laps < 0 || dist < 0) continue;

    let trace = slice.traces[i];

    if (!trace) {
      trace = [];
      slice.traces[i] = trace;
    }

    progress[i] = laps + dist;
    traceReset[i] = appendProgressSample(trace, laps + dist, sessionTime) === "reset";
  }

  return { sessionTime, progress, traceReset, traces: slice.traces };
}
