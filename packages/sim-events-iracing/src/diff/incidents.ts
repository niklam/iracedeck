/**
 * Incidents and off-track excursions.
 *
 * Emits:
 *   - incident.occurred — when PlayerCarMyIncidentCount increments.
 *   - offTrack.started — when PlayerTrackSurface transitions to OffTrack.
 *   - offTrack.ended — when PlayerTrackSurface returns from OffTrack.
 *
 * Suppressed in pit lane / pit stall entirely. First tick seeds the
 * incident counter without firing.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { MATERIAL_WINDOW_MS } from "./incidents-constants.js";
import type { EmitFn } from "./types.js";

export function diffIncidents(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const surface = telemetry.PlayerTrackSurface ?? TrkLoc.NotInWorld;
  const material = telemetry.PlayerTrackSurfaceMaterial ?? 0;
  const incidentCount = telemetry.PlayerCarMyIncidentCount ?? 0;

  // First tick — seed both the incident counter AND the off-track fields
  // from the current snapshot, then bail. Without this, a translator that
  // starts mid-excursion (reconnect, session restart with car already off
  // track) would synthesize an `offTrack.started` on the very next eligible
  // tick even though no transition actually happened.
  if (state.lastIncidentCount < 0) {
    state.lastIncidentCount = incidentCount;

    // Only seed the off-track state if the current tick is in an eligible
    // zone (on track, not in pit stall). Otherwise leave it untouched so
    // the normal reset branch below still runs next tick.
    if (isOnTrack && !onPitRoad && surface !== TrkLoc.InPitStall && surface === TrkLoc.OffTrack) {
      state.offTrackStartedAt = now;
      state.offTrackPending = true;
      state.offTrackWarnedThisExcursion = false;
      state.materialHistory = [{ t: now, material }];
    }

    return;
  }

  if (!isOnTrack || onPitRoad || surface === TrkLoc.InPitStall) {
    // Reset off-track state — emit "ended" if we were off track.
    if (state.offTrackPending) {
      emit({ event: "offTrack.ended", data: {} });
      state.offTrackPending = false;
    }

    state.lastIncidentCount = incidentCount;
    state.materialHistory = [];
    state.offTrackStartedAt = 0;
    state.offTrackWarnedThisExcursion = false;

    return;
  }

  // Track excursion state + sample material into ring buffer
  if (surface === TrkLoc.OffTrack) {
    if (state.offTrackStartedAt === 0) {
      state.offTrackStartedAt = now;
      state.offTrackWarnedThisExcursion = false;
      state.offTrackPending = true;
      emit({ event: "offTrack.started", data: {} });
    }

    state.materialHistory.push({ t: now, material });
  } else if (state.offTrackPending) {
    state.offTrackStartedAt = 0;
    state.offTrackPending = false;
    emit({ event: "offTrack.ended", data: {} });
  }

  state.materialHistory = state.materialHistory.filter((s) => now - s.t <= MATERIAL_WINDOW_MS);

  const delta = incidentCount - state.lastIncidentCount;
  state.lastIncidentCount = incidentCount;

  if (delta > 0) {
    // Forward the delta so scenarios can distinguish a 1x/2x track-limits
    // nudge from a 4x spin/contact. Consumers that only care that *any*
    // incident happened can still use the event name alone.
    emit({ event: "incident.occurred", data: { delta } });
  }
}
