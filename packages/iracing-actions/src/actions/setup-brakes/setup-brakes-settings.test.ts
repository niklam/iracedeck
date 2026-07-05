import { describe, expect, it, vi } from "vitest";

import { parseSetupBrakesSettings, rotationKey, SETUP_BRAKES_GLOBAL_KEYS } from "./setup-brakes-settings.js";

vi.mock("@iracedeck/deck-core", async () => {
  // REAL zod so parse/defaults/prefault behave exactly like production.
  const { z } = await import("zod");

  return {
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
  };
});

describe("setup-brakes settings", () => {
  describe("SETUP_BRAKES_GLOBAL_KEYS", () => {
    it("maps every setting + direction to its global settings key", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-toggle"]).toBe("setupBrakesAbsToggle");
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-increase"]).toBe("setupBrakesBrakeBiasIncrease");
      expect(SETUP_BRAKES_GLOBAL_KEYS["engine-braking-decrease"]).toBe("setupBrakesEngineBrakingDecrease");
      expect(Object.keys(SETUP_BRAKES_GLOBAL_KEYS)).toHaveLength(13);
    });
  });

  describe("rotationKey", () => {
    it("resolves the shared increase/decrease binding for a dial setting", () => {
      expect(rotationKey("brake-bias", "increase")).toBe("setupBrakesBrakeBiasIncrease");
      expect(rotationKey("abs-adjust", "decrease")).toBe("setupBrakesAbsAdjustDecrease");
    });
  });

  describe("parseSetupBrakesSettings", () => {
    it("applies full defaults for empty settings — dial fully defaulted", () => {
      const parsed = parseSetupBrakesSettings({});

      expect(parsed.setting).toBe("brake-bias");
      expect(parsed.direction).toBe("increase");
      expect(parsed.dualPressEnabled).toBe(true);
      expect(parsed.dial).toEqual({
        setting: "brake-bias",
        pressAction: "toggle-abs",
        longPressAction: "none",
        tapAction: "none",
        longTouchAction: "none",
      });
    });

    it("fills remaining dial defaults for a partially-persisted dial object", () => {
      const parsed = parseSetupBrakesSettings({ dial: { setting: "abs-adjust", longPressAction: "toggle-abs" } });

      expect(parsed.dial.setting).toBe("abs-adjust");
      expect(parsed.dial.longPressAction).toBe("toggle-abs");
      expect(parsed.dial.pressAction).toBe("toggle-abs");
      expect(parsed.dial.tapAction).toBe("none");
    });

    it("keeps keypad settings flat and untouched by the dial root", () => {
      const parsed = parseSetupBrakesSettings({ setting: "view-brake-bias", dualPressEnabled: "false" });

      expect(parsed.setting).toBe("view-brake-bias");
      expect(parsed.dualPressEnabled).toBe(false);
      expect(parsed.dial.setting).toBe("brake-bias");
    });

    it("falls back to full defaults when the whole parse fails", () => {
      const parsed = parseSetupBrakesSettings({ setting: "not-a-setting" });

      expect(parsed.setting).toBe("brake-bias");
      expect(parsed.dial.pressAction).toBe("toggle-abs");
    });
  });
});
