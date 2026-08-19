/**
 * The Race Engineer / Radar live master gates (issue #1007).
 *
 * `pitCrewRaceEngineerEnabled` and `pitCrewRadarEnabled` are the runtime flags
 * every scenario, the radar engine and the Pit Crew icon read. Three things
 * write them: the Pit Crew toggle keys, the Audio Controls dial's Mute/Unmute,
 * and the settings window's live checkboxes. This module makes all three
 * behave identically by owning the side effects of a gate *change* — stopping
 * in-flight scenarios, driving the radar engine, and the spoken
 * acknowledgment — instead of leaving them in the key's own code path, where a
 * settings-window write produced a half-toggle: buses muted (the plugin's
 * `applyAudioState` listener) but the in-flight scenario and its looping
 * ambient bed left running, exactly the bug #587 fixed.
 *
 * Exactly-once is a per-gate applied-value tracker, not a listener contract:
 * `updateGlobalSettings` fires listeners synchronously, so when a plugin is
 * armed the listener has already applied the edge by the time the toggle
 * helper calls its applier, and the second call short-circuits. When nothing
 * is armed — a press before the first settings arrival, or a unit test whose
 * mocked `updateGlobalSettings` fires no listeners — the direct call does the
 * work. A key press therefore never depends on a listener registered in
 * another file.
 *
 * The voice plumbing the acknowledgment rides on (`playToggleAck`,
 * `playVoiceSequence`) stays in `audio-toggles.ts`; the dependency runs one
 * way, so there is no cycle.
 */
import { setRadarEnabled, stopRaceEngineerScenarios } from "@iracedeck/audio-scenarios/pit-crew";
import { updateGlobalSettings } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import { isToggleAckEnabled, playToggleAck } from "./audio-toggles.js";
import { applyRaceEngineerAudio, isRaceEngineerEnabled, isRadarEnabled } from "./audio-volume.js";

/**
 * The gate values whose side effects have already been applied. `null` means
 * "not applied yet", so the first application always runs — which is what lets
 * a toggle work before {@link armFeatureGateSync} has ever been called.
 */
let appliedRaceEngineerGate: boolean | null = null;
let appliedRadarGate: boolean | null = null;

/**
 * Whether {@link syncFeatureGates} reacts to changes. Dormant until
 * {@link armFeatureGateSync}, so the startup application of the per-feature
 * startup policies can never be mistaken for a user toggle and play an
 * acknowledgment at plugin start.
 */
let armed = false;

/**
 * Apply the side effects of the Race Engineer gate landing on `next`.
 * A no-op when those effects have already been applied for that value.
 */
function applyRaceEngineerGate(next: boolean, logger: ILogger): void {
  if (appliedRaceEngineerGate === next) return;

  // Apply the gate to Voice + Background synchronously so an in-flight
  // engineer clip is silenced on the same tick the user pressed the key.
  // The acknowledgment (issue #554) layers on top via
  // `raceEngineerToggleInFlight` — when set, `applyRaceEngineerAudio` leaves
  // Voice audible so the "going silent" / "resuming" line plays through,
  // while Background and every other Voice consumer mute immediately.
  applyRaceEngineerAudio();

  // Turning off mid-callout must stop the in-flight scenario (and its looping
  // ambient bed) and free the scenario bus. `applyRaceEngineerAudio` only
  // mutes the buses — without this the ambient is orphaned (audible again on
  // re-enable) and the stuck `playingId` drops every later callout as "bus
  // busy". The going-silent acknowledgment below plays directly on Voice, not
  // through the engine, so it is unaffected by the cancel (issue #587).
  if (!next) {
    stopRaceEngineerScenarios();
  }

  if (isToggleAckEnabled()) {
    playToggleAck(next ? "resuming-01" : "going-silent-01", logger);
  }

  // LAST, once every side effect above has succeeded. Recording it first would
  // make a swallowed fault permanent: the tracker would claim the change was
  // applied, so the next sync would short-circuit and the audio layer would
  // stay out of step with the persisted gate forever. Recording it last leaves
  // the failed change pending, and the next settings arrival retries it. Safe
  // to defer because none of the effects above writes global settings, so
  // nothing can re-enter this function before the assignment.
  appliedRaceEngineerGate = next;
}

