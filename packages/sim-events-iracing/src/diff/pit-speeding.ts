/**
 * Pit-road speeding episode edges (issue #912).
 *
 * Emits:
 *   - pitSpeeding.started — the player just went over the posted pit-lane
 *     speed limit while on pit road.
 *   - pitSpeeding.ended   — any part of that condition stopped holding.
 *
 * Deliberately separate from `diff/limiter.ts` rather than another branch in
 * it. `diffLimiter` is an early-return ladder, and on any tick where
 * `limiter.missing` or `limiter.dropped` fires it returns before reaching its
 * speeding check — so a start edge placed there would be swallowed on exactly
 * the ticks a driver is most likely to be speeding: arriving on pit road with
 * the limiter off.
 *
 * Three deliberate differences from `limiter.speeding`, which this does NOT
 * replace:
 *   - No speed margin. `limiter.speeding` allows +1 m/s; this fires strictly
 *     above the posted limit, because the pit limiter holds cars slightly
 *     UNDER it — so riding the limiter stays silent and anything above the
 *     limit is a real offence.
 *   - No creep guard. A car creeping is under the limit anyway; the speed
 *     comparison already covers it.
 *   - No `hasPitLimiter` gate. Pit-road penalties apply to every car, and a
 *     car with no limiter is the one that most needs telling (#639 gated the
 *     voice line because its limiter WORDING is meaningless there — that
 *     reasoning does not carry to a tick).
 *
 * The `ended` edge is the one that matters: a consumer holds a looping tick
 * for the length of the episode, so a missed `ended` leaves audio running
 * with no way to stop it. This module guarantees it for every exit reachable
 * from a tick; the translator's disconnect / session-change / replay
 * teardowns cover the exits that stop ticks reaching us at all.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Dead band below the limit that the speed must fall through before the
 * episode ends (m/s, ≈0.7 km/h). Applied to the END edge only: the start is
 * strictly above the limit, so a speed hovering exactly on it cannot flutter
 * start/end at tick rate. The other exit conditions need no hysteresis —
 * there is nothing noisy about leaving pit road.
 */
export const PIT_SPEEDING_HYSTERESIS_MPS = 0.2;

/**
 * End an in-flight episode, if there is one. Exported for the translator's
 * teardown paths (disconnect, session change, replay), which must emit the
 * closing edge BEFORE wiping the state that carries it — post-wipe the state
 * already reads inactive and the edge is silently lost.
 */
export function endPitSpeedingIfActive(state: TranslatorState, emit: EmitFn): void {
  if (!state.pitSpeedingActive) return;

  state.pitSpeedingActive = false;
  emit({ event: "pitSpeeding.ended", data: {} });
}

export function diffPitSpeeding(
  state: TranslatorState,
  telemetry: TelemetryData,
  pitSpeedLimitMps: number,
  emit: EmitFn,
): void {
  const isOnTrack = telemetry.IsOnTrack ?? false;
  const onPitRoad = telemetry.OnPitRoad ?? false;
  const inPitStall = telemetry.PlayerCarInPitStall ?? false;

  // A missing Speed read ends an episode rather than sustaining it. This is
  // the one place the usual "unknown telemetry keeps the callout alive" rule
  // is inverted on purpose: the claim being made is that the driver IS
  // speeding, and that cannot be asserted without a speed. Failing to silence.
  const speed = telemetry.Speed ?? 0;

  // `pitSpeedLimitMps` is 0 when `WeekendInfo.TrackPitSpeedLimit` is missing
  // or unparsed, and is reset to 0 on a track/session change before being
  // re-parsed — so this term is load-bearing, not defensive. Without it a
  // track whose YAML we cannot read would beep continuously.
  const eligible = isOnTrack && onPitRoad && !inPitStall && pitSpeedLimitMps > 0;

  if (!eligible) {
    endPitSpeedingIfActive(state, emit);

    return;
  }

  if (state.pitSpeedingActive) {
    if (speed <= pitSpeedLimitMps - PIT_SPEEDING_HYSTERESIS_MPS) {
      state.pitSpeedingActive = false;
      emit({ event: "pitSpeeding.ended", data: {} });
    }

    return;
  }

  // No seed branch, by design. `pitSpeedingActive` starts false on a fresh
  // state, which makes the first tick observing the condition a real start
  // edge — so connecting, reconnecting or restarting the plugin mid-offence
  // starts the cue instead of silently seeding past it. A repeating callout
  // must be driven by current state; only a one-shot may be edge-driven
  // (the #951 rule). See the field's JSDoc in `state.ts`.
  if (speed > pitSpeedLimitMps) {
    state.pitSpeedingActive = true;
    emit({ event: "pitSpeeding.started", data: {} });
  }
}
