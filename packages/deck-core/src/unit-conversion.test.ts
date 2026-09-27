import { DisplayUnits } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { celsiusToFahrenheit, fuelToDisplayUnits } from "./unit-conversion.js";

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

describe("fuelToDisplayUnits", () => {
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
