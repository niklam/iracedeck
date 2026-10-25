/**
 * Shared race-position cycling for every dial that steps the camera through
 * the field by RACE ORDER: Camera Controls' Cycle by Race Position (#803) and
 * the Replay Control dial's Position mode (#1448), so the two surfaces agree on
 * which car a step lands on. Moved here from the Camera Controls dial surface
 * by #1448, unchanged in behaviour. Design:
 * `docs/superpowers/specs/2026-10-18-issue-1448-replay-dial-camera-car-modes.md`.
 *
 * The order is a per-car, 1-based rank array indexed by `carIdx`, `0` for a car
 * it does not rank: the canonical live order (`getLiveRacePositions`, per
 * `.claude/rules/race-positions.md`), with the official `CarIdxPosition` as the
 * fallback ({@link resolveRaceOrder}). A target is resolved to a car NUMBER
 * from that same order ({@link carNumberRawAtPosition}) and switched to with
 * `camera.switchNum`, never `switchPos`, which iRacing would resolve against
 * its own, possibly different, official order.
 *
 * As with the car-number walk (`car-cycling.ts`, #1281) there is no
 * world-presence filter: every ranked car is a target, frozen ranks of a
 * towed, finished or departed car included.
 */
import { getCarNumberRawFromSessionInfo } from "@iracedeck/iracing-sdk";

import type { CarCycleDirection } from "./car-cycling.js";

/**
 * @internal Exported for testing
 *
 * Wrap a 1-based race position by `dir` within a field of `max` cars.
 */
export function wrapPosition(current: number, dir: 1 | -1, max: number): number {
  return ((current - 1 + dir + max) % max) + 1;
}

/**
 * Compute the target race position for a rotation. `order` is a per-car,
 * 1-based rank array indexed by `carIdx` (the canonical live order, or the
 * `CarIdxPosition` fallback the caller supplies) — `0` = not classified.
 *
 * When the focused car IS classified, returns its current position, the wrapped
 * target one detent away, and the field size. When the focused car is NOT
 * classified (the pace / safety car, or a car missing from the order) but the
 * field is non-empty, a detent still acts by re-entering the running order at
 * its natural end — `next` → the leader (P1), `previous` → last place (issue
 * #803, so the pace car in focus doesn't stall cycling). Which physical turn
 * dispatches which direction is the caller's (#884): under the number-primary
 * default, a clockwise detent dispatches `previous`, so it re-enters at last
 * place and walks up the field. `currentPosition` is then `null` (no position
 * badge). Returns `null` when there is no usable order at all (no order, or an
 * empty field), or when no other position along the walk holds a car.
 *
 * Every ranked car is a target, frozen ranks included: the canonical order
 * keeps a towed / finished / departed car at its last-known rank, and a camera
 * switch to it works (issue #1281), so there is no world-presence filter. The
 * walk (both the classified step and the recovery re-entry) only steps past a
 * position NO car holds — a gap in the ranks — wrapping, and never re-targets
 * the focused car's own position.
 */
export function computeRacePositionTarget(
  camCarIdx: number | undefined,
  order: number[] | null,
  direction: CarCycleDirection,
): { currentPosition: number | null; targetPosition: number; maxPosition: number } | null {
  if (!order || camCarIdx === undefined || camCarIdx < 0) return null;

  const maxPosition = order.reduce((m, p) => (typeof p === "number" && p > m ? p : m), 0);

  if (maxPosition <= 0) return null;

  const dir = direction === "next" ? 1 : -1;
  const currentPosition = order[camCarIdx];
  const classified = typeof currentPosition === "number" && currentPosition > 0;

  // Anchor the walk one step from the focused car's own position — or, for an
  // unclassified focused car (pace / safety car, or a car not in the order),
  // re-enter the order at its natural end so a detent isn't a no-op: next →
  // P1, previous → last place. No currentPosition → the carousel omits the
  // position badge.
  let candidate = classified ? wrapPosition(currentPosition, dir, maxPosition) : dir === 1 ? 1 : maxPosition;

  for (let step = 0; step < maxPosition; step++) {
    if (classified && candidate === currentPosition) break; // full circle — no other ranked car

    if (carIdxAtPosition(order, candidate) !== null) {
      return { currentPosition: classified ? currentPosition : null, targetPosition: candidate, maxPosition };
    }

    candidate = wrapPosition(candidate, dir, maxPosition);
  }

  return null;
}

/** The carIdx running at a given race position (the inverse of `order`), or null when unclassified. */
function carIdxAtPosition(order: number[], position: number): number | null {
  const carIdx = order.findIndex((p) => p === position);

  return carIdx < 0 ? null : carIdx;
}

/**
 * The raw car number (the camera-API identity, not the display string) running
 * at a given race position. Used by the race-position rotation dispatch so
 * execution focuses the car at the SAME target position the side preview
 * shows, rather than a bare position that iRacing's own `switchPos` would
 * resolve against a potentially different (official) order.
 */
export function carNumberRawAtPosition(order: number[], sessionInfo: unknown, position: number): number | null {
  const carIdx = carIdxAtPosition(order, position);

  return carIdx === null ? null : getCarNumberRawFromSessionInfo(sessionInfo, carIdx);
}

/**
 * The race order, canonical first, official `CarIdxPosition` as fallback.
 *
 * The canonical order is a dense array of 1-based ranks with `0` for every
 * car it omits, so "no order at all" arrives as a NON-NULL array of zeros —
 * `??` alone accepts it and strands the walk at `maxPosition = 0`. An order
 * that ranks NOBODY is therefore "no live order at all" in the sense
 * `race-positions.md` means it, and the official counter takes over (#968).
 *
 * Before the green flag of a race the canonical order is the qualifying grid
 * (issue #974), so the walk cycles the formation exactly as it does the race;
 * the all-zero case is the rarer one — a non-race session, or a race whose
 * grid can't be resolved — where the official counter is the last resort and
 * is itself all-zero pre-green (iRacing scores positions at start/finish).
 */
export function resolveRaceOrder(
  canonical: number[] | null,
  carIdxPosition: number[] | null | undefined,
): number[] | null {
  if (canonical?.some((position) => position > 0)) return canonical;

  return carIdxPosition ?? canonical ?? null;
}
