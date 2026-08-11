/**
 * Incidents and off-track excursions.
 *
 * Emits:
 *   - incident.occurred — coalesced across a "burst" of count-increment
 *     events. iRacing reports a single physical crash as a stream of
 *     point-by-point increments over seconds. We buffer the latest
 *     classified type plus the accumulated count delta and only emit once
 *     the burst goes quiet for `INCIDENT_BURST_QUIET_MS` (or once
 *     `INCIDENT_BURST_MAX_MS` has elapsed from the first increment,
 *     whichever comes first). The audio scenario then plays one callout
 *     per crash, not three. Issue #530.
 *   - offTrack.started — when PlayerTrackSurface transitions to OffTrack.
 *   - offTrack.ended — when PlayerTrackSurface returns from OffTrack.
 *
 * **The spoken value is the type's Sporting Code value, never the count
 * delta** (issue #938). iRacing scores a multi-stage crash as ONE incident
 * sequence that escalates to its worst outcome (§3.5.2: "only the most
 * serious is counted"), so `PlayerCarMyIncidentCount` moves by the
 * MARGINAL upgrade at each step — a wall hit that upgrades an off-track
 * moves the count by +1 for a 2x incident, and a car collision upgrading
 * an off-track by +3 for a 4x one (capture
 * `local/telemetry-watch-20260811-125031-041.jsonl`). A burst's summed
 * delta therefore under-reports whenever the escalation spans a burst
 * boundary. Since the sequence's total IS its worst outcome's value, each
 * emission carries `points = incidentTypeValue(type)` — the §3.5.1 table
 * value, with `collision-car` discipline-resolved (4x pavement / 2x dirt,
 * the only value the two tables disagree on). The count delta remains the
 * TRIGGER (a report byte with no count movement stays silent) and rides
 * along as `delta` for consumers that want the raw movement. An
 * escalation that lands after an earlier stage was already announced
 * simply announces again with the worse type's value — the audio layer's
 * `family: "incident"` preemption trumps the in-flight line.
 *
 * Suppressed in pit lane / pit stall entirely (clears any pending burst
 * and latch on entry). First tick seeds the incident counter without
 * firing.
 *
 * **Why we latch the type byte.** iRacing sets `PlayerIncidents` (the
 * `irsdk_IncidentFlags` report byte) for exactly one ~16 ms internal
 * frame (capture-confirmed, #938), then clears it. The visible
 * `PlayerCarMyIncidentCount` increment usually lags ~32 ms / 2 frames
 * behind the flag — so the diff caches the last classified type across
 * ticks (with a staleness cap) and hands it to the count-delta consumer.
 * The capture also showed the OPPOSITE order: the count increment landing
 * ~2 frames BEFORE its report byte. Two rules absorb that: an increment
 * with no resolvable type still extends the pending burst (it must not be
 * dropped), and a classified byte arriving within
 * `INCIDENT_LATE_TYPE_MS` of the burst's latest increment retypes the
 * pending burst (latest wins).
 *
 * `RepOffTrackOngoing` (0x03) and `RepCollisionWithWorldOngoing` (0x06)
 * are suppressed — the iRacing header notes they are never emitted by the
 * sim, and the #938 capture (including sustained off-tracks) confirmed
 * neither ever appears. `RepNoReport` (0x00) is also suppressed; a burst
 * whose type never resolves flushes silently so a future iRacing-side
 * type addition doesn't get an unclassified callout. The PENALTY byte of
 * `PlayerIncidents` (`PenZeroX`…`PenFourX`) is deliberately unused: the
 * capture showed it inconsistent (a lone off-track carried `Pen1x`, a
 * same-shape off-track later carried `Pen2x`) and absent entirely on
 * three of five reports.
 */
