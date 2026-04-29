/**
 * Pit-service readback diff (issue #476).
 *
 * Emits `pitService.readbackRequested` at three moments during a pit stop,
 * each carrying a committed snapshot of the queued services so the
 * downstream `pit-readback-{entry,exit}` audio scenarios stay pure (no
 * live telemetry reads from inside the DSL):
 *
 *   - "entry"        — `OnPitRoad` off→on transition. The engineer starts
 *                      the readback as the car rolls onto pit road.
 *   - "entry-refire" — any user-intent pit-service toggle while still on
 *                      pit road. The running readback (family
 *                      `"pit-readback"`) is preempted and replaced with
 *                      the new snapshot.
 *   - "exit"         — `OnPitRoad` on→off, plus `PIT_READBACK_EXIT_DELAY_MS`
 *                      settle delay so the "to confirm" beat doesn't
 *                      collide with the limiter / pit-exit chatter.
 *
 * Snapshot capture is decoupled from live telemetry at exit: `committed`
 * is captured on entry and refreshed on every user-intent toggle event,
 * but never on bit-cleared transitions (which represent the crew finishing
 * service, not the driver un-queueing). At exit time we reuse the last
 * committed snapshot so the readback faithfully recaps what was queued —
 * even though `PitSvFlags` itself has cleared.
 *
 * User-intent detection: this module runs after `diffToggles` in the
 * tick pipeline, so it inspects the per-tick `pending` queue for
 * `pitService.toggled` / `tireService.changed` / `tireService.compoundChanged`
 * events. Those events fire only on debounced user toggles (the seed-during-
 * stall branch in `diffToggles` silently absorbs the crew's bit-clears),
 * which is exactly the signal we want.
 */
