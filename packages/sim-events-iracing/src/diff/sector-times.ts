/**
 * The sector timer (issue #1572).
 *
 * iRacing reports no sector time for any car, so they are measured here: for
 * every car, the moment it crossed each of the track's sector starts is
 * interpolated between two consecutive progress ticks (`stepCarProgress`'s
 * `CarProgressTick`), and a lap's sector times are the differences of those
 * moments. One tick is 1/60 s anywhere on the lap, which is what the claimed
 * resolution rests on; the progress traces' own samples are 0.002 lap apart,
 * far too coarse through a slow corner (the #1572 spec's decision 3).
 *
 * **What is measured.** With a car's reading `(p0, t0)` from the last tick
 * the timer consumed and `(p1, t1)` from this one, every boundary
 * `b = L + starts[k]` (whole lap `L`, sector start `k`) in `(p0, p1]` was
 * crossed at `t0 + (b - p0) / (p1 - p0) × (t1 - t0)`. A step that crosses
 * several boundaries handles each, in order. Progress counts laps, so the
 * start/finish line is the whole-number boundary (`starts[0]` is 0) and needs
 * no wrap arithmetic: crossing it closes one lap and opens the next at the
 * same interpolated time.
 *
 * **What is never measured across.** A car's two readings are bridged only
 * when its motion between them is known to be continuous:
 *
 * - the tick names the timer's last consumed tick as the one read directly
 *   before it (`tick.previousSessionTime === slice.lastSessionTime`, the
 *   continuity rule documented on `CarProgressTick`);
 * - the two ticks are at most {@link SECTOR_MAX_TICK_SPAN_S} apart, and not
 *   backwards, in `SessionTime`;
 * - the car's trace was not reset by this tick's reading (`traceReset`), and
 *   the car has a reading on both ticks.
 *
 * Anything else is a break: the car's lap in progress is dropped, not
 * recorded, and only this tick's reading is kept for the next. So a missing
 * lap is possible and a wrong time is not.
 *
 * **Laps.** A lap opens only at a measured start/finish crossing, so after a
 * break every crossing before the next line crossing is discarded, and the
 * lap after that line is the next one recorded. Its number is the car's
 * completed-lap count once it is done: the lap from progress `L - 1` to `L`
 * is lap `L`, the number `lap.completed` carries for the player, and the
 * race's opening lap is 1. A crossing out of sequence (a car that rolled back
 * over a sector start and crossed it again) drops the lap as a break does.
 * A step backwards that crosses nothing is just a slow lap.
 *
 * **Clean laps** (decision 4), one rule for every car, the player included:
 * a lap is recorded with `clean: false` when any tick of it read the car's
 * `CarIdxTrackSurface` as anything but `OnTrack` (off track, the pit lane,
 * the stall, out of the world, or unreadable), when a full-course caution was
 * out on any tick of it, when it is the race's opening lap, or when one of
 * its sector times is not positive. An unclean lap is still recorded with its
 * times, so a consumer can tell "no lap" from "a lap that does not count".
 * The tick a car crosses the line on belongs to both laps.
 *
 * It publishes nothing, and nothing here averages, picks or compares: the
 * reference, the thresholds and the cadence are the catalog's (decision 5).
 */
import { type StandingsNeighbors, TrkLoc } from "@iracedeck/iracing-sdk";

import type { SectorLap, SectorLapInProgress, SectorTimesState } from "../state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import type { CarProgressTick } from "./car-progress.js";

/**
 * How many completed laps the timer keeps per car, newest last. A storage
 * bound, not a policy: at least the window any consumer reads (the catalog's
 * is five) with room for another.
 */
export const SECTOR_HISTORY_LAPS = 8;

/**
 * The widest `SessionTime` gap (seconds) between two consecutive progress
 * ticks a crossing is interpolated across. A wider one is dropped telemetry:
 * the crossing is left unmeasured and the lap unrecorded rather than blurred.
 */
