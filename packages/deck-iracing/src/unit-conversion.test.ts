import { DisplayUnits } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  formatFuelAmount,
  FUEL_UNIT_IMPERIAL,
  FUEL_UNIT_METRIC,
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  getFuelUnitSuffix,
  isMetricUnits,
  unitSystemOf,
} from "./unit-conversion.js";

describe("fuelToDisplayUnits (callers' contract)", () => {
  it("returns liters unchanged for metric", () => {
    expect(fuelToDisplayUnits(2.4, DisplayUnits.Metric)).toBe(2.4);
  });

  it("converts to US gallons for English", () => {
    expect(fuelToDisplayUnits(3.78541, DisplayUnits.English)).toBeCloseTo(1, 4);
  });

  it("treats an undefined display unit as imperial — callers that mean 'unset is metric' must normalize first", () => {
    expect(fuelToDisplayUnits(3.78541, undefined)).toBeCloseTo(1, 4);
  });
});

describe("unit-conversion", () => {
  describe("unitSystemOf (#1662)", () => {
    it("maps Metric to the metric unit system", () => {
      expect(unitSystemOf(DisplayUnits.Metric)).toBe("metric");
      expect(unitSystemOf(1)).toBe("metric");
    });

    it("maps English to the imperial unit system", () => {
      expect(unitSystemOf(DisplayUnits.English)).toBe("imperial");
      expect(unitSystemOf(0)).toBe("imperial");
    });

    it("maps an unknown or undefined value to imperial, as every DisplayUnits function treats it", () => {
      expect(unitSystemOf(undefined)).toBe("imperial");
      expect(unitSystemOf(7)).toBe("imperial");
    });
  });

  describe("re-exports the sim-neutral constants and conversions", () => {
    it("is the same definition as @iracedeck/deck-core/display-units", async () => {
      const units = await import("./unit-conversion.js");
      const neutral = await import("@iracedeck/deck-core/display-units");

      expect(units.LITERS_TO_GALLONS).toBe(neutral.LITERS_TO_GALLONS);
      expect(units.GALLONS_TO_LITERS).toBe(neutral.GALLONS_TO_LITERS);
      expect(units.FUEL_UNIT_METRIC).toBe(neutral.FUEL_UNIT_METRIC);
      expect(units.FUEL_UNIT_IMPERIAL).toBe(neutral.FUEL_UNIT_IMPERIAL);
      expect(units.litersToGallons).toBe(neutral.litersToGallons);
      expect(units.gallonsToLiters).toBe(neutral.gallonsToLiters);
      expect(units.celsiusToFahrenheit).toBe(neutral.celsiusToFahrenheit);
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
});