import { EngineWarnings, PaceMode, PitSvFlags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { PitReadbackCommittedSnapshot, TranslatorState } from "../state.js";
import type { EmitFn, PendingEvent } from "./types.js";

/**
 * Settle delay between `pitLane.exited` and the "to confirm" readback fire.
 * Mid-range of the user's 3-6 s window; long enough to not collide with the
 * limiter / pit-exit voice chatter, short enough to feel like a coherent
 * follow-up to the pit stop. The pit-action confirmation cooldown after
 * pit-lane exit shares this window so per-toggle confirmations don't blurt
 * over the pending readback.
 *
 * @internal Exported for testing.
 */
export const PIT_READBACK_EXIT_DELAY_MS = 4500;

/**
 * Pre-start grace window. Counts from the moment iRacing transitions into
 * pre-start (PaceMode = single/double-file start AND SessionState =
 * ParadeLaps | Warmup | GetInCar). During this window the per-toggle
 * confirmation scenarios stay silent so iRacing's grid-load pit-flag
 * seeding doesn't surface as phantom "we're refueling" callouts. The
 * auto-readback fires at the end of the window so the driver hears the
 * queued plan before the green flag.
 *
 * @internal Exported for testing.
 */
export const PIT_READBACK_PRESTART_DELAY_MS = 5000;

/**
 * iRacing pre-start detection. Mirrors the `ir_isPreStart()` helper from
 * the open-source pit-board project — `PaceMode` alone is unreliable
 * because iRacing doesn't reset it to `NotPacing` once the green drops,
 * so we AND it with the session-state phases that bracket the formation
 * lap.
 */
function isInPreStart(telemetry: TelemetryData): boolean {
  const paceMode = telemetry.PaceMode ?? -1;
  const sessionState = telemetry.SessionState ?? -1;
  const inFormationPace = paceMode === PaceMode.SingleFileStart || paceMode === PaceMode.DoubleFileStart;
  const inGridSessionState =
    sessionState === SessionState.ParadeLaps ||
    sessionState === SessionState.Warmup ||
    sessionState === SessionState.GetInCar;

  return inFormationPace && inGridSessionState;
}

const TIRE_FLAGS_MASK =
  PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

function buildSnapshot(telemetry: TelemetryData): PitReadbackCommittedSnapshot {
  const flags = telemetry.PitSvFlags ?? 0;
  const compound = telemetry.PitSvTireCompound ?? 0;
  const playerCompound = telemetry.PlayerTireCompound ?? 0;
  const limiter = ((telemetry.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
  const hasAnyTireBit = (flags & TIRE_FLAGS_MASK) !== 0;
  // Mirror `service-reminder.ts` `isCompoundChange`: only count compound as
  // "changing" when tires are queued AND the queued compound differs from
  // what's on the car. iRacing exposes 0=dry, 1=wet.
  const isCompoundChange = hasAnyTireBit && compound !== playerCompound;

  return {
    fuel: { queued: (flags & PitSvFlags.FuelFill) !== 0 },
    tires: {
      lf: (flags & PitSvFlags.LFTireChange) !== 0,
      rf: (flags & PitSvFlags.RFTireChange) !== 0,
      lr: (flags & PitSvFlags.LRTireChange) !== 0,
      rr: (flags & PitSvFlags.RRTireChange) !== 0,
    },
    compoundChange: isCompoundChange ? { from: playerCompound, to: compound } : null,
    fastRepair: {
      queued: (flags & PitSvFlags.FastRepair) !== 0,
      available: (telemetry.FastRepairAvailable ?? 0) > 0,
    },
    // Windshield availability is not exposed by iRacing telemetry. v1
    // defaults to `true` (the readback says "no windshield" when the
    // tearoff bit isn't set). Series-specific gating can land later
    // alongside a session-info parser.
    windshield: {
      queued: (flags & PitSvFlags.WindshieldTearoff) !== 0,
      available: true,
    },
    limiterEngaged: limiter,
  };
}

/**
 * @internal Exported for testing — confirms the snapshot shape the
 * readback scenarios consume.
 */
export { buildSnapshot };

const USER_TOGGLE_EVENTS = new Set<PendingEvent["event"]>([
  "pitService.toggled",
  "tireService.changed",
  "tireService.compoundChanged",
]);

export function diffPitReadback(
  state: TranslatorState,
  telemetry: TelemetryData,
  now: number,
  emit: EmitFn,
  pending: ReadonlyArray<PendingEvent>,
): void {
  // `state.lastOnPitRoad` was just updated by `diffPitLane` earlier in the
  // tick — it carries the CURRENT tick's value. We track our own previous
  // value so we can detect off→on / on→off transitions.
  const onPitRoad = state.lastOnPitRoad;
  const inPreStart = isInPreStart(telemetry);

  if (!state.pitReadbackInitialized) {
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = onPitRoad;
    state.pitReadbackExitFireAt = 0;
    state.lastTickInPreStart = inPreStart;

    return;
  }

  const wasOnPitRoad = state.pitReadbackPrevOnPitRoad;
  const wasInPreStart = state.lastTickInPreStart;

  // Pending exit fire whose delay has elapsed? Reads telemetry FRESH at
  // fire time — the user might have toggled services after pulling out
  // of the stall (or the crew might have completed work), so the recap
  // reflects what's actually queued at the moment the engineer speaks
  // rather than a frozen snapshot from earlier in the visit.
  if (state.pitReadbackExitFireAt > 0 && now >= state.pitReadbackExitFireAt) {
    const exitSnap = buildSnapshot(telemetry);
    emit({
      event: "pitService.readbackRequested",
      data: { reason: "exit", ...exitSnap },
    });
    state.pitReadbackExitFireAt = 0;
  }

  // Pending pre-start fire whose delay has elapsed? Only fires while still
  // in pre-start — if the user dropped out (e.g. left the car / session
  // changed) the queued readback is dropped silently.
  if (
    state.pitReadbackPreStartFireAt > 0 &&
    now >= state.pitReadbackPreStartFireAt &&
    state.pitReadbackPreStartSnapshot &&
    inPreStart
  ) {
    emit({
      event: "pitService.readbackRequested",
      data: { reason: "entry", ...state.pitReadbackPreStartSnapshot },
    });
    state.pitReadbackPreStartFireAt = 0;
    state.pitReadbackPreStartSnapshot = null;
  } else if (state.pitReadbackPreStartFireAt > 0 && !inPreStart) {
    // Left pre-start before the timer elapsed — cancel.
    state.pitReadbackPreStartFireAt = 0;
    state.pitReadbackPreStartSnapshot = null;
  }

  if (!wasOnPitRoad && onPitRoad) {
    // Off → on: cancel any stale scheduled exit (re-entry within the delay
    // window) and emit the entry readback.
    state.pitReadbackExitFireAt = 0;

    const snap = buildSnapshot(telemetry);
    emit({ event: "pitService.readbackRequested", data: { reason: "entry", ...snap } });
  } else if (onPitRoad && pending.some((p) => USER_TOGGLE_EVENTS.has(p.event))) {
    // While on pit road, any user-intent toggle event refires the
    // readback. Family preemption (`family: "pit-readback"`) cuts the
    // in-flight readback cleanly.
    const snap = buildSnapshot(telemetry);
    emit({ event: "pitService.readbackRequested", data: { reason: "entry-refire", ...snap } });
  } else if (wasOnPitRoad && !onPitRoad) {
    // On → off: schedule the delayed "to confirm" fire. The snapshot is
    // built fresh at fire time so a user toggle late in the visit
    // (e.g. cancelling tires while sitting in the box) is reflected
    // in the recap. Pit-action confirmations stay silent for the same
    // window so they don't blurt over the pending readback.
    state.pitReadbackExitFireAt = now + PIT_READBACK_EXIT_DELAY_MS;

    state.pitActionCooldownUntil = Math.max(state.pitActionCooldownUntil, now + PIT_READBACK_EXIT_DELAY_MS);
  }

  if (!wasInPreStart && inPreStart) {
    // Just entered the formation / grid window. Mute pit-action callouts
    // for the cooldown duration and schedule the auto-readback so the
    // driver hears the queued plan unprompted before the green flag.
    state.pitActionCooldownUntil = Math.max(state.pitActionCooldownUntil, now + PIT_READBACK_PRESTART_DELAY_MS);
    state.pitReadbackPreStartFireAt = now + PIT_READBACK_PRESTART_DELAY_MS;
    state.pitReadbackPreStartSnapshot = buildSnapshot(telemetry);
  }

  state.pitReadbackPrevOnPitRoad = onPitRoad;
  state.lastTickInPreStart = inPreStart;
}
