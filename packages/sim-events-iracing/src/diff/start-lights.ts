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
 *      owns the lead-in.
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
 * Both diffs seed silently on their first tick and share no state: the gantry
 * seeds its edge baseline, and the countdown consumes one silent observation
 * before its ceiling may anchor (the first `SessionTimeRemain` a fresh state
 * sees can be a scheduled value an AI session collapses right after —
 * capture 2056). Countdown state resets whenever the diff observes a tick
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

/** Countdown thresholds (seconds), descending — drives smallest-of-many emit. */
const COUNTDOWN_THRESHOLDS = [90, 60, 30, 10] as const;

export function diffStartLights(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
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

  if (rising(Flags.StartGo)) {
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
  // First tick — consume as a silent observation (every diff's seed-silently
  // convention). The first SessionTimeRemain a fresh state sees can be a
  // scheduled value an AI session collapses right after (capture 2056:
  // 262 s → 1.02 s); anchoring the ceiling on it would fire a stale bottom
  // mark on the collapse. The ceiling anchors from the second observation on.
  if (!state.startCountdownObserved) {
    state.startCountdownObserved = true;

    return;
  }

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

  // First in-window tick — seed the ceiling (highest eligible threshold).
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
