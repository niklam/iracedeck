/**
 * Pit limiter warnings.
 *
 * Emits:
 *   - limiter.missing — car on pit road, not in stall, not creeping, and
 *     either just entered pit road without the limiter engaged or just
 *     left the stall with the limiter still off.
 *   - limiter.dropped — limiter was engaged while on pit road and just
 *     turned off (driver disengaged it between the cones).
 *   - limiter.speeding — car is over the posted pit speed limit by more
 *     than SPEEDING_MARGIN_MPS, subject to a 5-second cooldown so the
 *     event doesn't stutter while the driver slows down.
 *
 * All three are suppressed while in the pit stall (limiter state is noisy
 * during service) and while the car is creeping (<5 m/s, into/out of box).
 */
import { EngineWarnings, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

const CREEPING_SPEED_MPS = 5;
const SPEEDING_COOLDOWN_MS = 5000;
const SPEEDING_MARGIN_MPS = 1.0;

export function diffLimiter(
  state: TranslatorState,
  telemetry: TelemetryData,
  pitSpeedLimitMps: number,
  now: number,
  emit: EmitFn,
): void {
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const limiter = ((telemetry.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
  const speed = telemetry.Speed ?? 0;

  if (!isOnTrack) {
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  if (!onPitRoad) {
    state.limiterInitialized = true;
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  // First on-track tick already on pit road — seed without firing. This
  // covers mid-session reconnects and replays that start in pit lane.
  if (!state.limiterInitialized) {
    state.limiterInitialized = true;
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  // Just-left-stall check BEFORE the in-stall bail — catches the exit transition.
  const justLeftStall = state.lastInPitStall && !inPitStall;

  if (justLeftStall && !limiter) {
    emit({ event: "limiter.missing", data: {} });
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  if (inPitStall) {
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  const isCreeping = speed < CREEPING_SPEED_MPS;

  const justEnteredPitRoad = !state.lastOnPitRoadForLimiter && onPitRoad;

  if (justEnteredPitRoad && !limiter && !isCreeping) {
    emit({ event: "limiter.missing", data: {} });
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  const limiterJustDropped = state.lastLimiterOnPitRoad && !limiter;

  if (limiterJustDropped && !isCreeping) {
    emit({ event: "limiter.dropped", data: {} });
    state.lastOnPitRoadForLimiter = onPitRoad;
    state.lastLimiterOnPitRoad = limiter;

    return;
  }

  if (
    pitSpeedLimitMps > 0 &&
    speed > pitSpeedLimitMps + SPEEDING_MARGIN_MPS &&
    now - state.speedingWarnedAt > SPEEDING_COOLDOWN_MS
  ) {
    state.speedingWarnedAt = now;
    emit({ event: "limiter.speeding", data: {} });
  }

  state.lastOnPitRoadForLimiter = onPitRoad;
  state.lastLimiterOnPitRoad = limiter;
}