export const SECTOR_MAX_TICK_SPAN_S = 0.25;

/** The unit runner's emit, for a diff that publishes nothing. */
const noEmit = (): void => {};

/**
 * Advance every car's sector timing by one tick, and record the cars the
 * player is compared with.
 *
 * A `null` tick (the progress step's gate refused it, or the step threw) and a
 * track with no sectors record nothing and keep no bridge: every lap in
 * progress and every previous reading is dropped, so nothing is measured
 * across the gap. The completed laps stay.
 *
 * Each car runs as a unit (`runUnit`, #1559): a car whose unit throws loses
 * its lap in progress and its bridge, and the other cars commit. The baseline
 * is written last: a car's previous reading at the end of its unit, the
 * consumed tick's `SessionTime` once every car has run.
 */
export function diffSectorTimes(
  slice: SectorTimesState,
  /** This tick's progress readings, as `stepCarProgress` returned them; `null` = none read. */
  tick: CarProgressTick | null,
  /**
   * The track's sector start fractions (`extractSectorStarts`' output,
   * `[0, s1, …]`), as the translator's `resolveTrackSectorsCached` resolved
   * them this tick; `null` = the track has none it can count from the line.
   */
  sectorStarts: readonly number[] | null,
  /** The tick's `CarIdxTrackSurface`; a car it does not reach reads as not on track. */
  carIdxTrackSurface: readonly number[] | undefined,
  /**
   * Whether a full-course caution is out this tick: the translator's
   * `cautionPhase !== "none"`, read after `diffCaution` ran, so it is the
   * phase this tick settled.
   */
  underFullCourseCaution: boolean,
  /**
   * The class neighbours and class leader `diffGaps` resolved this tick from
   * the canonical order, as it returned them; `null` (or `undefined`) = none
   * resolved, or `diffGaps` threw. Recorded as they are; what a call may name
   * is the catalog's decision.
   */
  neighbours: StandingsNeighbors | null | undefined,
  runUnit: UnitRunner = runUnitsDirectly,
): void {
  // Cleared before anything can fail and written last, so a tick this diff
  // threw on reads as "no previous tick" on the next one.
  const lastSessionTime = slice.lastSessionTime;

  slice.lastSessionTime = null;
  slice.sectorCount = null;

  slice.targets.leaderIdx = tick === null ? -1 : (neighbours?.leaderIdx ?? -1);
  slice.targets.aheadIdx = tick === null ? -1 : (neighbours?.aheadIdx ?? -1);
  slice.targets.behindIdx = tick === null ? -1 : (neighbours?.behindIdx ?? -1);

  if (tick === null || sectorStarts === null || sectorStarts.length === 0) {
    slice.lastProgress.length = 0;
    slice.lapInProgress.length = 0;

    return;
  }

  // The sector count every lap below is measured against, for the reader.
  slice.sectorCount = sectorStarts.length;

  const t1 = tick.sessionTime;
  const span = lastSessionTime === null ? null : t1 - lastSessionTime;
  // The last consumed tick, when this one may be bridged from it; else null.
  const t0 =
    span !== null && tick.previousSessionTime === lastSessionTime && span >= 0 && span <= SECTOR_MAX_TICK_SPAN_S
      ? lastSessionTime
      : null;
  const carCount = tick.progress.length;

  // A car the tick no longer reaches has no reading, and so no lap.
  if (slice.lastProgress.length > carCount) slice.lastProgress.length = carCount;

  if (slice.lapInProgress.length > carCount) slice.lapInProgress.length = carCount;

  for (let i = 0; i < carCount; i++) {
    const p0 = slice.lastProgress[i] ?? null;
    const p1 = tick.progress[i] ?? null;

    // Withheld until the unit completes: a car whose unit throws has no
    // bridge on the next tick, which drops whatever the throw left of its lap.
    slice.lastProgress[i] = null;

    runUnit<never>(noEmit, () => {
      if (t0 === null || p0 === null || p1 === null || tick.traceReset[i] === true) {
        slice.lapInProgress[i] = null;
      } else {
        const unclean = underFullCourseCaution || carIdxTrackSurface?.[i] !== TrkLoc.OnTrack;

        slice.lapInProgress[i] = stepCar(
          slice,
          i,
          slice.lapInProgress[i] ?? null,
          p0,
          t0,
          p1,
          t1,
          sectorStarts,
          unclean,
        );
      }

      slice.lastProgress[i] = p1;
    });
  }

  slice.lastSessionTime = t1;
}

