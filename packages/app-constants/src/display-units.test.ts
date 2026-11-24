import { describe, expect, it } from "vitest";

import {
  celsiusToFahrenheit,
  formatFuelIn,
  FUEL_UNIT_IMPERIAL,
  FUEL_UNIT_METRIC,
  fuelFromUnitSystem,
  fuelToUnitSystem,
  fuelUnitSuffixFor,
  GALLONS_TO_LITERS,
  gallonsToLiters,
  LITERS_TO_GALLONS,
  litersToGallons,
} from "./display-units.js";

describe("celsiusToFahrenheit (issue #466)", () => {
  it.each([
    [0, 32],
    [100, 212],
    [-40, -40],
    [-20, -4],
    [80, 176],
    [23, 73.4],
  ])("%d °C is %d °F", (celsius, fahrenheit) => {
    expect(celsiusToFahrenheit(celsius)).toBeCloseTo(fahrenheit, 10);
  });

  it("does not round — speech rounds later", () => {
    expect(celsiusToFahrenheit(41.3)).toBeCloseTo(106.34, 10);
  });
});

describe("display-units", () => {
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

  describe("fuelUnitSuffixFor", () => {
    it('returns "L" for metric', () => {
      expect(fuelUnitSuffixFor("metric")).toBe(FUEL_UNIT_METRIC);
    });

    it('returns "gal" for imperial', () => {
      expect(fuelUnitSuffixFor("imperial")).toBe(FUEL_UNIT_IMPERIAL);
    });
  });

  describe("fuelToUnitSystem", () => {
    it("returns liters unchanged for metric", () => {
      expect(fuelToUnitSystem(10, "metric")).toBe(10);
      expect(fuelToUnitSystem(2.4, "metric")).toBe(2.4);
    });

    it("converts liters to US gallons for imperial", () => {
      expect(fuelToUnitSystem(10, "imperial")).toBeCloseTo(2.64172, 4);
      expect(fuelToUnitSystem(3.78541, "imperial")).toBeCloseTo(1, 4);
    });
  });

  describe("fuelFromUnitSystem", () => {
    it("returns the amount unchanged for metric", () => {
      expect(fuelFromUnitSystem(5.5, "metric")).toBe(5.5);
    });

    it("converts US gallons to liters for imperial", () => {
      expect(fuelFromUnitSystem(1, "imperial")).toBeCloseTo(3.78541, 4);
      expect(fuelFromUnitSystem(2.64172, "imperial")).toBeCloseTo(10, 3);
    });
  });

  describe("formatFuelIn", () => {
    it("formats liters for metric", () => {
      expect(formatFuelIn(10, "metric")).toBe("10.0 L");
      expect(formatFuelIn(5.5, "metric")).toBe("5.5 L");
    });

    it("formats US gallons for imperial", () => {
      expect(formatFuelIn(10, "imperial")).toBe("2.6 gal");
      expect(formatFuelIn(37.8541, "imperial")).toBe("10.0 gal");
    });

    it("formats with the given decimals", () => {
      expect(formatFuelIn(10.123, "metric", 2)).toBe("10.12 L");
      expect(formatFuelIn(10.123, "metric", 0)).toBe("10 L");
    });
  });
});
