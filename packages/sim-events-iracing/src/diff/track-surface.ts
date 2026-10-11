/**
 * The one statement of "this car is on the circuit, not in the pits" that the
 * diffs share: its `CarIdxTrackSurface` reads `OnTrack` or `OffTrack`.
 *
 * Three diffs ask it, and each used to carry a private copy — the opponent-pit
 * diff for the surface a pit entry starts from (#1212), the caution diff for
 * the pace car reaching and leaving the road (#1127), and the caution-gap
 * measurement for which cars count towards a spacing (#1168). The last two
 * are the same question about the same car: `paceCar.off` and the catch-up
 * call standing down for a pace car that has left must never be decided by
 * two tests that could drift apart.
 *
 * Per-car pit state comes from here and never from `CarIdxOnPitRoad`, which
 * real telemetry shows reading true for cars on the racing surface and for
 * empty slots alike (`diff/race-finish.ts`, `diff/opponent-pit.ts`).
 */
import { TrkLoc } from "@iracedeck/iracing-sdk";

/**
 * Whether a `CarIdxTrackSurface` value is a surface of the circuit: the
 * racing surface or the ground beside it. The pit surfaces (`InPitStall`,
 * `AproachingPits`) and `NotInWorld` are not, and neither is a value that
 * could not be read at all.
 */
export function isRacingSurface(surface: unknown): boolean {
  return surface === TrkLoc.OnTrack || surface === TrkLoc.OffTrack;
}
