/**
 * Phase 6 (#1349): the scenario engine, the Race Engineer's wiring (the bus
 * caches and `registerPitCrew`), and the voices' callout scripts — in that
 * order, which nothing but this file holds.
 */
import { type FrameOptions, getScenarioEngine, initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { getAudio } from "@iracedeck/audio-service";
import { frameOptionsFromSettings, getGlobalSettings, resolveActiveRaceEngineerVoice } from "@iracedeck/deck-core";
import { type SimRuntime, wireRaceEngineer } from "@iracedeck/race-engineer-wiring";

import type { Audio, Core, VoicePacks } from "../types.js";

/**
 * `audio` is not read today (the engine takes `getAudio()`); it is the
 * phase's data dependency, so the engine cannot be built before the audio
 * phase has run.
 */
export function initRaceEngineer(core: Core, sim: SimRuntime, audio: Audio, voicePacks: VoicePacks): void {
  // The radio frame's two opt-outs (#1064), read live at frame expansion so the
  // Radio beeps / Pit ambience checkboxes take effect on the next callout rather
  // than the next restart. Deck-core's `frameOptionsFromSettings` is the one
  // rule — the Background preview and the scenario harness read through it too
  // — and reads a missing key as on, since before the store has loaded the
  // cache holds the schema default.
  const getFrameOptions = (): FrameOptions => frameOptionsFromSettings(getGlobalSettings());

  // Initialize the scenario engine AFTER audio (so it can drive playback) but
  // BEFORE actions register (so actions see a ready engine when they wire PI
  // toggles and Test buttons to setEnabled / fire).
  //
  // `getActiveVoice` resolves at clip-resolution time, so a PI voice change
  // takes effect on the next scenario fire without re-initialising the engine;
  // `getFrameOptions` is read the same way, at frame expansion.
  initializeAudioScenarios(
    core.bus,
    getAudio(),
    voicePacks.state.activeManifest,
    core.adapter.createLogger("AudioScenarios"),
    () => resolveActiveRaceEngineerVoice(voicePacks.state.raceEngineerVoices),
    getFrameOptions,
  );

  // The bus caches, every registerPitCrew dependency and the call (#1349) —
  // the caches are subscribed before registerPitCrew inside the wiring.
  // `voice` is the voice-pack state object itself, so a rescan's new driver-name
  // list reaches the wiring without re-wiring. The wiring's loggers are scopes
  // of this one: `[RaceEngineer:LapCompleted]` and so on.
  wireRaceEngineer(core.bus, { logger: core.adapter.createLogger("RaceEngineer"), sim, voice: voicePacks.state });

  // Hand the engine every voice's callout script (#1064) — AFTER `registerPitCrew`,
  // never before: `setScripts` compiles eagerly against the contracts registered
  // above, so an earlier call would compile every entry to "no contract" and warn
  // once per (voice, scenario) about a state the first fire would silently fix.
  // The startup scan stored this map before the engine existed (see
  // `applyScripts` on the voice-pack service); every later rescan hands its own
  // map over directly.
  getScenarioEngine().setScripts(voicePacks.state.activeScripts);
}
