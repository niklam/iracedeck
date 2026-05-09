/**
 * Incidents and off-track excursions.
 *
 * Emits:
 *   - incident.occurred — coalesced across a "burst" of count-increment
 *     events. iRacing reports a single physical crash as a stream of
 *     point-by-point increments (off-track 1x → out-of-control 2x →
 *     collision-with-car 4x) over ~hundreds of milliseconds. We buffer
 *     the latest classified type plus the accumulated delta and only
 *     emit once the burst goes quiet for `INCIDENT_BURST_QUIET_MS` (or
 *     once `INCIDENT_BURST_MAX_MS` has elapsed from the first increment,
 *     whichever comes first). The audio scenario then plays one callout
 *     per crash, not three. Issue #530.
 *   - offTrack.started — when PlayerTrackSurface transitions to OffTrack.
 *   - offTrack.ended — when PlayerTrackSurface returns from OffTrack.
 *
 * Suppressed in pit lane / pit stall entirely (clears any pending burst
 * and latch on entry). First tick seeds the incident counter without
 * firing.
 *
 * **Why we latch the type byte.** iRacing sets `PlayerIncidents` (the
 * `irsdk_IncidentFlags` report byte) for ~one 16 ms internal frame, then
 * clears it. The visible `PlayerCarMyIncidentCount` increment lags
 * ~32 ms / 2 frames behind the flag. Even at 100 Hz polling we observe
 * `count` change with `playerIncidents == 0`, so a strict same-tick
 * classifier always returns null. Caching the last classified type
 * across ticks (with a generous staleness cap) lets us hand the right
 * type to the count-delta consumer.
 *
 * `RepOffTrackOngoing` (0x03) and `RepCollisionWithWorldOngoing` (0x06)
 * are suppressed — the iRacing header notes they are never emitted by the
 * sim. `RepNoReport` (0x00) is also suppressed; if neither the current
 * byte nor the latch resolves to a known type the diff stays silent so a
 * future iRacing-side type addition doesn't get an unclassified callout.
 */
