/**
 * Shared car-cycling helpers for every feature that steps the camera through
 * the field (issue #885, #886):
 *
 *   - by ascending CAR NUMBER — the Camera Controls dial's car-number mode, the
 *     keypad Cycle Car mode, and Replay Control's next/previous-car-by-number
 *     modes all walk the same ordering with the same world-presence rule, so a
 *     car that left the sim world can't dead-loop any of them;
 *   - by PHYSICAL TRACK ORDER — the Camera Controls dial's track-order mode
 *     (#886) steps to the competitor physically ahead of / behind the focused
 *     car on the road, via the SAME `findNearestCarOnTrack` primitive behind
 *     the SDK's `track_ahead` / `track_behind` template variables
 *     (`findNearestDriverOnTrack`) and Replay Control's dial handler (never a
 *     second track-order computation).
 */
import { findNearestCarOnTrack, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

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

/** A dispatch direction along the physical track: towards the car ahead or the one behind. */
export type TrackOrderDirection = "ahead" | "behind";

/** The competitor a track-order step lands on: its identity for dispatch (`carNumberRaw`) and display (`carNumber`). */
export interface TrackOrderTarget {
  carIdx: number;
  carNumberRaw: number;
  carNumber: string;
}

/**
 * Compute the neighbouring COMPETITOR by physical track order (issue #886):
 * the car nearest ahead of / behind the focused car (`camCarIdx`) by circular
 * lap distance (`CarIdxLapDistPct`), regardless of lap count or race position
 * — a lapped car sitting just ahead on the road IS the car ahead. Delegates to
 * the shared `findNearestCarOnTrack` (`@iracedeck/iracing-sdk`), the one
 * track-order primitive in the project (also behind the SDK's
 * `findNearestDriverOnTrack` template helper and Replay Control's dial
 * handler), so the consumers never drift; this wrapper only adds the
 * competitor filter and the car-number lookup the camera dispatch needs.
 *
 * `cars` is the competitor list (`getAllCarNumbers(sessionInfo, true, true)` —
 * pace car and spectators excluded); any car outside it is skipped even when it
 * is physically closer, so the pace car under caution is never targeted. Cars
 * no longer in the sim world are skipped by the primitive's own in-world test
 * (an invalid lap distance or a `NotInWorld` surface), so a towed / exited car
 * can't dead-loop the cycle (the #885 concern). Note that this is deliberately
 * NOT `carPresence`: the primitive has no lap-count condition, because
 * `CarIdxLapCompleted` is still -1 for every active car on the pace lap (#307),
 * whereas `carPresence` — the car-number / race-position rule — requires it to
 * be >= 0. When the focused car has no track position of its own (not in the
 * world), the primitive's documented fallback re-enters the field at the car
 * nearest the start/finish line for BOTH directions. Returns `null` without
 * telemetry, without a focused car, or when no other competitor is on track —
 * the focused car is never re-targeted.
 */
export function computeTrackOrderTarget(
  telemetry: TelemetryData | null,
  camCarIdx: number | undefined,
  cars: ReadonlyArray<{ carIdx: number; carNumber: string; carNumberRaw: number }>,
  direction: TrackOrderDirection,
): TrackOrderTarget | null {
  if (camCarIdx === undefined || cars.length === 0) return null;

  const competitorsByIdx = new Map(cars.map((car) => [car.carIdx, car]));
  const carIdx = findNearestCarOnTrack(telemetry, camCarIdx, direction, {
    skipIdx: (idx) => !competitorsByIdx.has(idx),
  });
  // `skipIdx` guarantees any returned index is a competitor, so the lookup only
  // misses when the primitive found nothing.
  const car = carIdx === null ? undefined : competitorsByIdx.get(carIdx);

  return car ? { carIdx: car.carIdx, carNumberRaw: car.carNumberRaw, carNumber: car.carNumber } : null;
}
