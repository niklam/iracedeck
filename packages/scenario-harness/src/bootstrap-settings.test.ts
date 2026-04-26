import { silentLogger } from "@iracedeck/logger";
import { describe, expect, it } from "vitest";

import { getAudioAssetsManifest, resolveAudioAssetsBasePath, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";

describe("resolveAudioAssetsBasePath", () => {
  it("returns the directory containing the audio-assets manifest", () => {
    const basePath = resolveAudioAssetsBasePath();
    expect(basePath.length).toBeGreaterThan(0);
    expect(basePath).toMatch(/audio-assets/);
  });
});

describe("getAudioAssetsManifest", () => {
  it("loads the bundled manifest with the expected shape", () => {
    const manifest = getAudioAssetsManifest();
    expect(Array.isArray(manifest.clips)).toBe(true);
    expect(typeof manifest.ambientLoop).toBe("string");
    expect(typeof manifest.ticks.open).toBe("string");
    expect(typeof manifest.ticks.close).toBe("string");
  });
});

describe("seedGlobalSettings", () => {
  it("writes voice/driver lists and sensible defaults to the adapter", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    const { raceEngineerVoices, driverNames } = seedGlobalSettings(adapter);
    const settings = adapter.readSettings();

    expect(settings._raceEngineerVoices).toBe(JSON.stringify(raceEngineerVoices));
    expect(settings._driverNames).toBe(JSON.stringify(driverNames));
    expect(settings.raceEngineerEnabled).toBe(true);
    expect(settings.radarEnabled).toBe(true);
    expect(settings.raceEngineerVolume).toBe(100);
    expect(settings.radarVolume).toBe(100);
    expect(settings.audioOutputDevice).toBe("");
  });

  it("picks the first available voice when voices exist", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    const { raceEngineerVoices } = seedGlobalSettings(adapter);

    if (raceEngineerVoices.length === 0) {
      // Audio-assets package may legitimately have no voice clips in CI;
      // skip the assertion in that case rather than failing.
      expect(adapter.readSettings().raceEngineerVoice).toBe("");

      return;
    }

    expect(adapter.readSettings().raceEngineerVoice).toBe(raceEngineerVoices[0]);
  });
});
