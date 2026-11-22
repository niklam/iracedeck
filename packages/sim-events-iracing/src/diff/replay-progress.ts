/**
 * The per-tick replay-progress step (issue #1682).
 *
 * On a replay frame the canonical order cannot use the live freeze
 * (`updatePositionTracking`): the translator's replay guard returns before it,
 * by design since #603, because a scrubbed timeline breaks the forward-motion
 * assumption the freeze rests on. Ranked by the raw `CarIdxLapCompleted +
 * CarIdxLapDistPct`, though, a car whose two arrays disagree for a tick at the
 * start/finish line (#1572) ranks a lap ahead or behind for that tick: in the
 * 2026-11-10 replay capture the camera car blinked P5 → P6 → P5 nine times.
 *
 * So every tick the replay guard swallows reads each car once through the one
 * line-progress reading (`readCarLineProgress` in `car-progress.ts`) under the
 * replay policy below, against the per-car memory in the `replayProgress`
 * slice, and hands the readings back. The translator pairs them with the
 * telemetry object they were taken from (`replayReadings` on the instance), and
 * the canonical order ranks by them for that telemetry only
 * (`calculateCanonicalRacePositions`). It corrects the one-tick disagreement
 * at the line and holds nothing else.
 *
 * This module keeps only the step's ordering and its slice; every per-car rule
 * — validity, the correction, continuation, confirmation — is the core's, so
 * the live and the replay readings cannot drift apart except by the policy.
 * It publishes nothing.
 */
import { readLapFraction, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplayProgressState } from "../state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import {
  type CarProgressPolicy,
  type CarProgressTickContext,
  readCarLineProgress,
  withinCorrectionSpan,
} from "./car-progress.js";

/**
 * The replay step's policy (issue #1682), and why each choice differs from the
 * live one (`LIVE_CAR_PROGRESS_POLICY`):
 *
 * - **Both directions.** A replay rewinds as often as it plays (the capture
 *   steps `SessionTime` back 0.2 s a tick). The nine blinks are on forward
 *   ticks, but a forward-only span breaks every car's chain at each rewind
 *   tick, and the cars about to cross resume inside the band, where the
 *   band-exit rule never confirms them: under the live policy 8 of the 9 stay.
 * - **Confirmed by a run of three.** Car 4's crossing in the capture is on pit
 *   road at pit speed, inside the line guard band for the 400 ticks before it,
 *   so the band-exit rule never confirms it. Three continuing readings at
 *   distinct `SessionTime`s cannot all be a lap off when the disagreement lasts
 *   one tick; a repeated reading (a paused replay, or arrays standing still
 *   while the clock runs) adds nothing.
 * - **A hair below zero is the line.** Car 4 reads -0.00004 for a tick after
 *   its crossing; the raw `>= 0` test drops it from the order for that tick
 *   and moves every car behind it up. `readLapFraction` takes it as the line.
 */
export const REPLAY_CAR_PROGRESS_POLICY: CarProgressPolicy = {
  span: "both",
  confirmByRun: true,
  readLapFraction,
};

/** The unit runner's emit: the step publishes nothing. */
const noEmit = (): void => {};

/**
 * Read this replay frame's progress for every car, against the slice's
 * memory, and return it.
 *
 * Returns `null` — and drops every car's memory — when either progress array
 * is missing: there is nothing to rank, and the order falls back to its own
 * computation. Otherwise every car up to the shorter of the two arrays gets an
 * entry: its progress, or `null` for a reading the core takes as no reading
 * (a non-finite value, a negative lap count, a fraction `readLapFraction`
 * rejects, such as iRacing's `-1`), which also drops the car's memory.
 *
 * A reading is corrected against the car's confirmed last progress only when
 * the tick lies within `CAR_PROGRESS_LINE_MAX_SPAN_S` of the last read, either
 * way. A seek past that span, a non-finite `SessionTime`, or a tick after one
 * the step did not finish (it threw, or found no arrays) leaves every reading
 * uncorrected and unconfirmed: it continues nothing, and the run rebuilds from
 * it. `lastReadSessionTime` is cleared on entry and written only once the loop
 * has completed, which is what makes a throw read as "no previous tick".
 *
 * Each car runs as a unit (`runUnit`, #1559; the package's per-car rule): its
 * memory is dropped before the unit and written last inside it, so a car whose
 * unit throws has no reading this tick (`null`, ranked as absent) and starts
 * again as a first reading on the next, while every other car keeps its
 * reading and the order still ranks the frame from the readings.
 */
export function stepReplayProgress(
  slice: ReplayProgressState,
  telemetry: TelemetryData,
  /** The translator hands `steps.runUnit`; the default catches nothing, so these tests stay loud. */
  runUnit: UnitRunner = runUnitsDirectly,
  /**
   * @internal The policy, for the tests that show each of its choices is
   * load-bearing; the translator never passes one.
   */
  policy: CarProgressPolicy = REPLAY_CAR_PROGRESS_POLICY,
): (number | null)[] | null {
  const previousSessionTime = slice.lastReadSessionTime;

  slice.lastReadSessionTime = null;

  const lc = telemetry.CarIdxLapCompleted as unknown[] | undefined;
  const pct = telemetry.CarIdxLapDistPct as unknown[] | undefined;

  if (!Array.isArray(lc) || !Array.isArray(pct)) {
    slice.lastProgress.length = 0;
    slice.lastProgressConfirmed.length = 0;
    slice.continuingRun.length = 0;

    return null;
  }

  const rawSessionTime = telemetry.SessionTime;
  const sessionTime = typeof rawSessionTime === "number" && Number.isFinite(rawSessionTime) ? rawSessionTime : null;
  const tick: CarProgressTickContext = {
    inSpan: sessionTime !== null && withinCorrectionSpan(previousSessionTime, sessionTime, policy.span),
    distinctSessionTime: sessionTime !== previousSessionTime,
  };
  const carCount = Math.min(lc.length, pct.length);
  const progress = new Array<number | null>(carCount).fill(null);

  for (let i = 0; i < carCount; i++) {
    const last = {
      progress: slice.lastProgress[i],
      confirmed: slice.lastProgressConfirmed[i] === true,
      run: slice.continuingRun[i] ?? 0,
    };

    // Withheld until the unit completes: a car whose unit throws has no
    // memory on the next tick, so its next reading is a first one.
    slice.lastProgress[i] = undefined;
    slice.lastProgressConfirmed[i] = false;
    slice.continuingRun[i] = 0;

    runUnit<never>(noEmit, () => {
      const reading = readCarLineProgress(lc[i], pct[i], last, tick, policy);

      if (reading === null) return;

      progress[i] = reading.progress;
      slice.lastProgress[i] = reading.progress;
      slice.lastProgressConfirmed[i] = reading.confirmed;
      slice.continuingRun[i] = reading.run;
    });
  }

  // A car the arrays no longer reach has no reading either.
  if (slice.lastProgress.length > carCount) slice.lastProgress.length = carCount;

  if (slice.lastProgressConfirmed.length > carCount) slice.lastProgressConfirmed.length = carCount;

  if (slice.continuingRun.length > carCount) slice.continuingRun.length = carCount;

  slice.lastReadSessionTime = sessionTime;

  return progress;
}
