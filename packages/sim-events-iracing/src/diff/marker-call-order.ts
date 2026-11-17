/**
 * The publish order of a sector-start call and a corner name that come due on
 * one tick (issue #1676).
 *
 * Both calls are timed by the one lead-point sweep (`lead-point-sweep.ts`),
 * each diff over its own starts, and the voice bus plays them in publish
 * order. The translator runs `diffSectorStart` before `diffCornerName`
 * (`TICK_ORDER`), which is the right order for a corner at the sector line,
 * the one a one-frame tick sweeps both of. A wider tick (an event-loop stall:
 * the sweep accepts up to `CORNER_TELEPORT_THRESHOLD`, 0.05 of a lap, per tick)
 * can hold a corner marker BEFORE the sector start, and then the car reached
 * the corner first. So each diff returns how far behind this tick's lead point
 * the start it published sits ({@link lapFractionBehind}), and
 * {@link orderMarkerCalls} puts the corner name first when its marker is the
 * further behind. A tie, a corner at the sector line, stays with the sector
 * call.
 */
import type { PendingEvent } from "./types.js";

/**
 * How far behind `leadPoint` the start at `start` sits, as a lap fraction in
 * [0, 1), across the start/finish line: what a diff that published a crossing
 * of `start` this tick returns. Two starts at the same point give the same
 * answer, to the bit.
 *
 * @param leadPoint this tick's lead point, in [0, 1)
 * @param start the crossed start, in [0, 1)
 */
export function lapFractionBehind(leadPoint: number, start: number): number {
  return (leadPoint - start + 1) % 1;
}

/**
 * Put the corner name ahead of the sector-start call when its marker was
 * crossed first; leave every other case as it is.
 *
 * `pending` from `from` on is what `diffSectorStart` and `diffCornerName`
 * pushed this tick, in that order. The two are swapped only when both
 * published (neither value `null`), the corner's value is strictly larger (its
 * marker sits further behind the lead point, so the car reached it first) and
 * the slice is exactly the sector event then the corner event. A tie goes to
 * the sector call. A step that threw has had its events truncated out of
 * `pending` by the step boundary and never returned a value, so it reads as
 * `null`, and the slice check leaves anything unexpected alone.
 *
 * @param pending the tick's pending list, reordered in place
 * @param from `pending`'s length before `diffSectorStart` ran
 * @param sectorBehind what `diffSectorStart` returned, `null` when it
 *   published nothing or threw
 * @param cornerBehind what `diffCornerName` returned, `null` when it
 *   published nothing or threw
 */
export function orderMarkerCalls(
  pending: PendingEvent[],
  from: number,
  sectorBehind: number | null,
  cornerBehind: number | null,
): void {
  if (sectorBehind === null || cornerBehind === null || cornerBehind <= sectorBehind) return;

  if (pending.length !== from + 2) return;

  const sector = pending[from]!;
  const corner = pending[from + 1]!;

  if (sector.event !== "sectorStart.approaching" || corner.event !== "cornerName.approaching") return;

  pending[from] = corner;
  pending[from + 1] = sector;
}
