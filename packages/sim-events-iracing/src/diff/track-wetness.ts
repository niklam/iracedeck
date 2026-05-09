/**
 * Track-wetness state transitions (issue #526).
 *
 * Emits `track.wetness.changed { from, to }` whenever `TrackWetness` changes
 * between two known states. Transitions involving `Unknown` (the sim's "not
 * yet reported" sentinel) are suppressed: `Unknown → x` seeds the baseline
 * silently, and `x → Unknown` advances the baseline without firing so a
 * later genuine state change still fires correctly. The audio scenarios
 * downstream choose direction (worsening vs drying) and target-state line
 * from the resulting `from`/`to` pair.
 *
 * Seeded silently on first tick. Reset to a fresh state on disconnect /
 * replay / session change (handled by `createInitialState()` in
 * `state.ts` rather than by this module) so we don't replay stale
 * transitions across sessions.
 */
import { TrackWetness } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function diffTrackWetness(state: TranslatorState, telemetry: TelemetryData, emit: EmitFn): void {
  const raw = telemetry.TrackWetness;
  const current: TrackWetness = isValidTrackWetness(raw) ? (raw as TrackWetness) : TrackWetness.Unknown;

  if (!state.trackWetnessInitialized) {
    state.trackWetnessInitialized = true;
    state.lastTrackWetness = current;

    return;
  }

  if (current === state.lastTrackWetness) return;

  // Suppress transitions involving Unknown — the sim hasn't reported a state
  // (or has stopped reporting). Advance the baseline so the next real change
  // fires correctly.
  if (current !== TrackWetness.Unknown && state.lastTrackWetness !== TrackWetness.Unknown) {
    emit({
      event: "track.wetness.changed",
      data: { from: state.lastTrackWetness, to: current },
    });
  }

  state.lastTrackWetness = current;
}

function isValidTrackWetness(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TrackWetness.Unknown &&
    value <= TrackWetness.ExtremelyWet
  );
}