/**
 * Apply the side effects of the Radar gate landing on `next`. Pushes the gate
 * into the radar engine so the tick loop stops/starts immediately; the radar
 * has no spoken acknowledgment.
 */
function applyRadarGate(next: boolean): void {
  if (appliedRadarGate === next) return;

  setRadarEnabled(next);
  // Recorded last, so a throw leaves the change pending for the next sync —
  // see the note in `applyRaceEngineerGate`.
  appliedRadarGate = next;
}

/**
 * Flip the Race Engineer master gate — the shared pathway behind the Pit Crew
 * toggle key and the Audio Controls dial's Mute/Unmute. Returns the NEW state.
 */
export function toggleRaceEngineerFeature(logger: ILogger): boolean {
  const next = !isRaceEngineerEnabled();
  logger.info(`Race Engineer ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ pitCrewRaceEngineerEnabled: next });
  // Guarded like the listener path: when armed this is already a no-op, and
  // when it is not (a press before the first settings arrival) an audio fault
  // must not throw out of a key handler — the gate is persisted by now, and
  // the tracker leaves the effects pending for the next sync to retry.
  guard(() => applyRaceEngineerGate(next, logger), logger);

  return next;
}

/** Flip the Radar master gate. Returns the NEW state. */
export function toggleRadarFeature(logger: ILogger): boolean {
  const next = !isRadarEnabled();
  logger.info(`Radar ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ pitCrewRadarEnabled: next });
  guard(() => applyRadarGate(next), logger);

  return next;
}

/**
 * Apply whatever the live gates now hold. Registered once per plugin on
 * `onGlobalSettingsChange`, so a gate written by anything other than the
 * toggle helpers — the settings window's live checkboxes — gets the same side
 * effects a key press produces.
 *
 * Faults are contained. This runs inside `updateGlobalSettings`' listener
 * fan-out, which has no try/catch and persists the cache only AFTER the
 * fan-out returns — so an audio fault thrown from here (a dead output device,
 * an engine not yet initialised) would abort every later listener AND lose the
 * very gate flip that triggered it. Same reasoning as the app monitor wrapping
 * `setReconnectEnabled(false)`: a subscriber must never swallow the write it
 * was notified about.
 */
export function syncFeatureGates(logger: ILogger): void {
  if (!armed) return;

  // Guarded per gate, not once around both: the two features are independent,
  // so a Race Engineer fault must not leave the radar engine unsynced.
  guard(() => applyRaceEngineerGate(isRaceEngineerEnabled(), logger), logger);
  guard(() => applyRadarGate(isRadarEnabled()), logger);
}

/** Run `apply`, logging and swallowing anything it throws. */
function guard(apply: () => void, logger: ILogger): void {
  try {
    apply();
  } catch (error: unknown) {
    logger.error("Applying a feature-gate change failed");
    logger.debug(String(error));
  }
}

/**
 * Start reacting to gate changes, seeding the trackers from the current
 * values so the seeding itself is silent.
 *
 * Called once per plugin, immediately after the startup policies have been
 * applied: that write fires the listener while still dormant, and arming then
 * records the post-write values as already applied.
 */
export function armFeatureGateSync(): void {
  appliedRaceEngineerGate = isRaceEngineerEnabled();
  appliedRadarGate = isRadarEnabled();
  armed = true;
}

/** @internal Reset the module state between tests. */
export function _resetFeatureGateSync(): void {
  appliedRaceEngineerGate = null;
  appliedRadarGate = null;
  armed = false;
}
