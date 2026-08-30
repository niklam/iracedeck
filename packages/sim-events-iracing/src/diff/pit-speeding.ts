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
 * How long the speed must stay at or under the limit before an in-flight
 * episode ends (ms). Applied to the SPEED exit only — the other exits end the
 * episode immediately, because there is nothing noisy about leaving pit road
 * and #912's must-always-end guarantee depends on those staying instant.
 *
 * This replaced a 0.2 m/s dead band BELOW the limit (issue #1059). Damping a
 * threshold in the dimension it measures necessarily makes some genuine
 * values silent, and that band sat exactly where a compliant driver holds:
 * once over, backing off to just under the limit could not stop the cue.
 * Damping in time costs no speed precision — jitter dies because it is brief,
 * not because a range of real speeds was declared silent.
 *
 * PROVISIONAL VALUE: one cue-loop interval (`PIT_SPEEDING_TICK_INTERVAL_MS`),
 * so at most one extra beep can sound past the moment of compliance — the
 * smallest increment a listener can actually perceive. The spec
 * (`docs/superpowers/specs/2026-08-30-issue-1059-pit-speeding-precision.md`)
 * records that the right value is a measurement rather than a taste, and
 * names the `telemetry-watch` capture that would settle it. Lower it if that
 * capture shows a shorter hold already damps the flapping.
 */
export const PIT_SPEEDING_END_HOLD_MS = 300;

/**
 * End an in-flight episode, if there is one.
 *
 * Module-local on purpose: the translator's teardown paths (disconnect,
 * session change, replay) close the same episode, but they run outside a tick
 * and publish directly rather than through an `EmitFn`, so they cannot share
 * this. Their copy lives in `publishActiveStateTeardown` — the two are the
 * only places that clear `pitSpeedingActive`, and both must emit the closing
 * edge BEFORE the state carrying it is wiped.
 */
function endPitSpeedingIfActive(state: TranslatorState, emit: EmitFn): void {
  if (!state.pitSpeedingActive) return;

  state.pitSpeedingActive = false;
  state.pitSpeedingUnderLimitSince = 0;
  emit({ event: "pitSpeeding.ended", data: {} });
}

export function diffPitSpeeding(
  state: TranslatorState,
  telemetry: TelemetryData,
  pitSpeedLimitMps: number,
  replayOnlySession: boolean,
  now: number,
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
  // `replayOnlySession` is a term of eligibility rather than an early return,
  // so a session that turns out to be replay-only ENDS an episode already in
  // flight instead of stranding it (the diff would otherwise stop running with
  // `pitSpeedingActive` still true). A paused or frame-scrubbed replay reads
  // `IsReplayPlaying === false` while `SimMode === "replay"`, so those ticks
  // reach this diff past the translator's main replay guard — the
  // `diffPitsOpen` / `diffFuelLaps` precedent (#604, #655).
  const eligible = !replayOnlySession && isOnTrack && onPitRoad && !inPitStall && pitSpeedLimitMps > 0;

  if (!eligible) {
    endPitSpeedingIfActive(state, emit);

    return;
  }

  if (state.pitSpeedingActive) {
    // The speed exit is held: the episode ends only once the car has been at
    // or under the limit continuously for PIT_SPEEDING_END_HOLD_MS. A single
    // tick back over the limit restarts the hold, so a speed oscillating
    // across the limit yields one continuous tone rather than a stutter of
    // restarted clips — the flapping this damps is the END edge, which is why
    // there is no matching hold on the start.
    if (speed <= pitSpeedLimitMps) {
      // 0 is the not-tracking sentinel, matching `speedingWarnedAt` and
      // `pitStatusRestSince` in this state object.
      if (state.pitSpeedingUnderLimitSince === 0) state.pitSpeedingUnderLimitSince = now;

      if (now - state.pitSpeedingUnderLimitSince >= PIT_SPEEDING_END_HOLD_MS) {
        endPitSpeedingIfActive(state, emit);
      }
    } else {
      state.pitSpeedingUnderLimitSince = 0;
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
