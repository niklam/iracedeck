/**
 * Start-light transitions + pre-start numeric countdown (issue #480).
 *
 * Two independent pieces, both driven off `SessionFlags` / `SessionState` /
 * `SessionTimeRemain` and the session YAML helpers:
 *
 *   1. **Gantry rising edges.** `StartReady` / `StartSet` / `StartGo` each fire
 *      once on their off→on edge (vs `state.lastStartLightBits`). `start-ready`
 *      is standing-only — in a rolling start `StartReady` is held through the
 *      whole parade, so the lead-in there comes from `one-lap-to-green` /
 *      `green-held` instead.
 *
 *   2. **Numeric countdown.** A `SessionTimeRemain` countdown that only runs in
 *      the trustworthy standing pre-start window — `standing ∧
 *      SessionState===Warmup ∧ StartReady set ∧ SessionTimeRemain>0`. The
 *      inflated get-in buffer and the `-1` reset both fall outside that window
 *      (see the issue #480 telemetry findings). On the first in-window tick the
 *      ceiling is seeded from `SessionTimeRemain` so only thresholds the window
 *      can actually reach fire; each tick emits ONLY the smallest newly-crossed
 *      threshold so a dropped tick never produces a stale burst. An AI race
 *      suppresses all numbers (the window already compresses, this is the
 *      explicit guard).
 *
 * First tick after connect / window entry seeds without firing. State resets
 * whenever the diff observes a tick outside the window after the window was
 * active, so a re-grid counts down again.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveIsAiRace, resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** The three gantry bits, masked out of `SessionFlags` for edge detection. */
const START_LIGHT_MASK = Flags.StartReady | Flags.StartSet | Flags.StartGo;

/** Countdown thresholds (seconds), descending — drives smallest-of-many emit. */
const COUNTDOWN_THRESHOLDS = [60, 30, 15, 10, 5] as const;

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
  const isAiRace = resolveIsAiRace(sessionInfo);

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

  // start-ready is standing-only (rolling holds StartReady through the parade).
  if (standing && rising(Flags.StartReady)) {
    emit({ event: "startLight.start-ready.raised", data: {} });
  }

  if (rising(Flags.StartSet)) {
    emit({ event: "startLight.start-set.raised", data: {} });
  }

  if (rising(Flags.StartGo)) {
    emit({ event: "startLight.start-go.raised", data: {} });
  }

  state.lastStartLightBits = startBits;

  // ── Numeric countdown ──────────────────────────────────────────────────
  const inWindow =
    standing && sessionState === SessionState.Warmup && hasFlag(sessionFlags, Flags.StartReady) && timeRemain > 0;

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

  // AI guard — suppress all numbers in an AI race (the window-gate already
  // handles short procedures; this makes "never 5 s+ in an AI race" explicit).
  if (isAiRace) return;

  const smallest = Math.min(...candidates) as (typeof COUNTDOWN_THRESHOLDS)[number];
  emit({ event: "startLight.countdown.raised", data: { seconds: smallest } });
}
