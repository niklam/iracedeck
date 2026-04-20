/**
 * Session-level lifecycle events.
 *
 * Emits:
 *   - driver.firstOnTrack — the first tick where IsOnTrack is true per
 *     translator lifetime (cleared on disconnect).
 *   - session.changed { from, to } — SessionNum delta.
 *   - engine.startup — RPM jumps from 0 to >0 (engine ignited).
 *   - lap.started { lap } — Lap counter increments.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

const ENGINE_STARTUP_RPM_THRESHOLD = 200;

export function diffLifecycle(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const isOnTrack = telemetry.IsOnTrack ?? false;

  // ── First time on track this lifetime ──────────────────────────────────
  if (!state.firstOnTrackFired && isOnTrack) {
    state.firstOnTrackFired = true;
    emit({ event: "driver.firstOnTrack", data: {} });
  }

  // ── Session change ─────────────────────────────────────────────────────
  const sessionNum = typeof telemetry.SessionNum === "number" ? telemetry.SessionNum : null;

  if (sessionNum !== null) {
    if (state.lastSessionNum !== null && sessionNum !== state.lastSessionNum) {
      emit({ event: "session.changed", data: { from: state.lastSessionNum, to: sessionNum } });
    }

    state.lastSessionNum = sessionNum;
  }

  // ── Engine startup (RPM 0 → >threshold) ────────────────────────────────
  const rpm = typeof telemetry.RPM === "number" ? telemetry.RPM : 0;
  const engineRunning = rpm > ENGINE_STARTUP_RPM_THRESHOLD;

  if (!state.lastEngineRunning && engineRunning) {
    emit({ event: "engine.startup", data: {} });
  }

  state.lastEngineRunning = engineRunning;

  // ── Lap started ────────────────────────────────────────────────────────
  const lap = typeof telemetry.Lap === "number" ? telemetry.Lap : -1;

  if (lap > 0 && state.lastLap > 0 && lap !== state.lastLap) {
    emit({ event: "lap.started", data: { lap } });
  }

  state.lastLap = lap;
}
