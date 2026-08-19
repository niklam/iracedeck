import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSeedSettings, SEED_STORE_PATH } from "./seed.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every real binding setting name, from the generated catalog. */
const realBindingKeys = new Set(
  Object.values(
    JSON.parse(
      readFileSync(join(repoRoot, "packages/iracing-actions/src/actions/data/key-bindings.json"), "utf-8"),
    ),
  )
    .flat()
    .map((binding) => binding.setting),
);

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

  // A seeded binding under a key no action actually uses is invisible: the Key
  // Bindings table renders one row per REAL binding, so the value is simply
  // never displayed and the screenshot silently loses what it was seeded for.
  // That is exactly what `aiSpotterLouder` (no such setting; it is
  // `spotterLouder`) did until this test existed.
  it("seeds only binding keys that actually exist", () => {
    const seeded = Object.entries(buildSeedSettings())
      .filter(([, value]) => typeof value === "string" && value.startsWith('{"type":'))
      .map(([key]) => key);

    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((key) => !realBindingKeys.has(key))).toEqual([]);
  });
});
