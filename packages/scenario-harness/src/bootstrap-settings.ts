/**
 * Bootstrap helpers for the scenario harness.
 *
 * Resolves the audio-assets package path on disk, scans the manifest for
 * available voices and driver names, and seeds the global-settings store
 * with sensible defaults so scenarios fire on a freshly booted harness
 * without any UI interaction.
 */
import { type AudioAssetsManifest, scanDriverNames, scanRaceEngineerVoices } from "@iracedeck/audio-scenarios";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { MockPlatformAdapter } from "./mock-platform-adapter.js";

const requireFromHere = createRequire(import.meta.url);

/**
 * Resolved filesystem path to `@iracedeck/audio-assets/manifest.json`.
 * Cached because resolve+read is called from multiple call sites during
 * boot.
 */
function resolveManifestPath(): string {
  return requireFromHere.resolve("@iracedeck/audio-assets/manifest.json");
}

let cachedManifest: AudioAssetsManifest | null = null;

/** The bundled manifest, exposed for callers that need to derive lists. */
export function getAudioAssetsManifest(): AudioAssetsManifest {
  if (cachedManifest) return cachedManifest;

  const raw = readFileSync(resolveManifestPath(), "utf-8");
  cachedManifest = JSON.parse(raw) as AudioAssetsManifest;

  return cachedManifest;
}

export type BootstrapDefaults = {
  raceEngineerVoices: string[];
  driverNames: string[];
};

/**
 * Push initial values into the adapter's global-settings store: the
 * push-only "lists" the plugin maintains as private settings keys
 * (`_raceEngineerVoices`, `_driverNames`), plus the user-facing defaults
 * for the Race Engineer toggle/volume, Radar toggle/volume, and the
 * picked voice / driver name (first entry from each list).
 */
export function seedGlobalSettings(adapter: MockPlatformAdapter): BootstrapDefaults {
  const manifest = getAudioAssetsManifest();
  const raceEngineerVoices = scanRaceEngineerVoices(manifest);
  const driverNames = scanDriverNames(manifest);

  adapter.setGlobalSettings({
    _raceEngineerVoices: JSON.stringify(raceEngineerVoices),
    // Written alongside the list, always — the pair shares a lifetime and the
    // plugin never publishes one without the other (#1034). Empty here because
    // the harness loads no voice packs, so every voice falls back to its
    // capitalised id, which is what it showed before labels existed.
    _voiceLabels: JSON.stringify({}),
    _driverNames: JSON.stringify(driverNames),
    pitCrewRaceEngineerEnabled: true,
    raceEngineerVolume: 100,
    raceEngineerVoice: raceEngineerVoices[0] ?? "",
    driverName: driverNames[0] ?? "",
    pitCrewRadarEnabled: true,
    radarVolume: 100,
    audioOutputDevice: "",
  });

  return { raceEngineerVoices, driverNames };
}
