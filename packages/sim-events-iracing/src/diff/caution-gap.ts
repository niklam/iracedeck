/**
 * How far the player has dropped back from the car he lines up behind under a
 * full-course caution, judged against the pack's own spacing (issue #1168).
 * The stateless sibling of `pace-lineup.ts`: one tick in, one measurement out,
 * no state and no emission. What is DONE with it — the thresholds, the dwell,
 * the reminders, the suppressions — is the episode machine's, `diffCatchUp` in
 * `diff/caution.ts`, and the live reader's, `getCautionGap()`.
 *
 * Every rule here was measured, not assumed, on nine snapshots at two ovals:
 * five at Homestead (2,381.5 m, 2026-09-19) and four at a second oval
 * (1,570.7 m, 2026-10-02), committed as `__fixtures__/caution-gap-20260919.json`
 * (with `caution-lineup-20260919.json` for the fifth) and
 * `__fixtures__/caution-gap-20261002.json`.
 *
 * **The gap is a ratio, not a distance.** iRacing's pacing keeps SOME spacing —
 * a formed pack read 9.9–10.1 m car to car, double file, in both sessions at
 * Homestead, and 10.0–10.5 m single file at the second, shorter oval — and
 * the ratio of the player's gap to that spacing is the same
 * whether the sim holds a fixed distance or a fixed time. A threshold in metres
 * or seconds would have to guess which. On the evidence the ratio separates
 * the cases cleanly: every "in place" reading is at most 1.3× and every
 * "dropped back" reading at least 3.4×, with one reading between them, 1.9×,
 * from a car still closing up eight seconds after a double-file re-form.
 *
 * **Not a time gap at your own speed.** In `093306` the player was already
 * accelerating to close — 34.6 m/s against the field's ~29.3 — so the same
 * 36.5 m read 1.06 s by his speed and 1.25 s by the field's. A driver closing
 * hardest reads as the smallest gap, and a stopped car divides by nearly zero.
 *
 * **Measured to the car the lineup names, never to the nearest car.**
 * `CarDistAhead` is the nearest car physically ahead in ANY lane: in `131947`
 * it reads 2.2 m to the car alongside in the other lane while the car ahead in
 * the player's own lane is 11.9 m up, and in `094029` it reads 0.5 m to a car
 * being passed. It agrees with the in-line gap only single file, where the two
 * are the same car. The gap here is `forwardGapMeters` between the player and
 * `lineup.followCarIdx` — a pairwise distance between two cars the lineup has
 * already identified, so nothing is ranked by lap distance and
 * `@.claude/rules/race-positions.md`'s rule against that is untouched.
 *
 * **The pack spacing is the median in-line gap, both lines pooled**, over
 * every pair of a car and the car it follows under the lineup's own rule
 * ({@link resolveCarAheadInLine} — the one function the lineup itself calls for
 * the player, so the two can never pair different cars). Two kinds of pair are
 * left out: each line's pair with the pace car, which the pace car keeps at
 * about twice the pack's spacing (19.3–20.9 m against 10 m across all nine
 * snapshots, both lanes); and the player's own pair, which is the thing being
 * judged. The pair of the car BEHIND the player and the player stays in. The
 * median of an even count is the mean of the middle two. A pair counts only
 * when both cars are on a track surface — `CarIdxTrackSurface` reading
 * `OnTrack` or `OffTrack`, never `CarIdxOnPitRoad`, which reads true for
 * slots 18–37 in every snapshot, two racing cars and eighteen empty slots
 * among them — and both are in the world.
 *
 * **Fewer than {@link CATCH_UP_MIN_SPACING_SAMPLES} pairs is no reading**:
 * silence, not a guess. That costs a field of five cars or fewer.
 *
 * **A pair with the pace car is judged against
 * {@link CATCH_UP_PACE_CAR_SPACING_FACTOR} × the spacing**, for the same
 * measured reason: the leader, and the outside front-row car double file, sit
 * at about 20 m of normal rather than 10 m.
 *
 * **A waving field is not a pack.** In `094029` the other cars' gaps run from
 * 4.8 m to 284 m, median 24.9 m. The measurement still returns its numbers
 * there — the drive-round latch reads them in every caution phase — and
 * whether a spacing MEANS anything is the phase's question, which the machine
 * and the reader ask.
 *
 * **On a grid-anchored tick this is never asked.** Catch-up is live only in a
 * caution phase: the diff calls this only inside one, and the reader's
 * `warranted` requires one. Handed a rolling-start formation it would pair the
 * cars the same way — the follow rule does not depend on the frame — and
 * return a spacing; nothing reads it, and a catch-up call in a formation is a
 * decision nobody has made.
 *
 * It never resolves the lineup: it is handed the one the caller already has,
 * so a tick that judges the gap resolves the lineup exactly once.
 */
