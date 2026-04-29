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
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { PitReadbackCommittedSnapshot, TranslatorState } from "../state.js";
import type { EmitFn, PendingEvent } from "./types.js";

/**
 * Settle delay between `pitLane.exited` and the "to confirm" readback fire.
 * Mid-range of the user's 3-6 s window; long enough to not collide with the
 * limiter / pit-exit voice chatter, short enough to feel like a coherent
 * follow-up to the pit stop.
 *
 * @internal Exported for testing.
 */
export const PIT_READBACK_EXIT_DELAY_MS = 4500;

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

  if (!state.pitReadbackInitialized) {
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = onPitRoad;
    state.pitReadbackExitFireAt = 0;
    // If the translator boots while the car is already on pit road, seed
    // the committed snapshot so a refire / exit later this lane visit has
    // something to publish. We don't synthesize an "entry" event from the
    // seed — no transition happened.
    state.pitReadbackCommittedSnapshot = onPitRoad ? buildSnapshot(telemetry) : null;

    return;
  }

  const wasOnPitRoad = state.pitReadbackPrevOnPitRoad;

  // Pending exit fire whose delay has elapsed?
  if (state.pitReadbackExitFireAt > 0 && now >= state.pitReadbackExitFireAt && state.pitReadbackCommittedSnapshot) {
    emit({
      event: "pitService.readbackRequested",
      data: { reason: "exit", ...state.pitReadbackCommittedSnapshot },
    });
    state.pitReadbackExitFireAt = 0;
    state.pitReadbackCommittedSnapshot = null;
  }

  if (!wasOnPitRoad && onPitRoad) {
    // Off → on: cancel any stale scheduled exit (re-entry within the delay
    // window) and emit the entry readback.
    state.pitReadbackExitFireAt = 0;

    const snap = buildSnapshot(telemetry);
    state.pitReadbackCommittedSnapshot = snap;
    emit({ event: "pitService.readbackRequested", data: { reason: "entry", ...snap } });
  } else if (onPitRoad && pending.some((p) => USER_TOGGLE_EVENTS.has(p.event))) {
    // While on pit road, any user-intent toggle event refreshes the
    // committed snapshot and refires the readback. Family preemption
    // (`family: "pit-readback"`) cuts the in-flight readback cleanly.
    const snap = buildSnapshot(telemetry);
    state.pitReadbackCommittedSnapshot = snap;
    emit({ event: "pitService.readbackRequested", data: { reason: "entry-refire", ...snap } });
  } else if (wasOnPitRoad && !onPitRoad) {
    // On → off: schedule the delayed "to confirm" fire. Reuses the last
    // committed snapshot — by this tick `PitSvFlags` may have cleared
    // (crew finished service), but the snapshot still carries the queued
    // intent from earlier in the visit.
    if (state.pitReadbackCommittedSnapshot) {
      state.pitReadbackExitFireAt = now + PIT_READBACK_EXIT_DELAY_MS;
    }
  }

  state.pitReadbackPrevOnPitRoad = onPitRoad;
}