import type { IncidentType } from "@iracedeck/event-bus";
import { INCIDENT_REP_MASK, IncidentFlags, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { MATERIAL_WINDOW_MS } from "./incidents-constants.js";
import type { EmitFn } from "./types.js";

/**
 * Maximum age (ms) of a latched incident type before we consider it stale.
 * Sized for the observed iRacing emission pattern: the `PlayerIncidents`
 * byte is set briefly, then `PlayerCarMyIncidentCount` increments ~32 ms
 * later. 1500 ms gives ~50× headroom for slower hardware / framerate
 * spikes while still being short enough that an unrelated future
 * count increment can't pick up a stale type from a previous incident.
 *
 * @internal Exported for testing.
 */
export const PENDING_INCIDENT_STALENESS_MS = 1500;

/**
 * Quiet window for the burst coalescer. After the most recent count
 * increment in a burst, we wait this many ms with no further increments
 * before emitting `incident.occurred`. A typical iRacing crash
 * (off-track → loss-of-control → wall-hit → car-contact) finishes well
 * within this window so the engineer announces once with the most
 * severe outcome.
 *
 * @internal Exported for testing.
 */
export const INCIDENT_BURST_QUIET_MS = 1500;

/**
 * Hard cap (ms) from the FIRST increment in a burst. Even if increments
 * keep arriving inside the quiet window, we force-emit at this age so a
 * sustained barrel-roll doesn't delay the callout indefinitely.
 *
 * @internal Exported for testing.
 */
export const INCIDENT_BURST_MAX_MS = 3000;

/**
 * Translate the `PlayerIncidents` report byte into the bus's canonical
 * {@link IncidentType} discriminator. Returns `null` for `RepNoReport`,
 * the two `Ongoing` variants iRacing never emits, and any future code
 * the bus doesn't yet know about. A `null` result silences the callout
 * for that incident.
 *
 * @internal Exported for testing.
 */
export function classifyIncident(playerIncidents: number): IncidentType | null {
  const reportByte = playerIncidents & INCIDENT_REP_MASK;

  switch (reportByte) {
    case IncidentFlags.RepOutOfControl:
      return "out-of-control";
    case IncidentFlags.RepOffTrack:
      return "off-track";
    case IncidentFlags.RepContactWithWorld:
      return "contact-world";
    case IncidentFlags.RepCollisionWithWorld:
      return "collision-world";
    case IncidentFlags.RepContactWithCar:
      return "contact-car";
    case IncidentFlags.RepCollisionWithCar:
      return "collision-car";
    default:
      // RepNoReport (0x00), RepOffTrackOngoing (0x03),
      // RepCollisionWithWorldOngoing (0x06), or anything iRacing adds
      // later that the bus doesn't know about yet.
      return null;
  }
}

function clearIncidentBurst(state: TranslatorState): void {
  state.incidentBurstType = null;
  state.incidentBurstDelta = 0;
  state.incidentBurstFirstAt = 0;
  state.incidentBurstLatestAt = 0;
}

function flushIncidentBurst(state: TranslatorState, emit: EmitFn): void {
  // Only flush when there's actually a typed burst — a delta-only burst
  // with no resolved type stays silent. (Should be impossible since we
  // only START a burst when type is non-null, but defensive.)
  if (state.incidentBurstType !== null && state.incidentBurstDelta > 0) {
    emit({
      event: "incident.occurred",
      data: { delta: state.incidentBurstDelta, type: state.incidentBurstType },
    });
  }

  clearIncidentBurst(state);
}

export function diffIncidents(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const surface = telemetry.PlayerTrackSurface ?? TrkLoc.NotInWorld;
  const material = telemetry.PlayerTrackSurfaceMaterial ?? 0;
  const incidentCount = telemetry.PlayerCarMyIncidentCount ?? 0;
  const playerIncidents = telemetry.PlayerIncidents ?? 0;

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
    // Drop any latched incident type and any pending burst — entering pit /
    // leaving track means in-flight classification + burst data are no
    // longer relevant. Don't flush — the engineer should not announce a
    // pit-lane-time incident.
    state.pendingIncidentType = null;
    state.pendingIncidentTypeAt = 0;
    clearIncidentBurst(state);

    return;
  }

  // Latch every classified non-null read. The byte is set for ~one
  // iRacing frame; this is our only chance to capture the type before
  // iRacing clears it. Overwriting an existing pending value with a fresh
  // one is the right behavior for back-to-back incidents (the most
  // recent classification wins; older count-deltas should already have
  // consumed their pending entry by now).
  const currentType = classifyIncident(playerIncidents);

  if (currentType !== null) {
    state.pendingIncidentType = currentType;
    state.pendingIncidentTypeAt = now;
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
    // Resolve the type: prefer this tick's classification (if non-null);
    // fall back to the latched value if it's still fresh enough to be
    // related to this incident. Anything older than the staleness cap is
    // discarded — it's almost certainly from an unrelated earlier event.
    let resolvedType: IncidentType | null = currentType;

    if (
      resolvedType === null &&
      state.pendingIncidentType !== null &&
      now - state.pendingIncidentTypeAt <= PENDING_INCIDENT_STALENESS_MS
    ) {
      resolvedType = state.pendingIncidentType;
    }

    // Always clear the latch on a count delta, regardless of whether we
    // resolved a type. A count delta we couldn't classify shouldn't leave
    // the latch primed for the next unrelated count change; an unrelated
    // stale entry would otherwise misattribute.
    state.pendingIncidentType = null;
    state.pendingIncidentTypeAt = 0;

    if (resolvedType !== null) {
      // Either start a new burst or extend the in-flight one. Most-recent
      // type wins — a typical incident progresses light → heavy
      // (off-track → collision-car) so the latest classification is the
      // most informative one to announce.
      if (state.incidentBurstFirstAt === 0) {
        state.incidentBurstFirstAt = now;
      }

      state.incidentBurstType = resolvedType;
      state.incidentBurstDelta += delta;
      state.incidentBurstLatestAt = now;
    }
  }

  // Check the pending burst on every tick — quiet-window or hard-cap
  // expiry triggers the emit. We don't need a separate setTimeout
  // because the translator runs at ~100 Hz, so the maximum miss past
  // the deadline is one tick (~10 ms), which is well under the user's
  // perceptual window.
  if (state.incidentBurstFirstAt > 0) {
    const quietElapsed = now - state.incidentBurstLatestAt;
    const burstAge = now - state.incidentBurstFirstAt;

    if (quietElapsed >= INCIDENT_BURST_QUIET_MS || burstAge >= INCIDENT_BURST_MAX_MS) {
      flushIncidentBurst(state, emit);
    }
  }
}
