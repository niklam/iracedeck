/**
 * Pit-window "pits are open / closed" cue (issue #655).
 *
 * Emits `pitsOpen.changed` on a genuine `PitsOpen` boolean transition:
 *   - `false → true` → pit road is now open
 *   - `true  → false` → pit road is now closed
 *
 * In a race, pit road closes during the field-bunching phase of a full-course
 * caution (and before the green) and reopens once the pace car picks up the
 * field. Pitting while closed earns a penalty, so the window reopening is a
 * strategic cue worth announcing over the radio.
 *
 * **Seed on first tick.** The first tick after connect caches `PitsOpen`
 * without firing, so connecting mid-session (when the value is already at some
 * state) never blurts a phantom open/closed.
 *
 * **Advance the baseline every tick.** `lastPitsOpen` tracks the live value on
 * every tick regardless of whether a fire was emitted. A transition that
 * happens while a gate is closed (non-race, or replay) is therefore absorbed
 * silently rather than replayed the moment the gate opens.
 *
 * **Race sessions only.** `PitsOpen` reads `false` in many non-race contexts
 * (practice / qualifying / between sessions), so a transition outside a race is
 * suppressed — the callout is only meaningful in a race. `isRaceSession` is
 * resolved once per tick by the translator and passed in (same shape as
 * `diffFuelLapsLeft` / `diffOvertakes`).
 *
 * **No replay gate of its own.** Until #1324 the diff took a `replayOnlySession`
 * term, because the translator's guard read the raw `IsReplayPlaying` and a
 * paused or frame-scrubbed saved replay reads it false while
 * `WeekendInfo.SimMode === "replay"`, which let `PitsOpen` transitions leak as
 * the timeline jumped. The guard now reads the controller's debounced replay
 * state, which is true throughout a saved replay, so no such tick reaches
 * this diff.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function diffPitsOpen(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  emit: EmitFn,
): void {
  const pitsOpen = telemetry.PitsOpen === true;

  // First tick — seed the baseline without firing.
  if (!state.pitsOpenInitialized) {
    state.pitsOpenInitialized = true;
    state.lastPitsOpen = pitsOpen;

    return;
  }

  const previous = state.lastPitsOpen;
  const changed = pitsOpen !== previous;

  // Advance the baseline every tick, even when the emit is gated out, so a
  // transition during a non-race window never replays once it opens.
  state.lastPitsOpen = pitsOpen;

  if (changed && isRaceSession) {
    emit({ event: "pitsOpen.changed", data: { from: previous, to: pitsOpen } });
  }
}
