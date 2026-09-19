/**
 * Start-light transitions + pre-start numeric countdown (issues #480 / #673 /
 * #829).
 *
 * Two independent pieces, both driven off `SessionFlags` / `SessionState` /
 * `SessionTimeRemain` and the session YAML helpers — split into two diff
 * functions because the translator runs them on opposite sides of the replay
 * guard (issue #829):
 *
 *   1. **Gantry rising edges** (`diffStartLights`, post-guard — in-car only).
 *      `StartReady` / `StartGo` each fire once on their off→on edge (vs
 *      `state.lastStartLightBits`). The procedure is Ready → Set → Go: the
 *      heads-up line belongs on `StartReady` (issue #673 — `StartSet` lights
 *      too late to be useful, so nothing is emitted for it). `StartReady` is
 *      standing-only: rolling starts hold the bit through Warmup→ParadeLaps
 *      too (rolling AI capture 2112), where the rolling-start family (#660)
 *      owns the lead-in. `StartGo` is suppressed while a caution episode is
 *      running, and for {@link RESTART_GO_GRACE_MS} after one ended (issue
 *      #1127): a restart raises the very same bit, so without that gate every
 *      restart borrowed the race start's line — see the comment at the emit
 *      for the ordering it depends on.
 *
 *   2. **Numeric countdown** (`diffStartCountdown`, PRE-guard — issue #829:
 *      the countdown is the "get in the car" reminder, so it must keep
 *      running while the user sits in the garage / session screen / replay
 *      view, where iRacing reports `IsReplayPlaying: true`). A
 *      `SessionTimeRemain` countdown that runs in the standing pre-start
 *      window — `standing ∧ SessionState ∈ {GetInCar, Warmup} ∧ ¬(StartSet ∨
 *      StartGo) ∧ SessionTimeRemain>0`. `SessionTimeRemain` is the real
 *      time-to-lights from `GetInCar` onward (issue #666), so the window
 *      opens at `GetInCar` and closes once `StartSet`/`StartGo` light — the
 *      gantry owns the final moment. `StartReady` deliberately does NOT close
 *      the window: the standing capture (2056) shows it's up while the
 *      countdown runs. On the first in-window tick the ceiling is seeded from
 *      `SessionTimeRemain` so only thresholds the window can actually reach
 *      fire; each tick emits ONLY the smallest newly-crossed threshold so a
 *      dropped tick never produces a stale burst. AI races are NOT suppressed
 *      (issue #666) — the ceiling seed already keeps a compressed pre-start
 *      window from speaking a number it can't reach.
 *
 * Both diffs seed silently and share no state: the gantry seeds its edge
 * baseline on its first tick, and the countdown consumes its first IN-WINDOW
 * sample as a silent observation before its ceiling may anchor (the
 * window-entry `SessionTimeRemain` can be a scheduled value an AI session
 * collapses right after — capture 2056). Countdown state resets whenever the diff observes a tick
 * outside the window after the window was active, so a re-grid counts down
 * again — and it is deliberately preserved across `wipeStateForReplay`
 * (issue #829) so a garage↔car flip mid-countdown can neither drop a
 * boundary mark (a re-seed would lower the ceiling) nor replay a spoken one.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** The two gantry bits we edge-detect, masked out of `SessionFlags`. */
const START_LIGHT_MASK = Flags.StartReady | Flags.StartGo;

/**
 * How long after `caution.restarted` a rising `StartGo` is still the
 * restart's, not a race start's (issue #1127). The measured restarts raise
 * `Green` and `StartGo` on ONE tick, where the live caution phase already
 * holds the line down; this window covers the ordering nobody has measured
 * but the flag diff already guards for the race start through `StartSet` —
 * the go bit trailing the green by a tick — which would otherwise re-speak
 * the restart as "Go, go, go!" a tick after "Green, green, green!". A second
 * is a tick's worth of slack fifty times over, and no race start can follow
 * a caution restart within it.
 */
export const RESTART_GO_GRACE_MS = 1000;

/** Countdown thresholds (seconds), descending — drives smallest-of-many emit. */
const COUNTDOWN_THRESHOLDS = [90, 60, 30, 10] as const;

/**
 * `now` is the tick's clock (ms), measured against the restart stamp
 * `diffCaution` leaves in `state.cautionRestartedAt`. Defaulted for the tests
 * that drive no restart; the translator always passes its own.
 */
