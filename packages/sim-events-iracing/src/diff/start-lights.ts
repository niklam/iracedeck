/**
 * Start-light transitions + pre-start numeric countdown (issue #480).
 *
 * Two independent pieces, both driven off `SessionFlags` / `SessionState` /
 * `SessionTimeRemain` and the session YAML helpers:
 *
 *   1. **Gantry rising edges.** `StartSet` / `StartGo` each fire once on their
 *      off→on edge (vs `state.lastStartLightBits`). (The earlier `start-ready`
 *      gantry cue was dropped in issue #666; the rolling-start lead-in is
 *      `one-pace-lap-to-go` (`diff/pace-laps.ts`, issue #657) / `green-held`.)
 *
 *   2. **Numeric countdown.** A `SessionTimeRemain` countdown that runs in the
 *      standing pre-start window — `standing ∧ SessionState ∈ {GetInCar,
 *      Warmup} ∧ ¬(StartSet ∨ StartGo) ∧ SessionTimeRemain>0`. `SessionTimeRemain`
 *      is the real time-to-lights from `GetInCar` onward (issue #666), so the
 *      window opens at `GetInCar` rather than waiting for the `StartReady` gantry
 *      bit, and closes once `StartSet`/`StartGo` light — the gantry lines own the
 *      final moment. On the first in-window tick the ceiling is seeded from
 *      `SessionTimeRemain` so only thresholds the window can actually reach fire;
 *      each tick emits ONLY the smallest newly-crossed threshold so a dropped
 *      tick never produces a stale burst. AI races are NOT suppressed (issue
 *      #666) — the ceiling seed already keeps a compressed pre-start window from
 *      speaking a number it can't reach.
 *
 * First tick after connect / window entry seeds without firing. State resets
 * whenever the diff observes a tick outside the window after the window was
 * active, so a re-grid counts down again.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** The two gantry bits, masked out of `SessionFlags` for edge detection. */
const START_LIGHT_MASK = Flags.StartSet | Flags.StartGo;

/** Countdown thresholds (seconds), descending — drives smallest-of-many emit. */
const COUNTDOWN_THRESHOLDS = [60, 30, 10] as const;

export function diffStartLights(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const timeRemain = typeof telemetry.SessionTimeRemain === "number" ? telemetry.SessionTimeRemain : 0;
  const standing = resolveStandingStart(sessionInfo);

  const startBits = sessionFlags & START_LIGHT_MASK;

  // First tick — seed the gantry baseline without firing.
  if (!state.startLightInitialized) {
    state.startLightInitialized = true;
    state.lastStartLightBits = startBits;

    return;
  }

  // ── Gantry rising edges ────────────────────────────────────────────────
  const prevBits = state.lastStartLightBits;
  const rising = (flag: number): boolean => (startBits & flag) !== 0 && (prevBits & flag) === 0;

  if (rising(Flags.StartSet)) {
    emit({ event: "startLight.start-set.raised", data: {} });
  }

  if (rising(Flags.StartGo)) {
    emit({ event: "startLight.start-go.raised", data: {} });
  }

  state.lastStartLightBits = startBits;

  // ── Numeric countdown ──────────────────────────────────────────────────
  // SessionTimeRemain is the real time-to-lights from GetInCar onward (issue
  // #666), so the window opens at GetInCar (no longer waits for the StartReady
  // gantry bit) and closes once StartSet/StartGo light — the gantry lines own
  // the final moment. Race-only / in-car gating is handled at the scenario
  // `where:` layer, not here.
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
