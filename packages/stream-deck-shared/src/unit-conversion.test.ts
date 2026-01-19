import { DisplayUnits } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  formatFuelAmount,
  formatFuelAmountWithPrefix,
  formatFuelSettingWithUnit,
  FUEL_UNIT_IMPERIAL,
  FUEL_UNIT_METRIC,
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  GALLONS_TO_LITERS,
  gallonsToLiters,
  getFuelUnitSuffix,
  isMetricUnits,
  LITERS_TO_GALLONS,
  litersToGallons,
} from "./unit-conversion.js";

describe("unit-conversion", () => {
  describe("litersToGallons", () => {
    it("should convert 0 liters to 0 gallons", () => {
      expect(litersToGallons(0)).toBe(0);
    });

    it("should convert 1 liter to approximately 0.264 gallons", () => {
      expect(litersToGallons(1)).toBeCloseTo(0.264172, 5);
    });

    it("should convert 3.78541 liters to approximately 1 gallon", () => {
      expect(litersToGallons(3.78541)).toBeCloseTo(1, 4);
    });

    it("should convert 10 liters correctly", () => {
      expect(litersToGallons(10)).toBeCloseTo(2.64172, 4);
    });
  });

  describe("gallonsToLiters", () => {
    it("should convert 0 gallons to 0 liters", () => {
      expect(gallonsToLiters(0)).toBe(0);
    });

    it("should convert 1 gallon to approximately 3.785 liters", () => {
      expect(gallonsToLiters(1)).toBeCloseTo(3.78541, 4);
    });

    it("should convert 0.264172 gallons to approximately 1 liter", () => {
      expect(gallonsToLiters(0.264172)).toBeCloseTo(1, 4);
    });

    it("should convert 10 gallons correctly", () => {
      expect(gallonsToLiters(10)).toBeCloseTo(37.8541, 3);
    });
  });

  describe("round-trip conversion", () => {
    it("should round-trip liters -> gallons -> liters", () => {
      const original = 15.5;
      const gallons = litersToGallons(original);
      const result = gallonsToLiters(gallons);
      // Precision is limited due to rounded conversion factors
      expect(result).toBeCloseTo(original, 4);
    });

    it("should round-trip gallons -> liters -> gallons", () => {
      const original = 5.5;
      const liters = gallonsToLiters(original);
      const result = litersToGallons(liters);
      // Precision is limited due to rounded conversion factors
      expect(result).toBeCloseTo(original, 4);
    });
  });

  describe("conversion factors", () => {
    it("should have correct LITERS_TO_GALLONS constant", () => {
      expect(LITERS_TO_GALLONS).toBe(0.264172);
    });

    it("should have correct GALLONS_TO_LITERS constant", () => {
      expect(GALLONS_TO_LITERS).toBe(3.78541);
    });

    it("should have inverse relationship between conversion factors", () => {
      expect(LITERS_TO_GALLONS * GALLONS_TO_LITERS).toBeCloseTo(1, 5);
    });
  });

  describe("getFuelUnitSuffix", () => {
    it('should return "L" for metric units', () => {
      expect(getFuelUnitSuffix(DisplayUnits.Metric)).toBe(FUEL_UNIT_METRIC);
      expect(getFuelUnitSuffix(1)).toBe(FUEL_UNIT_METRIC);
    });

    it('should return "gal" for English units', () => {
      expect(getFuelUnitSuffix(DisplayUnits.English)).toBe(FUEL_UNIT_IMPERIAL);
      expect(getFuelUnitSuffix(0)).toBe(FUEL_UNIT_IMPERIAL);
    });

    it('should return "gal" for undefined (defaults to English)', () => {
      expect(getFuelUnitSuffix(undefined)).toBe(FUEL_UNIT_IMPERIAL);
    });
  });

  describe("isMetricUnits", () => {
    it("should return true for Metric display units", () => {
      expect(isMetricUnits(DisplayUnits.Metric)).toBe(true);
      expect(isMetricUnits(1)).toBe(true);
    });

    it("should return false for English display units", () => {
      expect(isMetricUnits(DisplayUnits.English)).toBe(false);
      expect(isMetricUnits(0)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isMetricUnits(undefined)).toBe(false);
    });
  });

  describe("fuelToDisplayUnits", () => {
    it("should return liters unchanged for metric units", () => {
      expect(fuelToDisplayUnits(10, DisplayUnits.Metric)).toBe(10);
      expect(fuelToDisplayUnits(5.5, 1)).toBe(5.5);
    });

    it("should convert liters to gallons for English units", () => {
      expect(fuelToDisplayUnits(10, DisplayUnits.English)).toBeCloseTo(2.64172, 4);
      expect(fuelToDisplayUnits(3.78541, 0)).toBeCloseTo(1, 4);
    });

    it("should convert to gallons for undefined (defaults to English)", () => {
      expect(fuelToDisplayUnits(10, undefined)).toBeCloseTo(2.64172, 4);
    });
  });

  describe("fuelFromDisplayUnits", () => {
    it("should return liters unchanged for metric units", () => {
      expect(fuelFromDisplayUnits(10, DisplayUnits.Metric)).toBe(10);
      expect(fuelFromDisplayUnits(5.5, 1)).toBe(5.5);
    });

    it("should convert gallons to liters for English units", () => {
      expect(fuelFromDisplayUnits(1, DisplayUnits.English)).toBeCloseTo(3.78541, 4);
      expect(fuelFromDisplayUnits(2.64172, 0)).toBeCloseTo(10, 3);
    });

    it("should convert from gallons for undefined (defaults to English)", () => {
      expect(fuelFromDisplayUnits(1, undefined)).toBeCloseTo(3.78541, 4);
    });
  });

  describe("formatFuelAmount", () => {
    it("should format fuel in liters for metric units", () => {
      expect(formatFuelAmount(10, DisplayUnits.Metric)).toBe("10.0 L");
      expect(formatFuelAmount(5.5, 1)).toBe("5.5 L");
    });

    it("should format fuel in gallons for English units", () => {
      expect(formatFuelAmount(10, DisplayUnits.English)).toBe("2.6 gal");
      expect(formatFuelAmount(37.8541, 0)).toBe("10.0 gal");
    });

    it("should format with specified decimals", () => {
      expect(formatFuelAmount(10.123, DisplayUnits.Metric, 2)).toBe("10.12 L");
      expect(formatFuelAmount(10.123, DisplayUnits.Metric, 0)).toBe("10 L");
    });

    it("should format in gallons for undefined (defaults to English)", () => {
      expect(formatFuelAmount(10, undefined)).toBe("2.6 gal");
    });
  });

  describe("formatFuelAmountWithPrefix", () => {
    it("should format fuel with + prefix for add", () => {
      expect(formatFuelAmountWithPrefix(10, DisplayUnits.Metric, "+")).toBe("+10 L");
      expect(formatFuelAmountWithPrefix(1, DisplayUnits.English, "+")).toBeOneOf(["+0 gal", "+0.3 gal"]);
    });

    it("should format fuel with - prefix for reduce", () => {
      expect(formatFuelAmountWithPrefix(10, DisplayUnits.Metric, "-")).toBe("-10 L");
      expect(formatFuelAmountWithPrefix(3.78541, DisplayUnits.English, "-")).toBe("-1 gal");
    });

    it("should format with specified decimals", () => {
      expect(formatFuelAmountWithPrefix(10.5, DisplayUnits.Metric, "+", 1)).toBe("+10.5 L");
      expect(formatFuelAmountWithPrefix(10.5, DisplayUnits.Metric, "+", 0)).toBe("+11 L");
    });

    it("should format in gallons for undefined (defaults to English)", () => {
      expect(formatFuelAmountWithPrefix(10, undefined, "+")).toBe("+3 gal");
    });
  });

  describe("formatFuelSettingWithUnit", () => {
    it("should format setting with L suffix for metric units (no conversion)", () => {
      expect(formatFuelSettingWithUnit(5, DisplayUnits.Metric, "+")).toBe("+5 L");
      expect(formatFuelSettingWithUnit(10, 1, "-")).toBe("-10 L");
    });

    it("should format setting with gal suffix for English units (no conversion)", () => {
      expect(formatFuelSettingWithUnit(5, DisplayUnits.English, "+")).toBe("+5 gal");
      expect(formatFuelSettingWithUnit(10, 0, "-")).toBe("-10 gal");
    });

    it("should format setting with gal suffix for undefined (defaults to English)", () => {
      expect(formatFuelSettingWithUnit(5, undefined, "+")).toBe("+5 gal");
    });

    it("should format with specified decimals", () => {
      expect(formatFuelSettingWithUnit(5.5, DisplayUnits.Metric, "+", 1)).toBe("+5.5 L");
      expect(formatFuelSettingWithUnit(5.5, DisplayUnits.English, "-", 1)).toBe("-5.5 gal");
    });

    it("should work without prefix", () => {
      expect(formatFuelSettingWithUnit(5, DisplayUnits.Metric)).toBe("5 L");
      expect(formatFuelSettingWithUnit(5, DisplayUnits.English)).toBe("5 gal");
    });
  });
});