import { carInWorld, forwardGapMeters, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import { resolvePaceCarIdx } from "./pace-laps.js";
import { type PaceLineup, type PaceLineupFlags, resolveCarAheadInLine, resolvePlayerCarIdx } from "./pace-lineup.js";

/**
 * What a pair with the pace car is judged against, as a multiple of the pack
 * spacing. Not one of capture C1's: it is the measured ratio itself — the pace
 * car's first car sat 19.3–20.9 m back in all nine snapshots, both lanes and
 * both ovals, which is 1.8–2.0× a formed pack's 10.0–10.7 m — rounded to 2. A
 * capture that shows a pace car pacing closer or further than that moves it.
 */
export const CATCH_UP_PACE_CAR_SPACING_FACTOR = 2;

/**
 * How many pairs a pack spacing needs before it is a reading. Not one of
 * capture C1's either: it is a floor on what a median may be taken over, and
 * four is the fewest for which one stray gap cannot BE the median. Every
 * measured field gave 17 or 18.
 */
export const CATCH_UP_MIN_SPACING_SAMPLES = 4;

/** One tick's catch-up measurement. Every number is `null` where it cannot be read. */
export type CautionGapMeasurement = {
  /** The car the gap is measured to: the lineup's `followCarIdx`, the pace car included. */
  followCarIdx: number | null;
  /** Forward distance from the player to that car, in metres — up to a full lap. */
  gapMeters: number | null;
  /** The median in-line gap of the rest of the field. `null` below {@link CATCH_UP_MIN_SPACING_SAMPLES} pairs. */
  packSpacingMeters: number | null;
  /** How many pairs that median was taken over — reported even when it is too few. */
  spacingSamples: number;
  /**
   * What the gap is judged against: the pack spacing, or
   * {@link CATCH_UP_PACE_CAR_SPACING_FACTOR} × it when the car ahead is the pace car.
   */
  referenceMeters: number | null;
  /** `gapMeters / referenceMeters` — the number the thresholds are multiples of. */
  ratio: number | null;
  /**
   * The car to follow is nearer BEHIND the player than ahead: the forward gap
   * is over half a lap. He is ahead of his slot, and "catch" is the wrong word
   * for a car he must let by. False when the gap cannot be read.
   */
  aheadOfSlot: boolean;
  /**
   * The pace car is on the road — its `CarIdxTrackSurface` reads `OnTrack` or
   * `OffTrack`. False once it has peeled off for pit road, and false when
   * session info names no pace car or the tick carries no surfaces: a pace car
   * that cannot be seen is not one to close up behind.
   */
  paceCarOnTrack: boolean;
  /** The player's decoded pace flags, as the lineup carries them. */
  paceFlags: PaceLineupFlags;
};

/** The median of a non-empty list; the mean of the middle two for an even count. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;

  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measure the player's gap to the car he follows against the pack's spacing,
 * on one tick. `lineup` is the tick's ALREADY-RESOLVED pace lineup — this
 * function never resolves one — and `sessionInfo` is read only for which car
 * is the player and which the pace car.
 */
export function measureCautionGap(
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  lineup: PaceLineup,
  trackLengthMeters: number | null,
): CautionGapMeasurement {
  const lines = telemetry.CarIdxPaceLine as unknown;
  const rows = telemetry.CarIdxPaceRow as unknown;
  const surfaces = telemetry.CarIdxTrackSurface as unknown;
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);

  // Per-car pit state from the track surface, never `CarIdxOnPitRoad` (module
  // comment). A surface that cannot be read is not a track surface.
  const onTrackSurface = (carIdx: number): boolean => {
    const surface = Array.isArray(surfaces) ? (surfaces[carIdx] as unknown) : undefined;

    return surface === TrkLoc.OnTrack || surface === TrkLoc.OffTrack;
  };

  const followCarIdx = lineup.followCarIdx;
  const gapMeters =
    playerCarIdx !== null && followCarIdx !== null && onTrackSurface(playerCarIdx) && onTrackSurface(followCarIdx)
      ? forwardGapMeters(telemetry, playerCarIdx, followCarIdx, trackLengthMeters)
      : null;

  const gaps: number[] = [];

  if (Array.isArray(lines) && Array.isArray(rows)) {
    const inWorld = carInWorld(telemetry);

    for (let carIdx = 0; carIdx < rows.length; carIdx++) {
      // The player's own pair is the one being judged; the pace car follows nobody.
      if (carIdx === playerCarIdx || carIdx === paceCarIdx) continue;

      const aheadCarIdx = resolveCarAheadInLine(lines, rows, carIdx, inWorld);

      // Nobody ahead in the line, or the pace car: this line's pair with the
      // pace car, which is kept at twice the spacing and has its own reference.
      if (aheadCarIdx === null || aheadCarIdx === paceCarIdx) continue;

      if (!onTrackSurface(carIdx) || !onTrackSurface(aheadCarIdx)) continue;

      const gap = forwardGapMeters(telemetry, carIdx, aheadCarIdx, trackLengthMeters);

      if (gap !== null) gaps.push(gap);
    }
  }

  const packSpacingMeters = gaps.length >= CATCH_UP_MIN_SPACING_SAMPLES ? median(gaps) : null;
  const referenceMeters =
    packSpacingMeters === null
      ? null
      : packSpacingMeters * (lineup.followsPaceCar ? CATCH_UP_PACE_CAR_SPACING_FACTOR : 1);

  return {
    followCarIdx,
    gapMeters,
    packSpacingMeters,
    spacingSamples: gaps.length,
    referenceMeters,
    ratio: gapMeters !== null && referenceMeters !== null && referenceMeters > 0 ? gapMeters / referenceMeters : null,
    aheadOfSlot: gapMeters !== null && trackLengthMeters !== null && gapMeters > trackLengthMeters / 2,
    paceCarOnTrack: paceCarIdx !== null && onTrackSurface(paceCarIdx),
    paceFlags: lineup.paceFlags,
  };
}
