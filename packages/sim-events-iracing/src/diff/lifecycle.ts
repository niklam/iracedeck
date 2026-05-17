/**
 * Session-level lifecycle events.
 *
 * Emits:
 *   - session.changed { from, to } — SessionNum delta.
 *   - engine.startup — RPM jumps from 0 to >0 (engine ignited).
 *   - lap.started { lap } — Lap counter increments.
 *
 * `driver.firstOnTrack` is NOT emitted here — it's a connection-lifetime
 * milestone that must survive the per-tick state resets the replay guard
 * performs, so it lives in `diffFirstOnTrack` (in `translator.ts`) keyed off
 * translator-instance state rather than `TranslatorState`.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

const ENGINE_STARTUP_RPM_THRESHOLD = 200;

export function diffLifecycle(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const sessionNum = typeof telemetry.SessionNum === "number" ? telemetry.SessionNum : null;
  const rpm = typeof telemetry.RPM === "number" ? telemetry.RPM : 0;
  const engineRunning = rpm > ENGINE_STARTUP_RPM_THRESHOLD;
  const lap = typeof telemetry.Lap === "number" ? telemetry.Lap : -1;

  // First tick — seed from the current snapshot and bail. Without this,
  // connecting while the engine is already spinning would fire a bogus
  // `engine.startup`.
  if (!state.lifecycleInitialized) {
    state.lifecycleInitialized = true;
    state.lastSessionNum = sessionNum;
    state.lastEngineRunning = engineRunning;
    state.lastLap = lap;

    return;
  }

  // ── Session change ─────────────────────────────────────────────────────
  if (sessionNum !== null) {
    if (state.lastSessionNum !== null && sessionNum !== state.lastSessionNum) {
      emit({ event: "session.changed", data: { from: state.lastSessionNum, to: sessionNum } });
    }

    state.lastSessionNum = sessionNum;
  }

  // ── Engine startup (RPM 0 → >threshold) ────────────────────────────────
  if (!state.lastEngineRunning && engineRunning) {
    emit({ event: "engine.startup", data: {} });
  }

  state.lastEngineRunning = engineRunning;

  // ── Lap started ────────────────────────────────────────────────────────
  // Clear the post-pit-exit flag on ANY Lap change (issue #567) — not just
  // when `lap.started` fires below. The event has a `lastLap > 0` guard
  // that suppresses 0→1 transitions (iRacing can report `Lap=0` for the
  // first lap of a qualifying session, in which case the out-lap → flying-
  // lap-1 transition is 0→1 and `lap.started` would not fire). Tracking the
  // raw Lap delta here means the flag clears at any S/F crossing, including
  // session resets — that's fine because a fresh session re-arms the flag
  // through the next `pitLane.exited` anyway. If the new lap is itself a
  // from-pits lap (driver crosses S/F while in pit lane), the pit-lane diff
  // runs later in this same tick and sets the flag back.
  if (lap !== state.lastLap) {
    state.lapStartedFromPits = false;
  }

  // Strict `>` (with both-positive guard) so a session reset (e.g. practice
  // → race flips Lap 12 → 1) doesn't synthesize a fake `lap.started` event
  // for downstream consumers that listen for it.
  if (lap > 0 && state.lastLap > 0 && lap > state.lastLap) {
    emit({ event: "lap.started", data: { lap } });
  }

  state.lastLap = lap;
}
