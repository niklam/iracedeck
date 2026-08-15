import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SPOTTER_CONTROLS, SPOTTER_GLOBAL_KEYS } from "./spotter-bindings.js";

const KEY_BINDINGS_PATH = new URL("../actions/data/key-bindings.json", import.meta.url);

/** The `aiSpotterControls` accordion rows the PIs render (setting = global key). */
function accordionSpotterSettings(): string[] {
  const json = JSON.parse(readFileSync(KEY_BINDINGS_PATH, "utf8")) as {
    aiSpotterControls: { id: string; setting: string }[];
  };

  return json.aiSpotterControls.map((row) => row.setting);
}

describe("spotter-bindings", () => {
  it("maps every spotter control to a global key", () => {
    for (const control of SPOTTER_CONTROLS) {
      expect(SPOTTER_GLOBAL_KEYS[control], control).toMatch(/^spotter[A-Z]/);
    }
  });

  it("matches the aiSpotterControls rows in key-bindings.json one-to-one (the accordion source)", () => {
    // Both PIs (AI Spotter Controls, Audio Controls dial) configure these keys
    // through the same accordion rows; a key the record knows but the accordion
    // doesn't render can never be set, and vice versa.
    expect([...Object.values(SPOTTER_GLOBAL_KEYS)].sort()).toEqual([...accordionSpotterSettings()].sort());
  });
});
