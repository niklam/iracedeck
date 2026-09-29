/**
 * Shared car-cycling helper for every feature that steps the camera through
 * the field by ascending CAR NUMBER (issue #885): the Camera Controls dial's
 * car-number mode, the keypad Cycle Car mode, and Replay Control's
 * next/previous-car-by-number modes all walk the same ordering, so the three
 * surfaces agree on which car a step lands on.
 *
 * The walk covers every car the session has had (issue #1281): the caller's
 * list is the session-info competitor list (`getAllCarNumbers(sessionInfo,
 * true, true)` — no pace car, no spectators), and there is deliberately no
 * world-presence filter. A camera switch to a car that has left the world
 * works, live and in a replay scrubbed back to when it raced, and the per-car
 * telemetry arrays read the LIVE field during an in-session replay, so a
 * presence test could not tell a car absent now from one racing at the replay
 * moment anyway. #885's filter rested on the opposite premise and hid exactly
 * the cars a post-race replay needs.
 *
 * Stepping by PHYSICAL TRACK ORDER is not computed here any more: since #1277
 * Camera Controls' Cycle by Track Order taps iRacing's own Next / Previous Car
 * bindings (`car-cycle-bindings.ts`), because a computation over the live field
 * followed the live cars, not the replay the driver is watching.
 */

/** A rotation/press dispatch direction in the ascending car-number ordering. */
export type CarCycleDirection = "next" | "previous";

/**
 * Compute the neighbouring car by ascending car number. The list is the
 * session's cars already sorted by car number (`getAllCarNumbers`); the focused
 * car (`camCarIdx`) is located in it and its `dir` neighbour returned (wrapping
 * at the ends). When the focused car is not in the list (e.g. the pace car),
 * rotation starts from the first (next) or last (previous) car.
 *
 * Every listed car is a valid target, whether or not it is in the sim world
 * right now (#1281). The focused car itself is never re-targeted, so `null` is
 * returned for an empty list and for a list holding only the focused car.
 */
export function computeCarNumberTarget(
  camCarIdx: number | undefined,
  cars: Array<{ carIdx: number; carNumber: string; carNumberRaw: number }>,
  direction: CarCycleDirection,
): { carNumberRaw: number; carNumber: string } | null {
  if (cars.length === 0) return null;

  const dir = direction === "next" ? 1 : -1;
  const idx = camCarIdx === undefined ? -1 : cars.findIndex((c) => c.carIdx === camCarIdx);
  const len = cars.length;
  // The focused car's neighbour, or the first (next) / last (previous) car
  // when it isn't listed (e.g. the pace car).
  const targetIdx = idx === -1 ? (dir === 1 ? 0 : len - 1) : (idx + dir + len) % len;

  if (targetIdx === idx) return null; // the focused car is the only one listed

  const target = cars[targetIdx];

  return { carNumberRaw: target.carNumberRaw, carNumber: target.carNumber };
}
