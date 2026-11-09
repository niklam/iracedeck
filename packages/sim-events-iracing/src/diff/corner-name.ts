/**
 * Corner-name callouts in practice/test sessions (issue #888).
 *
 * As the player approaches a named corner, the engineer announces it —
 * "Eau Rouge", "Turn five" — with a speed-scaled lead so the call lands
 * before the corner regardless of approach speed. Markers come from the
 * bundled lovely-track-data snapshot (`@iracedeck/track-data`), resolved
 * per track by the translator and passed in here.
 *
 * Trigger model: the shared lead-point sweep (`lead-point-sweep.ts`, the
 * module the sector starts of #1573 sweep with too): a lead point a
 * speed-scaled `leadSeconds` ahead of the car fires a marker as it crosses
 * it, once per marker per lap, never when reversing, re-anchoring silently on
 * a teleport, and speaking only the nearest of several crossed in one tick.
 * On pit road crossings are consumed but not announced.
 *
 * Session gating lives HERE (the #655 diff-side precedent) so the scenario
 * harness can fire `cornerName.approaching` freely without iRacing.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";

import type { CornerNameState } from "../state.js";
import { leadPointPct, resetLeadPointSweep, sweepLeadPoint } from "./lead-point-sweep.js";
import { coerceSettingNumber } from "./setting-number.js";
import type { EmitFn } from "./types.js";

// The sweep's constants were born here (#888) and are imported from here by
// name; they live with the sweep now.
export { CORNER_LEAD_MAX_PCT, CORNER_TELEPORT_THRESHOLD } from "./lead-point-sweep.js";

/** Default announcement lead (seconds ahead of the corner at current speed). */
export const CORNER_CALLOUT_DEFAULT_LEAD_SECONDS = 1;

/** Lead-time slider bounds (seconds) — mirrors the Zod schema in `@iracedeck/settings` `global-settings.ts`. */
export const CORNER_CALLOUT_LEAD_MIN_SECONDS = 0;
export const CORNER_CALLOUT_LEAD_MAX_SECONDS = 5;

/**
 * Sanitize a raw `cornerCalloutLeadSeconds` global-settings value: non-numeric
 * falls back to the default, the rest clamps to the slider bounds. Plugins
 * wrap their live-read closure in this (the #838 fuel-margin pattern).
 */
export function sanitizeCornerCalloutLeadSeconds(value: unknown): number {
  const n = coerceSettingNumber(value);

  if (n === null) return CORNER_CALLOUT_DEFAULT_LEAD_SECONDS;

  return Math.min(CORNER_CALLOUT_LEAD_MAX_SECONDS, Math.max(CORNER_CALLOUT_LEAD_MIN_SECONDS, n));
}

/**
 * Each marker array's start fractions, in marker order, for the sweep. The
 * translator caches one marker array per track, so this builds once per
 * track rather than once per tick.
 */
const markerStartsCache = new WeakMap<readonly CornerMarker[], readonly number[]>();

function markerStarts(markers: readonly CornerMarker[]): readonly number[] {
  let starts = markerStartsCache.get(markers);

  if (starts === undefined) {
    starts = markers.map((marker) => marker.startPct);
    markerStartsCache.set(markers, starts);
  }

  return starts;
}

/** The events {@link diffCornerName} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const CORNER_NAME_EVENTS = ["cornerName.approaching"] as const satisfies readonly SimEventName[];

export function diffCornerName(
  slice: CornerNameState,
  telemetry: TelemetryData,
  isPracticeSession: boolean,
  markers: readonly CornerMarker[] | null,
  trackLengthMeters: number | null,
  getLeadSeconds: () => number,
  emit: EmitFn<(typeof CORNER_NAME_EVENTS)[number]>,
): void {
  // Gates: practice-like session, live in the car, markers + track length
  // known, valid lap position. Anything missing → silent AND the pass state
  // resets, so returning to the track starts a fresh announced run. The
  // marker cache in the same slice is the translator's, and stays.
  if (!isPracticeSession || markers === null || markers.length === 0) {
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
  const bestIdx = sweepLeadPoint(slice, leadPoint, markerStarts(markers));

  if (bestIdx === -1) return;

  // Pit lane parallels the track — consume crossings there, announce nothing.
  if (telemetry.OnPitRoad === true) return;

  const marker = markers[bestIdx]!;

  emit({ event: "cornerName.approaching", data: { name: marker.name, slug: marker.slug } });
}
