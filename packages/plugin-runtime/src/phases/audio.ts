/**
 * Phase 4 (#1349): the audio engine, rooted at the plugin's own assets, and
 * the plugin-level syncers that keep its buses and the Race Engineer / Radar
 * gates in step with global settings.
 */
import { AudioNative } from "@iracedeck/audio-native";
import { getAudio, initializeAudio } from "@iracedeck/audio-service";
import { onGlobalSettingsChange } from "@iracedeck/settings";
import { join } from "node:path";

import {
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
  armFeatureGateSync,
  syncFeatureGates,
} from "../actions.js";
import { pluginAudioSessionIdentity } from "../audio-session-identity.js";
import type { Audio, Core } from "../types.js";

export function initAudio(core: Core): Audio {
  // Initialize audio engine for pit crew voice playback.
  // Base path lets scenarios emit manifest-relative clip paths (e.g.
  // "sfx/IRD-tick-open.mp3") that audio-service prepends with the plugin's
  // assets/audio directory before passing them to the native engine.
  // Resolved from the bin dir (→ <sdPlugin>/bin/) so lookup is stable
  // regardless of the launching process's cwd.
  const audioNative = new AudioNative();
  const audioRootDir = join(core.binDir, "..", "assets", "audio");

  // The plugin's own assets are always the first, highest-precedence audio root;
  // the voice-pack phase extends the list with one root per installed voice
  // pack (issue #1034).
  // The Windows Volume Mixer otherwise lists our audio session under the deck
  // host's executable ("Node"); name it and give it our logo (#1253).
  initializeAudio(
    core.adapter.createLogger("Audio"),
    audioNative,
    [audioRootDir],
    pluginAudioSessionIdentity(core.binDir),
  );
  getAudio().init();

  const featureGateLogger = core.adapter.createLogger("FeatureGates");

  // Plugin-level audio-state syncer (issue #515). The Pit Crew action also
  // runs these helpers from its `onWillAppear` listener — but that path
  // only fires when a Pit Crew button is mounted on some page. With no
  // button placed, the audio buses stay at the audio-service default
  // (1.0) and any voice scenario that slipped past the master gate would
  // be audible. Subscribing here means the buses + radar engine state
  // always track `pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled`
  // regardless of whether a Pit Crew button is on the deck.
  //
  // `applyAudioState` reads `getGlobalSettings()` directly, so the initial
  // invocation below uses the in-memory schema-default cache (master
  // toggles `false`, buses muted to 0). When the host echo arrives later,
  // the listener re-fires with the persisted values.
  const applyAudioState = (): void => {
    applyRadarVolume();
    applyRadarEnabled();
    applyRaceEngineerAudio();
  };

  onGlobalSettingsChange(applyAudioState);

  // Live Race Engineer / Radar gate changes (#1007). `applyAudioState` above
  // re-applies the bus volumes on every settings arrival; this listener adds the
  // side effects only a gate CHANGE should have — stopping in-flight scenarios
  // and the spoken acknowledgment — so the settings window's live checkboxes
  // behave exactly like a Pit Crew toggle key. Dormant until
  // `armFeatureGateSync()` runs in the first-arrival block of the settings
  // phase, so applying the startup policies is silent.
  onGlobalSettingsChange(() => syncFeatureGates(featureGateLogger));
  applyAudioState();

  return { rootDir: audioRootDir, featureGateLogger, armFeatureGateSync };
}
