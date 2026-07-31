/**
 * Shared car-cycling helpers for every feature that steps the camera through
 * the field by ascending car number (issue #885): the Camera Controls dial's
 * car-number mode, the keypad Cycle Car mode, and Replay Control's
 * next/previous-car-by-number modes all walk the same ordering with the same
 * world-presence rule, so a car that left the sim world can't dead-loop any of
 * them.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

/** A rotation/press dispatch direction in the ascending car-number ordering. */
export type CarCycleDirection = "next" | "previous";

/**
 * Presence predicate for the car cycling target walks (issue #885): whether a
 * car currently exists in the sim world — valid lap telemetry and a track
 * surface other than `NotInWorld`, the same per-tick in-world formula the
 * translator's position tracking starts from (`race-finish.ts`), deliberately
 * WITHOUT its freeze/debounce: a one-tick `NotInWorld` blink at worst makes a
 * detent skip one live car (the next detent recovers), which doesn't justify
 * carrying per-car history here. Post-race, finished/towed cars despawn but
 * keep their frozen rank in the canonical order (and stay listed in session
 * info), and iRacing silently ignores a camera switch to them. Without the
 * per-car world arrays (out of session) there is nothing to judge presence by,
 * so every car counts as present.
 */
export function carPresence(telemetry: TelemetryData | null): (carIdx: number) => boolean {
  const lc = telemetry?.CarIdxLapCompleted;
  const dp = telemetry?.CarIdxLapDistPct;

  if (!Array.isArray(lc) || !Array.isArray(dp)) return () => true;

  const ts = telemetry?.CarIdxTrackSurface as number[] | undefined;

  return (carIdx) => lc[carIdx] >= 0 && dp[carIdx] >= 0 && ts?.[carIdx] !== TrkLoc.NotInWorld;
}

/**
 * Compute the neighbouring car by ascending car number. The list is the
 * session's cars already sorted by car number (`getAllCarNumbers`); the focused
 * car (`camCarIdx`) is located in it and its `dir` neighbour returned (wrapping
 * at the ends). When the focused car is not in the list (e.g. the pace car),
 * rotation starts from the first (next) or last (previous) car.
 *
 * `isPresent` filters to cars that currently exist in the sim world (issue
 * #885): session info keeps every driver listed after they tow out or leave
 * post-race, but iRacing silently ignores a camera switch to an absent car —
 * `CamCarIdx` never moves, so every following detent would recompute the same
 * dead target. The walk continues along the list (wrapping) until a present
 * car is found; the focused car itself is never re-targeted, and `null` is
 * returned when no other present car exists.
 */
export function computeCarNumberTarget(
  camCarIdx: number | undefined,
  cars: Array<{ carIdx: number; carNumber: string; carNumberRaw: number }>,
  direction: CarCycleDirection,
  isPresent: (carIdx: number) => boolean = () => true,
): { carNumberRaw: number; carNumber: string } | null {
  if (cars.length === 0) return null;

  const dir = direction === "next" ? 1 : -1;
  const idx = camCarIdx === undefined ? -1 : cars.findIndex((c) => c.carIdx === camCarIdx);
  // Anchor so the first step lands where the single-step version did: the
  // focused car's slot, or just outside the entry end when it isn't listed.
  const anchor = idx === -1 ? (dir === 1 ? -1 : cars.length) : idx;

  for (let step = 1; step <= cars.length; step++) {
    const targetIdx = (((anchor + dir * step) % cars.length) + cars.length) % cars.length;

    if (targetIdx === idx) continue; // full circle — never re-target the focused car

    const target = cars[targetIdx];

    if (isPresent(target.carIdx)) return { carNumberRaw: target.carNumberRaw, carNumber: target.carNumber };
  }

  return null;
}
