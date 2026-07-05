import { describe, expect, it, vi } from "vitest";

import { migrateLegacyUnit, parseFuelServiceSettings, resolveDisplayUnits } from "./fuel-service-settings.js";

vi.mock("@iracedeck/iracing-sdk", () => ({
  DisplayUnits: { English: 0, Metric: 1 },
}));

vi.mock("@iracedeck/deck-core", async () => {
  // REAL zod so parse/defaults/prefault behave exactly like production.
  const { z } = await import("zod");

  return {
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
  };
});

describe("fuel-service settings", () => {
  describe("migrateLegacyUnit", () => {
    it("coerces unit to liters for a legacy instance (mode persisted, unit absent)", () => {
      expect(migrateLegacyUnit({ mode: "add-fuel", amount: 5 })).toEqual({ mode: "add-fuel", amount: 5, unit: "l" });
    });

    it("leaves settings with a persisted unit unchanged", () => {
      const settings = { mode: "add-fuel", unit: "g" };

      expect(migrateLegacyUnit(settings)).toBe(settings);
    });

    it("leaves a fresh instance (no mode) unchanged so the auto default applies", () => {
      const settings = { amount: 5 };

      expect(migrateLegacyUnit(settings)).toBe(settings);
    });

    it("passes through non-object inputs untouched", () => {
      expect(migrateLegacyUnit(undefined)).toBeUndefined();
      expect(migrateLegacyUnit(null)).toBeNull();
      expect(migrateLegacyUnit("x")).toBe("x");
      const arr = [1, 2];

      expect(migrateLegacyUnit(arr)).toBe(arr);
    });
  });

  describe("parseFuelServiceSettings", () => {
    it("applies full defaults for empty settings — unit auto, dial fully defaulted", () => {
      const parsed = parseFuelServiceSettings({});

      expect(parsed.mode).toBe("toggle-fuel-fill");
      expect(parsed.amount).toBe(1);
      expect(parsed.unit).toBe("auto");
      expect(parsed.dial).toEqual({
        mode: "add-amount",
        stepSize: 1,
        pressAction: "toggle-fueling",
        longPressAction: "toggle-autofuel-mode",
        pushTurnAction: "none",
        tapAction: "none",
        longTouchAction: "none",
      });
    });

    it("fills remaining dial defaults for a partially-persisted dial object", () => {
      const parsed = parseFuelServiceSettings({ dial: { mode: "fill-to", stepSize: "2,5" } });

      expect(parsed.dial.mode).toBe("fill-to");
      expect(parsed.dial.stepSize).toBe(2.5);
      expect(parsed.dial.pressAction).toBe("toggle-fueling");
      expect(parsed.dial.longPressAction).toBe("toggle-autofuel-mode");
      expect(parsed.dial.tapAction).toBe("none");
    });

    it("coerces a legacy instance to liters", () => {
      const parsed = parseFuelServiceSettings({ mode: "add-fuel", amount: 5 });

      expect(parsed.unit).toBe("l");
      expect(parsed.mode).toBe("add-fuel");
      expect(parsed.amount).toBe(5);
    });

    it("keeps an explicitly persisted unit", () => {
      expect(parseFuelServiceSettings({ mode: "add-fuel", unit: "k" }).unit).toBe("k");
      expect(parseFuelServiceSettings({ mode: "add-fuel", unit: "auto" }).unit).toBe("auto");
    });

    it("keeps the stored mode when the persisted unit is unknown, coercing the unit to auto", () => {
      // A shared profile written by a newer version may carry a unit this build
      // doesn't know; that must not discard the whole settings object.
      const parsed = parseFuelServiceSettings({ mode: "reduce-fuel", amount: "5", unit: "stone" });

      expect(parsed.mode).toBe("reduce-fuel");
      expect(parsed.amount).toBe(5);
      expect(parsed.unit).toBe("auto");
    });

    it("replaces a decimal comma in the amount", () => {
      expect(parseFuelServiceSettings({ mode: "add-fuel", amount: "2,5" }).amount).toBe(2.5);
    });

    it("falls back to full defaults when the parse fails outright", () => {
      const parsed = parseFuelServiceSettings({ mode: "not-a-mode" });

      expect(parsed.mode).toBe("toggle-fuel-fill");
      expect(parsed.unit).toBe("auto");
      expect(parsed.dial.mode).toBe("add-amount");
    });
  });

  describe("resolveDisplayUnits", () => {
    it("forces metric for the liters unit", () => {
      expect(resolveDisplayUnits("l", 0)).toBe(1);
      expect(resolveDisplayUnits("l", undefined)).toBe(1);
    });

    it("forces english for the gallons unit", () => {
      expect(resolveDisplayUnits("g", 1)).toBe(0);
      expect(resolveDisplayUnits("g", undefined)).toBe(0);
    });

    it("follows telemetry for auto", () => {
      expect(resolveDisplayUnits("auto", 0)).toBe(0);
      expect(resolveDisplayUnits("auto", 1)).toBe(1);
    });

    it("defaults auto to metric when telemetry units are unknown", () => {
      expect(resolveDisplayUnits("auto", undefined)).toBe(1);
    });

    it("treats the keypad-only kg unit like auto on the dial", () => {
      expect(resolveDisplayUnits("k", 0)).toBe(0);
      expect(resolveDisplayUnits("k", 1)).toBe(1);
      expect(resolveDisplayUnits("k", undefined)).toBe(1);
    });
  });
});
