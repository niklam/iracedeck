import { silentLogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getAudioAssetsManifest, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";

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
    expect(settings.pitCrewRaceEngineerEnabled).toBe(true);
    expect(settings.pitCrewRadarEnabled).toBe(true);
    expect(settings.raceEngineerVolume).toBe(100);
    expect(settings.radarVolume).toBe(100);
    expect(settings.audioOutputDevice).toBe("");
    expect(settings.raceEngineerRadioBeeps).toBe(true);
    expect(settings.raceEngineerPitAmbience).toBe(true);
  });

  it("offers every user-facing key it seeds on the UI's settings grid", () => {
    // The seeded snapshot is what the UI renders, so a seeded key with no
    // control is a setting nobody can flip from the page — which is how the
    // radio frame's two switches (#1064) reached the endpoint but not the
    // grid. `ui/app.js` has no build and no DOM here; its grid is a literal
    // list of `key: "…"` lines, read as text.
    const adapter = new MockPlatformAdapter(silentLogger);
    seedGlobalSettings(adapter);
    const seeded = Object.keys(adapter.readSettings()).filter((key) => !key.startsWith("_"));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appJs = readFileSync(path.join(here, "..", "ui", "app.js"), "utf-8");
    const offered = new Set([...appJs.matchAll(/^\s*key: "([A-Za-z]+)",$/gm)].map((match) => match[1]));

    expect(seeded).toContain("raceEngineerRadioBeeps");
    expect(
      seeded.filter((key) => !offered.has(key)),
      "seeded keys with no control on the settings grid",
    ).toEqual([]);
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
