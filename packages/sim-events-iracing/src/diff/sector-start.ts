/**
 * Sector-start calls in practice and test sessions (issue #1573).
 *
 * As the player approaches the start of a sector, the translator publishes
 * `sectorStart.approaching`, timed by the same lead point the corner names use
 * (`lead-point-sweep.ts`, with the same `cornerCalloutLeadSeconds`), so a call
 * lands as the car reaches the line, as a corner name lands at the corner.
 * Every sector start is published, sector 1 at the start/finish line
 * included: the event reports what happened on track, and the audio contract
 * decides which to speak (it never speaks sector 1).
 *
 * The sweep is the corner names' own: once per sector per lap, never when
 * reversing, silent re-anchor on a teleport, only the nearest of several
 * crossed in one tick. On pit road a crossing is consumed and not published.
 *
 * Each event carries `nextCornerInS`, the time at the current speed from the
 * sector start to the next corner marker `diffCornerName` sweeps, so a
 * consumer can tell a sector call that would crowd a corner call. It is
 * measured, never a reason to stay silent: a track with no corner data still
 * gets every sector start, with `nextCornerInS: null`.
 *
 * Session gating lives HERE (the #655 / #888 diff-side precedent) so the
 * scenario harness can publish the event freely without iRacing. Replays never
 * reach it: the translator runs it after the replay guard.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";

import type { SectorStartState } from "../state.js";
import { leadPointPct, resetLeadPointSweep, sweepLeadPoint } from "./lead-point-sweep.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffSectorStart} emits: its emitter's type, and its row in `TICK_ORDER`. */
export const SECTOR_START_EVENTS = ["sectorStart.approaching"] as const satisfies readonly SimEventName[];

/**
 * Seconds, at `speed`, from a sector start to the next corner marker forward
 * of it on the lap, wrapping the line; a marker exactly at the sector start is
 * 0 s away. No reach bound: the next corner may be most of a lap away.
 *
 * @param sectorStartPct the sector start, as a lap fraction
 * @param markers the track's corner markers, the ones `diffCornerName` sweeps
 * @param trackLengthMeters the track's length
 * @param speed the car's speed in m/s
 * @returns the seconds, or `null` with no markers, no track length or no speed
 * @internal Exported for testing.
 */
export function secondsToNextCorner(
  sectorStartPct: number,
  markers: readonly CornerMarker[] | null,
  trackLengthMeters: number | null,
  speed: number | undefined,
): number | null {
  if (markers === null || markers.length === 0) return null;

  if (trackLengthMeters === null || !(trackLengthMeters > 0)) return null;

  if (typeof speed !== "number" || !(speed > 0)) return null;

  let nearest = Infinity;

  for (const marker of markers) {
    const forward = (marker.startPct - sectorStartPct + 1) % 1;

    if (forward < nearest) nearest = forward;
  }

  return (nearest * trackLengthMeters) / speed;
}

/**
 * Publish `sectorStart.approaching` as the player's lead point crosses a
 * sector start, in a practice-like session.
 *
 * @param slice this diff's sweep state, written in place
 * @param telemetry the tick's telemetry
 * @param isPracticeSession whether the session classifies as practice
 *   (Practice, Lone Practice, Offline Testing); anything else is silent
 * @param sectors the track's sector starts, the translator's
 *   `resolveTrackSectorsCached` value (what `getTrackSectors()` serves);
 *   `null` when the track has none it can count
 * @param cornerMarkers the track's corner markers, the translator's
 *   `resolveCornerMarkersCached` value; only `nextCornerInS` reads them
 * @param trackLengthMeters the track length, the translator's
 *   `resolveTrackLengthMeters` value
 * @param getLeadSeconds the live corner-call lead (`cornerCalloutLeadSeconds`)
 * @param emit the tick's emitter
 */
export function diffSectorStart(
  slice: SectorStartState,
  telemetry: TelemetryData,
  isPracticeSession: boolean,
  sectors: readonly number[] | null,
  cornerMarkers: readonly CornerMarker[] | null,
  trackLengthMeters: number | null,
  getLeadSeconds: () => number,
  emit: EmitFn<(typeof SECTOR_START_EVENTS)[number]>,
): void {
  // Gates: practice-like session, sectors and track length known, live in the
  // car, valid lap position. Anything missing → silent AND the pass resets, so
  // returning to the track starts a fresh run. Corner markers are no gate.
  if (!isPracticeSession || sectors === null || sectors.length === 0) {
    resetLeadPointSweep(slice);

    return;
  }

  if (trackLengthMeters === null || trackLengthMeters <= 0 || telemetry.IsOnTrack !== true) {
    resetLeadPointSweep(slice);

    return;
  }

  const lapDistPct = telemetry.LapDistPct;

  if (typeof lapDistPct !== "number" || lapDistPct < 0) {
    resetLeadPointSweep(slice);

    return;
  }

  const leadPoint = leadPointPct(lapDistPct, telemetry.Speed, getLeadSeconds(), trackLengthMeters);
  const idx = sweepLeadPoint(slice, leadPoint, sectors);

  if (idx === -1) return;

  // Pit lane parallels the track — consume crossings there, announce nothing.
  if (telemetry.OnPitRoad === true) return;

  emit({
    event: "sectorStart.approaching",
    data: {
      sector: idx + 1,
      sectorCount: sectors.length,
      nextCornerInS: secondsToNextCorner(sectors[idx]!, cornerMarkers, trackLengthMeters, telemetry.Speed),
    },
  });
}
