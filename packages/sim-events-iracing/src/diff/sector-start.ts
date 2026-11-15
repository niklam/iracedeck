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
 * The diff knows nothing of the corner names beyond sharing their sweep: a
 * sector call and a corner name that come due together are both published,
 * and the voice bus's queue plays the second after the first (#1676). On a
 * tick that sweeps both a sector start and a corner marker the translator
 * publishes them in the order the lead point crossed them, a tie (a corner at
 * the sector line) to the sector call: it reads how far behind the lead point
 * each crossed start sits, which this diff returns
 * (`diff/marker-call-order.ts`).
 *
 * Session gating lives HERE (the #655 / #888 diff-side precedent) so the
 * scenario harness can publish the event freely without iRacing. Replays never
 * reach it: the translator runs it after the replay guard.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { SectorStartState } from "../state.js";
import { leadPointPct, resetLeadPointSweep, sweepLeadPoint } from "./lead-point-sweep.js";
import { lapFractionBehind } from "./marker-call-order.js";
import type { EmitFn } from "./types.js";

/** The events {@link diffSectorStart} emits: its emitter's type, and its row in `TICK_ORDER`. */
export const SECTOR_START_EVENTS = ["sectorStart.approaching"] as const satisfies readonly SimEventName[];

/**
 * Publish `sectorStart.approaching` as the player's lead point crosses a
 * sector start, in a practice-like session.
 *
 * @param slice this diff's sweep state, written in place
 * @param telemetry the tick's telemetry
 * @param isPracticeSession whether the session classifies as practice
 *   (Practice, Lone Practice, Offline Testing); anything else is silent
 * @param sectors the track's sector starts, the translator's
 *   `resolveTrackSectorsCached` value, read at the call (#1588);
 *   `null` when the track has none it can count
 * @param trackLengthMeters the track length, the translator's
 *   `resolveTrackLengthMeters` value
 * @param getLeadSeconds the live corner-call lead (`cornerCalloutLeadSeconds`)
 * @param emit the tick's emitter
 * @returns how far behind this tick's lead point the sector start it
 *   published sits, as a lap fraction in [0, 1); `null` when it published
 *   nothing, a crossing consumed on pit road included
 */
export function diffSectorStart(
  slice: SectorStartState,
  telemetry: TelemetryData,
  isPracticeSession: boolean,
  sectors: readonly number[] | null,
  trackLengthMeters: number | null,
  getLeadSeconds: () => number,
  emit: EmitFn<(typeof SECTOR_START_EVENTS)[number]>,
): number | null {
  // Gates: practice-like session, sectors and track length known, live in the
  // car, valid lap position. Anything missing → silent AND the pass resets, so
  // returning to the track starts a fresh run.
  if (!isPracticeSession || sectors === null || sectors.length === 0) {
    resetLeadPointSweep(slice);

    return null;
  }

  if (trackLengthMeters === null || trackLengthMeters <= 0 || telemetry.IsOnTrack !== true) {
    resetLeadPointSweep(slice);

    return null;
  }

  const lapDistPct = telemetry.LapDistPct;

  if (typeof lapDistPct !== "number" || lapDistPct < 0) {
    resetLeadPointSweep(slice);

    return null;
  }

  const leadPoint = leadPointPct(lapDistPct, telemetry.Speed, getLeadSeconds(), trackLengthMeters);
  const idx = sweepLeadPoint(slice, leadPoint, sectors);

  if (idx === -1) return null;

  // Pit lane parallels the track — consume crossings there, announce nothing.
  if (telemetry.OnPitRoad === true) return null;

  emit({
    event: "sectorStart.approaching",
    data: { sector: idx + 1, sectorCount: sectors.length },
  });

  return lapFractionBehind(leadPoint, sectors[idx]!);
}
