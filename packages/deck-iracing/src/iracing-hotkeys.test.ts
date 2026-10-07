import { describe, expect, it } from "vitest";

import { getHotkeyPreset, getHotkeysByCategory, IRACING_HOTKEY_PRESETS } from "./iracing-hotkeys.js";

describe("iRacing Hotkeys", () => {
  describe("IRACING_HOTKEY_PRESETS", () => {
    it("should have all presets with unique IDs", () => {
      const ids = IRACING_HOTKEY_PRESETS.map((preset) => preset.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should have valid categories for all presets", () => {
      const validCategories = ["blackbox", "controls", "camera", "misc"];

      for (const preset of IRACING_HOTKEY_PRESETS) {
        expect(validCategories).toContain(preset.category);
      }
    });

    it("should have required fields for all presets", () => {
      for (const preset of IRACING_HOTKEY_PRESETS) {
        expect(preset.id).toBeDefined();
        expect(preset.name).toBeDefined();
        expect(preset.description).toBeDefined();
        expect(preset.defaultKey).toBeDefined();
        expect(preset.defaultKey.key).toBeDefined();
        expect(preset.category).toBeDefined();
      }
    });
  });

  describe("getHotkeyPreset", () => {
    it("should return the correct preset for a valid ID", () => {
      const preset = getHotkeyPreset("blackbox-relative");

      expect(preset).toBeDefined();
      expect(preset?.id).toBe("blackbox-relative");
      expect(preset?.name).toBe("Relative");
      expect(preset?.defaultKey.key).toBe("f3");
    });

    it("should return preset with modifiers when present", () => {
      const preset = getHotkeyPreset("control-tow");

      expect(preset).toBeDefined();
      expect(preset?.defaultKey.key).toBe("r");
      expect(preset?.defaultKey.modifiers).toEqual(["shift"]);
    });

    it("should return undefined for an invalid ID", () => {
      const preset = getHotkeyPreset("invalid-id");

      expect(preset).toBeUndefined();
    });
  });

  describe("getHotkeysByCategory", () => {
    it("should return all blackbox presets", () => {
      const presets = getHotkeysByCategory("blackbox");

      expect(presets.length).toBeGreaterThan(0);

      for (const preset of presets) {
        expect(preset.category).toBe("blackbox");
      }
    });

    it("should return all controls presets", () => {
      const presets = getHotkeysByCategory("controls");

      expect(presets.length).toBeGreaterThan(0);

      for (const preset of presets) {
        expect(preset.category).toBe("controls");
      }
    });

    it("should return all camera presets", () => {
      const presets = getHotkeysByCategory("camera");

      expect(presets.length).toBeGreaterThan(0);

      for (const preset of presets) {
        expect(preset.category).toBe("camera");
      }
    });

    it("should return all misc presets", () => {
      const presets = getHotkeysByCategory("misc");

      expect(presets.length).toBeGreaterThan(0);

      for (const preset of presets) {
        expect(preset.category).toBe("misc");
      }
    });

    it("should return expected number of blackbox presets", () => {
      const presets = getHotkeysByCategory("blackbox");

      // F1-F8 black boxes
      expect(presets.length).toBe(8);
    });
  });
});
