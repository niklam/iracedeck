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
 *   - No blanket speed margin. `limiter.speeding` allows +1 m/s unconditionally;
 *     here the comparison is exact for a car whose limiter is not engaged,
 *     because that driver must lift and precision is the whole point. A car
 *     under an ENGAGED limiter gets `PIT_SPEEDING_LIMITER_BUFFER_MPS` instead,
 *     for the reason on that constant: its driver has no remedy left to apply.
 *     (#912 asserted a limiter holds cars UNDER the limit and so needed no
 *     margin at all. The manual test disproved it — a limiter car sits AT the
 *     limit; issue #1059.)
 *   - No creep guard. A car creeping is under the limit anyway; the speed
 *     comparison already covers it.
 *   - No `hasPitLimiter` gate. Pit-road penalties apply to every car, and a
 *     car with no limiter is the one that most needs telling (#639 gated the
 *     voice line because its limiter WORDING is meaningless there — that
 *     reasoning does not carry to a tick). Note the buffer above keys on the
 *     limiter being ENGAGED (`EngineWarnings`), never on `hasPitLimiter`,
 *     which only says the car HAS the system — a different question.
 *
 * The `ended` edge is the one that matters: a consumer holds a looping tick
 * for the length of the episode, so a missed `ended` leaves audio running
 * with no way to stop it. This module guarantees it for every exit reachable
 * from a tick; the translator's disconnect / session-change / replay
 * teardowns cover the exits that stop ticks reaching us at all.
 */
import { EngineWarnings, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Buffer added to the start threshold while the pit limiter is ENGAGED
 * (0.3 km/h in m/s, issue #1059).
 *
 * #912 rejected a start-edge margin on the grounds that "the pit limiter
 * holds cars below the limit, so a margin only delays telling a driver who is
 * already committing an offence". The manual test killed both halves: a
 * limiter car sits AT the limit, and — the part the premise assumed away —
 * its driver has no remedy left. They cannot lift; the car is already doing
 * the only thing available. So the cue there is not a warning, it is noise
 * about a condition already handled. The rejected margin was about not
 * DELAYING a warning to someone who could act; this is about not warning
 * someone who cannot.
 *
 * Deliberately conditional on equipment, mirroring #1051's split for the same
 * reason: the remedy differs by equipment. A car with no limiter keeps the
 * exact comparison, because there the driver must lift and "VERY precise" is
 * the whole requirement.
 *
 * Chosen over gating the cue entirely on the limiter, because a limiter is
 * engaged BEFORE the car has slowed — through the pit-entry deceleration the
 * limiter is on and the car is substantially over, which is the moment the
 * warning is worth most. A gate would silence exactly that stretch. The
 * deciding rule, though, is that the buffer is correct under BOTH readings of
 * that (unmeasured) claim, while the gate needs it settled first.
 */
export const PIT_SPEEDING_LIMITER_BUFFER_MPS = 0.3 / 3.6;

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
 * PROVISIONAL VALUE, and provisional in the direction that matters. 300 ms
 * equals the cue cadence *as it stands* — `PIT_SPEEDING_TICK_INTERVAL_MS` in
 * `@iracedeck/audio-scenarios`, hand-copied rather than imported because that
 * package depends on this one. Treat it as an independent choice that happens
 * to match, not a derived one: if the cadence is ever retuned, nothing here
 * breaks and nothing tells you.
 *
 * That equality bounds only the cost of ending LATE — at most one extra beep
 * past compliance. It says nothing about the cost of ending too EARLY, which
 * is the flutter the old band existed to prevent, and the two costs are not
 * symmetric: `handleEnded` leaves the in-flight 160 ms clip playing, so a
 * restart landing inside it replaces that clip mid-tone and the driver hears
 * a click rather than a beep. The quantity that would settle the floor is how
 * long a driver's sub-limit excursions last while riding the limit, which is
 * unrelated to the cue cadence.
 *
 * **Accepted on the non-limiter path**, by listening rather than by
 * measurement: asked to provoke the truncation deliberately, the answer was
 * that it may well be happening, it is not reliably audible, and it is fine.
 * That is stronger than a clean pass, since it does not depend on the
 * listener's ear having been good enough. It is settled there, and the
 * `telemetry-watch` capture the spec names is no longer a prerequisite.
 *
 * It is NOT settled on the limiter path, where the criterion is absolute
 * silence at or under the limit — a question about correctness rather than
 * about perception, which no amount of "sounds fine" can answer. See the spec
 * (`docs/superpowers/specs/2026-08-30-issue-1059-pit-speeding-precision.md`).
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

  // A missing Speed read ends an episode rather than sustaining it, and does
  // so IMMEDIATELY: it is a term of `eligible` below rather than a 0 fed
  // through the held speed exit, so the hold can never buy 300 ms of
  // asserting an offence on evidence we do not have (#1059 — before this the
  // unknown-speed exit silently inherited the hold). This is the one place
  // the usual "unknown telemetry keeps the callout alive" rule is inverted on
  // purpose: the claim being made is that the driver IS speeding, and that
  // cannot be asserted without a speed. Failing to silence.
  //
  // `Number.isFinite` rather than a null check, and the difference is not
  // cosmetic: `NaN != null` is true, so a NaN speed would pass as "known" and
  // then satisfy NEITHER `speed <= threshold` NOR `speed > threshold`. An
  // in-flight episode would take the else-branch every tick, reset the hold,
  // and never end by the speed path at all — the one failure this module's
  // header says it must not have.
  const speedKnown = Number.isFinite(telemetry.Speed);
  const speed = speedKnown ? (telemetry.Speed as number) : 0;

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
  const eligible = !replayOnlySession && isOnTrack && onPitRoad && !inPitStall && pitSpeedLimitMps > 0 && speedKnown;

  if (!eligible) {
    endPitSpeedingIfActive(state, emit);

    return;
  }

  // The limiter buffer SHIFTS the threshold; it does not open a band around
  // it. Applying it to the start edge alone would put an unreachable gap
  // between `limit` and `limit + buffer` — an episode could start above the
  // buffer and never end until the car fell all the way to the bare limit,
  // which is this issue's original defect exactly, relocated upwards. Both
  // edges therefore compare against the same value, and it stays an exact
  // comparison either side of it.
  //
  // Read live rather than latched: if the limiter disengages mid-episode the
  // threshold drops to the bare limit on the next tick, which is right — the
  // driver has a remedy again, so exactness applies again.
  const limiterActive = ((telemetry.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
  const threshold = limiterActive ? pitSpeedLimitMps + PIT_SPEEDING_LIMITER_BUFFER_MPS : pitSpeedLimitMps;

  if (state.pitSpeedingActive) {
    // The speed exit is held: the episode ends only once the car has been at
    // or under the limit continuously for PIT_SPEEDING_END_HOLD_MS. A single
    // tick back over the limit restarts the hold, so a speed oscillating
    // across the limit yields one continuous tone rather than a stutter of
    // restarted clips — the flapping this damps is the END edge, which is why
    // there is no matching hold on the start.
    if (speed <= threshold) {
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
  if (speed > threshold) {
    state.pitSpeedingActive = true;
    emit({ event: "pitSpeeding.started", data: {} });
  }
}