/**
 * One car's bridged step from `(p0, t0)` to `(p1, t1)`: mark the lap in
 * progress with this tick's cleanliness, then handle every boundary in
 * `(p0, p1]` in order. Returns the lap in progress afterwards.
 */
function stepCar(
  slice: SectorTimesState,
  carIdx: number,
  lapInProgress: SectorLapInProgress | null,
  p0: number,
  t0: number,
  p1: number,
  t1: number,
  sectorStarts: readonly number[],
  unclean: boolean,
): SectorLapInProgress | null {
  let lap = lapInProgress;

  if (lap !== null && unclean) lap.clean = false;

  // Standing still or rolling back crosses nothing forwards.
  if (p1 <= p0) return lap;

  const sectorCount = sectorStarts.length;
  const lastLap = Math.floor(p1);

  for (let wholeLaps = Math.floor(p0); wholeLaps <= lastLap; wholeLaps++) {
    for (let sector = 0; sector < sectorCount; sector++) {
      const boundary = wholeLaps + sectorStarts[sector]!;

      if (boundary <= p0) continue;

      // The boundaries ascend, across laps too, so none further on is in reach.
      if (boundary > p1) return lap;

      const crossedAt = t0 + ((boundary - p0) / (p1 - p0)) * (t1 - t0);

      if (sector === 0) {
        // The line: close the lap that ran up to it, when it was measured
        // whole, and open the next at the same time.
        if (lap !== null && lap.lap === wholeLaps && lap.crossings.length === sectorCount) {
          recordLap(slice, carIdx, lap, crossedAt);
        }

        lap = { lap: wholeLaps + 1, crossings: [crossedAt], clean: !unclean };
      } else if (lap !== null) {
        // A sector start is taken only in sequence; anything else (crossed
        // twice after a roll back, a lap that is not this one) breaks the lap.
        if (lap.lap === wholeLaps + 1 && lap.crossings.length === sector) lap.crossings.push(crossedAt);
        else lap = null;
      }
    }
  }

  return lap;
}

/** Record a lap closed at `closedAt`, keeping the car's newest {@link SECTOR_HISTORY_LAPS}. */
function recordLap(slice: SectorTimesState, carIdx: number, lap: SectorLapInProgress, closedAt: number): void {
  const sectorTimes: number[] = [];
  let everySectorPositive = true;

  for (let sector = 0; sector < lap.crossings.length; sector++) {
    const end = sector + 1 < lap.crossings.length ? lap.crossings[sector + 1]! : closedAt;
    const time = end - lap.crossings[sector]!;

    // Written as a positive test so a NaN counts as not positive.
    if (!(time > 0)) everySectorPositive = false;

    sectorTimes.push(time);
  }

  const recorded: SectorLap = {
    lap: lap.lap,
    sectorTimes,
    // Lap 1 is the race's opening lap, which a start queue inflates.
    clean: lap.clean && lap.lap > 1 && everySectorPositive,
  };
  let laps = slice.completedLaps[carIdx];

  if (laps === undefined) {
    laps = [];
    slice.completedLaps[carIdx] = laps;
  }

  laps.push(recorded);

  if (laps.length > SECTOR_HISTORY_LAPS) laps.splice(0, laps.length - SECTOR_HISTORY_LAPS);
}
