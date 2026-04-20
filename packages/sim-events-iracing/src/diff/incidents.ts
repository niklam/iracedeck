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

  // First tick — seed without firing.
  if (state.lastIncidentCount < 0) {
    state.lastIncidentCount = incidentCount;

    return;
  }

  const delta = incidentCount - state.lastIncidentCount;
  state.lastIncidentCount = incidentCount;

  if (delta > 0) {
    emit({ event: "incident.occurred", data: {} });
  }
}