export function diffStartLights(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
  now: number = Date.now(),
): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const standing = resolveStandingStart(sessionInfo);

  const startBits = sessionFlags & START_LIGHT_MASK;

  // First tick — seed the gantry baseline without firing.
  if (!state.startLightInitialized) {
    state.startLightInitialized = true;
    state.lastStartLightBits = startBits;

    return;
  }

  const prevBits = state.lastStartLightBits;
  const rising = (flag: number): boolean => (startBits & flag) !== 0 && (prevBits & flag) === 0;

  // Standing-only: rolling starts raise StartReady through the formation too,
  // but there's no gantry start — the rolling-start family owns that lead-in.
  if (standing && rising(Flags.StartReady)) {
    emit({ event: "startLight.start-ready.raised", data: {} });
  }

  // A caution restart carries `StartGo` exactly as a race start does — the
  // measured restart tick is `Green | Servicible | StartGo` (issue #1127) — so
  // the bit alone cannot tell the two apart and every restart borrowed the race
  // start's line. `state.cautionPhase` is what separates them: a race start
  // finds no caution episode running, while a restart is the end of one and
  // `caution.restarted` speaks for it.
  //
  // ORDERING: `diffCaution` ends the episode on the green's own rising edge —
  // the same tick this bit rises — so it must run AFTER this diff, or the phase
  // is already back to `"none"` when the go edge is judged. The translator
  // wires that order and `start-lights.test.ts` pins it.
  //
  // The phase covers the measured same-tick ordering. A `StartGo` that TRAILS
  // the green by a tick finds the phase already `"none"`, so the restart's
  // stamp holds the line down for `RESTART_GO_GRACE_MS` after it — the same
  // shape as the flag diff guarding the race-start green through `StartSet`.
  const restartJustEnded = state.cautionRestartedAt !== null && now - state.cautionRestartedAt <= RESTART_GO_GRACE_MS;

  if (rising(Flags.StartGo) && state.cautionPhase === "none" && !restartJustEnded) {
    emit({ event: "startLight.start-go.raised", data: {} });
  }

  state.lastStartLightBits = startBits;
}

export function diffStartCountdown(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const timeRemain = typeof telemetry.SessionTimeRemain === "number" ? telemetry.SessionTimeRemain : 0;
  const standing = resolveStandingStart(sessionInfo);

  // SessionTimeRemain is the real time-to-lights from GetInCar onward (issue
  // #666), so the window opens at GetInCar and closes once StartSet/StartGo
  // light — the gantry lines own the final moment. StartReady does NOT close
  // the window (it's up while the countdown runs — standing capture 2056).
  // Race-only gating is handled at the scenario `where:` layer, not here; the
  // in-car gate was deliberately removed (issue #829).
  const inWindow =
    standing &&
    (sessionState === SessionState.GetInCar || sessionState === SessionState.Warmup) &&
    !hasFlag(sessionFlags, Flags.StartSet) &&
    !hasFlag(sessionFlags, Flags.StartGo) &&
    timeRemain > 0;

  if (!inWindow) {
    // Reset on exit from the pre-start window (StartGo / SessionState→Racing /
    // session change / any out-of-window tick) so a re-grid counts down again.
    if (state.startCountdownCeiling !== null || state.startCountdownFired.size > 0) {
      state.startCountdownCeiling = null;
      state.startCountdownFired.clear();
    }

    return;
  }

  // First IN-WINDOW tick a fresh state sees — consume as a silent observation
  // (every diff's seed-silently convention). The window-entry SessionTimeRemain
  // can be a scheduled value an AI session collapses right after (capture
  // 2056: 262 s → 1.02 s); anchoring the ceiling on it would fire a stale
  // bottom mark on the collapse. Gated AFTER the window check so out-of-window
  // startup ticks can't consume it (PR #830 review), and once per state
  // lifetime (not per window entry) so the #666 blip-reset semantics — window
  // re-entry re-seeds the ceiling immediately — stay unchanged.
  if (!state.startCountdownObserved) {
    state.startCountdownObserved = true;

    return;
  }

  // First in-window tick after the observation — seed the ceiling (highest
  // eligible threshold).
  const ceiling = state.startCountdownCeiling ?? timeRemain;
  state.startCountdownCeiling = ceiling;

  const candidates = COUNTDOWN_THRESHOLDS.filter(
    (t) => t <= ceiling && timeRemain <= t && !state.startCountdownFired.has(t),
  );

  if (candidates.length === 0) return;

  // Mark every crossed threshold fired, but emit ONLY the smallest (the
  // most-recent crossing) so a dropped tick never replays a stale burst.
  for (const t of candidates) state.startCountdownFired.add(t);

  // COUNTDOWN_THRESHOLDS is descending and `filter` preserves order, so the
  // smallest crossed threshold is the last candidate.
  const smallest = candidates[candidates.length - 1];
  emit({ event: "startLight.countdown.raised", data: { seconds: smallest } });
}
