/**
 * The settings phase's two listeners (#1377), composed from its steps: the
 * global-settings listener, which runs on every settings arrival, and the
 * Property Inspector appear handler. Both re-assert run-scoped keys, which
 * every producer owes again within a run.
 */
import type { PiWarning } from "@iracedeck/app-constants";
import { migrateRaceEngineerVoiceId, setWarning } from "@iracedeck/settings";

import type { VoicePacks } from "../../types.js";
import type { AudioDeviceSync } from "./audio-devices.js";
import type { StoreReadyStep } from "./store-ready.js";

/** The voice-pack phase's three deduped run-scoped pushes, in the order both listeners make them. */
export function pushVoicePackLists(voicePacks: VoicePacks): void {
  voicePacks.push.raceEngineerVoices();
  voicePacks.push.driverNames();
  voicePacks.push.packList();
}

export interface SettingsListenerDeps {
  readonly audioDevices: AudioDeviceSync;
  readonly storeReady: StoreReadyStep;
  readonly voicePacks: VoicePacks;
  /** The failed native addons' banners (#1373), computed once: the statuses are fixed for the run. */
  readonly nativeAddonWarnings: readonly PiWarning[];
}

/** The listener the phase registers with `onGlobalSettingsChange`. */
export function createSettingsListener({
  audioDevices,
  storeReady,
  voicePacks,
  nativeAddonWarnings,
}: SettingsListenerDeps): (settings: unknown) => void {
  return (settings) => {
    const s = settings as Record<string, unknown>;

    audioDevices.seedOnFirstArrival();
    storeReady.runIfReady();

    pushVoicePackLists(voicePacks);
    // A stored bare voice id is qualified with its pack (#1144) — here once the
    // store is ready, and again after any scan that brings its pack.
    migrateRaceEngineerVoiceId(voicePacks.state.raceEngineerVoices, voicePacks.logger);
    // The active voice is a setting, so its banner is re-evaluated here (#1064).
    voicePacks.reassertVoiceScriptWarning();

    // A failed native load is fixed for the run, but `_warnings` is run-scoped and
    // every producer re-asserts within it (#1373). `setWarning` skips a record that
    // is already identical, so this is free after the first arrival. Set-only: a
    // native or mock load raises nothing and clears nothing.
    for (const warning of nativeAddonWarnings) setWarning(warning.id, warning.level, warning.message);

    audioDevices.applySaved(s.audioOutputDevice);
  };
}

export interface PropertyInspectorAppearDeps {
  readonly audioDevices: AudioDeviceSync;
  readonly voicePacks: VoicePacks;
}

/** The handler the phase registers with `adapter.onPropertyInspectorDidAppear`. */
export function createPropertyInspectorAppearHandler({
  audioDevices,
  voicePacks,
}: PropertyInspectorAppearDeps): () => void {
  return () => {
    // Re-enumerate audio devices on every PI open so a headset plugged in
    // after the deck host booted appears without a full restart. The
    // `pushIfChanged` guard short-circuits the common case (PI reopened, no
    // hardware changed) so the sdpi-components data source doesn't churn.
    audioDevices.pushIfChanged();
    pushVoicePackLists(voicePacks);
    // `_voicePackStatus` is run-scoped too, and owes the same re-assertion
    // (#1100). Deduped in publishStatus, so this is free when nothing moved.
    voicePacks.installer.republishStatus();
  };
}
