import { describe, expect, it } from "vitest";

import { buildSeedSettings, SEED_STORE_PATH } from "./seed.mjs";

describe("buildSeedSettings", () => {
  it("returns a fresh object each call so one capture cannot leak into the next", () => {
    const first = buildSeedSettings();
    first.raceEngineerVolume = 999;

    expect(buildSeedSettings().raceEngineerVolume).toBe(60);
  });

  it("populates every runtime-pushed list the page reads", () => {
    const settings = buildSeedSettings();

    for (const key of ["_raceEngineerVoices", "_driverNames", "_audioDeviceList", "_deckDevices"]) {
      expect(Array.isArray(JSON.parse(settings[key])), key).toBe(true);
      expect(JSON.parse(settings[key]).length, key).toBeGreaterThan(0);
    }
  });

  it("shows a fake settings path, never the capturing machine's own", () => {
    expect(buildSeedSettings()._settingsStorePath).toBe(SEED_STORE_PATH);
    expect(SEED_STORE_PATH).toContain("Driver");
  });

  it("stores key bindings in the JSON shape the binding inputs parse", () => {
    const binding = JSON.parse(buildSeedSettings().blackBoxLapTiming);

    expect(binding).toEqual({ type: "keyboard", key: "f1", modifiers: [] });
  });

  it("includes a SimHub-role binding so both binding types appear in one shot", () => {
    const roles = Object.values(buildSeedSettings())
      .filter((value) => typeof value === "string" && value.startsWith("{"))
      .map((value) => JSON.parse(value))
      .filter((value) => value?.type === "simhub");

    expect(roles.length).toBeGreaterThan(0);
  });
});
