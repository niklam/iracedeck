/**
 * Corner-name callouts in practice/test sessions (issue #888).
 *
 * As the player approaches a named corner, the engineer announces it —
 * "Eau Rouge", "Turn five" — with a speed-scaled lead so the call lands
 * before the corner regardless of approach speed. Markers come from the
 * bundled lovely-track-data snapshot (`@iracedeck/track-data`), resolved
 * per track by the translator and passed in here.
 *
 * Trigger model: a LEAD POINT (current `LapDistPct` plus `speed ×
 * leadSeconds` converted to a lap fraction) is tracked tick-to-tick, and a
 * marker fires when it falls inside the forward interval the lead point
 * swept this tick — true threshold-crossing semantics, so the first tick
 * seeds silently and markers behind the car never burst-fire. Once per
 * marker per lap (`cornerSpoken`, cleared when the lead point wraps past
 * S/F). Reversing never fires; a discontinuous jump (tow / reset-to-pits)
 * re-anchors silently and clears the set so the fresh run announces again.
 * Multiple markers swept in one tick speak only the one nearest the lead
 * point (no stale burst — the #480/#838 rule). On pit road crossings are
 * consumed but not announced.
 *
 * Session gating lives HERE (the #655 diff-side precedent) so the scenario
 * harness can fire `cornerName.approaching` freely without iRacing.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * One-tick lead-point jump (lap fraction) treated as a discontinuity — tow,
 * reset-to-pits, replay scrub. Same scale as the #603 position-tracking
 * threshold: well above racing motion (~0.0003/tick at 60 Hz), well below
 * any plausible teleport.
 */
export const CORNER_TELEPORT_THRESHOLD = 0.05;

/**
 * Cap on the speed-scaled lead offset (lap fraction). Keeps an extreme
 * setting on a short track from pushing the lead point most of a lap ahead
 * (which would both announce absurdly early and confuse the wrap detection).
 */
export const CORNER_LEAD_MAX_PCT = 0.2;

/** Default announcement lead (seconds ahead of the corner at current speed). */
export const CORNER_CALLOUT_DEFAULT_LEAD_SECONDS = 1;

/** Lead-time slider bounds (seconds) — mirrors the Zod schema in deck-core. */
export const CORNER_CALLOUT_LEAD_MIN_SECONDS = 0;
export const CORNER_CALLOUT_LEAD_MAX_SECONDS = 5;

/**
 * Sanitize a raw `cornerCalloutLeadSeconds` global-settings value: non-numeric
 * falls back to the default, the rest clamps to the slider bounds. Plugins
 * wrap their live-read closure in this (the #838 fuel-margin pattern).
 */
export function sanitizeCornerCalloutLeadSeconds(value: unknown): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : value;

  if (typeof n !== "number" || !Number.isFinite(n)) return CORNER_CALLOUT_DEFAULT_LEAD_SECONDS;

  return Math.min(CORNER_CALLOUT_LEAD_MAX_SECONDS, Math.max(CORNER_CALLOUT_LEAD_MIN_SECONDS, n));
}

function resetPass(state: TranslatorState): void {
  state.cornerLeadPrevPct = null;

  if (state.cornerSpoken.size > 0) state.cornerSpoken.clear();
}

export function diffCornerName(
  state: TranslatorState,
  telemetry: TelemetryData,
  isPracticeSession: boolean,
  markers: readonly CornerMarker[] | null,
  trackLengthMeters: number | null,
  getLeadSeconds: () => number,
  emit: EmitFn,
): void {
  // Gates: practice-like session, live in the car, markers + track length
  // known, valid lap position. Anything missing → silent AND the pass state
  // resets, so returning to the track starts a fresh announced run.
  if (!isPracticeSession || markers === null || markers.length === 0) {
    resetPass(state);

    return;
  }

  if (trackLengthMeters === null || trackLengthMeters <= 0 || telemetry.IsOnTrack !== true) {
    resetPass(state);

    return;
  }

  const lapDistPct = telemetry.LapDistPct;

  if (typeof lapDistPct !== "number" || lapDistPct < 0) {
    resetPass(state);

    return;
  }

  const speed = typeof telemetry.Speed === "number" && telemetry.Speed > 0 ? telemetry.Speed : 0;
  const leadPct = Math.min(CORNER_LEAD_MAX_PCT, (speed * getLeadSeconds()) / trackLengthMeters);
  const leadPoint = (lapDistPct + leadPct) % 1;

  const prev = state.cornerLeadPrevPct;

  state.cornerLeadPrevPct = leadPoint;

  // First valid tick of a pass: seed silently. Markers "behind" the lead
  // point simply aren't in any future forward interval this lap, so there is
  // no burst and no explicit seeding pass needed.
  if (prev === null) return;

  // Signed forward delta folded into (-0.5, 0.5]: negative = reversing.
  const delta = ((leadPoint - prev + 1.5) % 1) - 0.5;

  if (delta <= 0) return;

  if (delta > CORNER_TELEPORT_THRESHOLD) {
    // Tow / reset / scrub — re-anchor, clear the lap's spoken set, stay
    // silent. The next genuine crossings announce as a fresh pass.
    state.cornerSpoken.clear();

    return;
  }

  // The lead point wrapped past S/F inside this tick's interval — new lap.
  if (leadPoint < prev) state.cornerSpoken.clear();

  // Collect markers inside the forward interval (prev, leadPoint]. All of
  // them are consumed (marked spoken); only the one nearest the lead point
  // is announced, so a wide tick never bursts stale names.
  let bestIdx = -1;
  let bestForward = -1;

  for (let i = 0; i < markers.length; i++) {
    const forward = (markers[i]!.startPct - prev + 1) % 1;

    if (forward <= 0 || forward > delta) continue;

    if (state.cornerSpoken.has(i)) continue;

    state.cornerSpoken.add(i);

    if (forward > bestForward) {
      bestForward = forward;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return;

  // Pit lane parallels the track — consume crossings there, announce nothing.
  if (telemetry.OnPitRoad === true) return;

  const marker = markers[bestIdx]!;

  emit({ event: "cornerName.approaching", data: { name: marker.name, slug: marker.slug } });
}