import type { IncidentType } from "@iracedeck/event-bus";
import { INCIDENT_REP_MASK, IncidentFlags, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { isDirtTrack } from "../track-type.js";
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
 * A classified report byte arriving this soon after a count increment
 * (with no increment of its own) retypes the pending burst. The #938
 * capture showed the byte trailing its count increment by ~2 frames
 * (~33 ms); without adoption the increment would announce with a stale
 * type or not at all. Kept tight so an unrelated later report can't
 * repaint a burst it doesn't belong to.
 *
 * @internal Exported for testing.
 */
export const INCIDENT_LATE_TYPE_MS = 200;

/**
 * Sporting Code §3.5.1 heavy-car-contact value per discipline (#938) —
 * the only value the pavement and dirt tables disagree on.
 *
 * @internal Exported for testing.
 */
export const COLLISION_CAR_VALUE_PAVEMENT = 4;
/** @internal Exported for testing. */
export const COLLISION_CAR_VALUE_DIRT = 2;

/**
 * Resolve the discipline-dependent `collision-car` value from session
 * info. Unknown/missing session info reads as pavement.
 *
 * @internal Exported for testing.
 */
export function resolveCollisionCarValue(sessionInfo: Record<string, unknown> | null): number {
  return isDirtTrack(sessionInfo) ? COLLISION_CAR_VALUE_DIRT : COLLISION_CAR_VALUE_PAVEMENT;
}

/**
 * The incident points a type carries (Sporting Code §3.5.1). An iRacing
 * incident SEQUENCE escalates to its worst outcome (§3.5.2), so the
 * latest classified type's value IS the sequence's scored total — this is
 * the number the Race Engineer speaks (#938). Never derived from count
 * deltas, and never baked into clip wording (#922).
 *
 * @internal Exported for testing.
 */
export function incidentTypeValue(type: IncidentType, collisionCarValue: number): number {
  switch (type) {
    case "off-track":
      return 1;
    case "out-of-control":
      return 2;
    case "contact-world":
      return 0;
    case "collision-world":
      return 2;
    case "contact-car":
      return 0;
    case "collision-car":
      return collisionCarValue;
  }
}

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

function flushIncidentBurst(state: TranslatorState, emit: EmitFn, collisionCarValue: number): void {
  // Only flush when the burst resolved a type — an untyped burst (its
  // report byte never observed, even via the late-type window) stays
  // silent so the engineer never announces an unclassified incident.
  if (state.incidentBurstType !== null && state.incidentBurstDelta > 0) {
    emit({
      event: "incident.occurred",
      data: {
        delta: state.incidentBurstDelta,
        points: incidentTypeValue(state.incidentBurstType, collisionCarValue),
        type: state.incidentBurstType,
      },
    });
  }

  clearIncidentBurst(state);
}

export function diffIncidents(
  state: TranslatorState,
  telemetry: TelemetryData,
  now: number,
  emit: EmitFn,
  collisionCarValue: number = COLLISION_CAR_VALUE_PAVEMENT,
): void {
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

    // Start a new burst or extend the in-flight one — for EVERY positive
    // delta, typed or not (#938: the capture showed the report byte can
    // trail its count increment, so dropping an untyped delta here lost
    // real incidents; the late-type branch below supplies the type
    // moments later). Most-recent type wins — a typical incident
    // progresses light → heavy (off-track → collision-car) so the latest
    // classification is the most informative one to announce.
    if (state.incidentBurstFirstAt === 0) {
      state.incidentBurstFirstAt = now;
    }

    if (resolvedType !== null) {
      state.incidentBurstType = resolvedType;
    }

    state.incidentBurstDelta += delta;
    state.incidentBurstLatestAt = now;
  } else if (
    currentType !== null &&
    state.incidentBurstFirstAt > 0 &&
    now - state.incidentBurstLatestAt <= INCIDENT_LATE_TYPE_MS
  ) {
    // The report byte can land 1–2 frames AFTER its count increment
    // (#938 capture, sequence C). Adopt it into the pending burst and
    // consume the latch — it belongs to the increment just recorded, not
    // to some future count change. The tight window keeps an unrelated
    // later report (e.g. a 0x contact that moves no count) from
    // repainting a burst it doesn't belong to.
    state.incidentBurstType = currentType;
    state.pendingIncidentType = null;
    state.pendingIncidentTypeAt = 0;
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
      flushIncidentBurst(state, emit, collisionCarValue);
    }
  }
}
