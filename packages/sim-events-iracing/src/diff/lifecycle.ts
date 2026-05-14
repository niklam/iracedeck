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
  // Strict `>` so a session reset (e.g. practice → race flips Lap 12 → 1)
  // doesn't synthesize a fake `lap.started` event.
  if (lap > 0 && state.lastLap > 0 && lap > state.lastLap) {
    emit({ event: "lap.started", data: { lap } });
  }

  state.lastLap = lap;
}
