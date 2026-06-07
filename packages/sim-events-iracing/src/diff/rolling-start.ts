/**
 * Rolling-start "pace car is moving" cue (issue #660).
 *
 * Fires once the instant the field begins rolling behind the pace car at the
 * START of a rolling start — detected as the entry edge into `ParadeLaps`
 * (`SessionState` rising into `ParadeLaps` from any other state, e.g.
 * `Warmup→ParadeLaps`). That is the moment iRacing releases the grid into the
 * formation/parade lap.
 *
 * **Rolling-only.** Standing starts get the gantry lights + numeric countdown
 * (`diff/start-lights.ts`), not a pace car, so they are excluded here via
 * `resolveStandingStart`. Standing grids also never enter `ParadeLaps`, but the
 * explicit gate keeps the cue rolling-only regardless.
 *
 * **Gating split.** Race-session + in-car gating is deliberately NOT done here —
 * it lives at the audio-scenarios `where:` layer. Keeping this diff to the bare
 * telemetry edge means the event stays firable from the scenario harness (which
 * drives bus events directly) while the production callout still respects the
 * session/in-car context.
 *
 * **Seed on first tick.** The first tick after connect seeds the baseline
 * without firing, so connecting mid-parade never blurts the line (same caveat
 * as the gantry bits / pace-lap diff).
 *
 * **Re-entry re-fires.** A genuine re-entry into `ParadeLaps` (a re-grid) is a
 * fresh entry edge and legitimately fires again — the diff holds no
 * once-per-session latch.
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function diffRollingStart(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const inParade = sessionState === SessionState.ParadeLaps;

  // First tick — seed the baseline without firing (connecting mid-parade must
  // not blurt the line).
  if (!state.rollingStartInitialized) {
    state.rollingStartInitialized = true;
    state.lastInParadeLaps = inParade;

    return;
  }

  // Entry edge — a genuine `*→ParadeLaps` transition.
  const entered = inParade && !state.lastInParadeLaps;

  // Rolling start only — standing grids get the gantry/countdown, not a pace car.
  if (entered && !resolveStandingStart(sessionInfo)) {
    emit({ event: "rollingStart.pace-car-moving.raised", data: {} });
  }

  state.lastInParadeLaps = inParade;
}
