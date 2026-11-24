/**
 * Display units, sim-neutral (#1662).
 *
 * The unit system a reading is shown in, and the pure conversions between it
 * and the internal metric units (liters, degrees Celsius). Every sim reports
 * its user's choice in its own encoding; mapping that encoding to a
 * {@link UnitSystem} belongs to the sim's package (iRacing's `DisplayUnits` is
 * mapped by `unitSystemOf` in `@iracedeck/deck-iracing`), so a renderer that
 * draws fuel amounts can take a `UnitSystem` without importing a sim.
 *
 * Constants, a type and pure functions over them, which is what this package
 * admits. Every name has one import path, `@iracedeck/app-constants` (#1351):
 * deck-iracing's DisplayUnits wrappers call these rather than re-export them.
 */

/** The unit system a value is displayed in: metric (liters) or imperial (US gallons). */
export type UnitSystem = "metric" | "imperial";

/**
 * Conversion factor from liters to US gallons
 */
export const LITERS_TO_GALLONS = 0.264172;

/**
 * Conversion factor from US gallons to liters
 */
export const GALLONS_TO_LITERS = 3.78541;

/**
 * Unit suffix for metric fuel display
 */
export const FUEL_UNIT_METRIC = "L";

/**
 * Unit suffix for imperial fuel display (US Gallons)
 */
export const FUEL_UNIT_IMPERIAL = "gal";

/**
 * Converts liters to US gallons
 * @param liters - Volume in liters
 * @returns Volume in US gallons
 */
export function litersToGallons(liters: number): number {
  return liters * LITERS_TO_GALLONS;
}

/**
 * Converts US gallons to liters
 * @param gallons - Volume in US gallons
 * @returns Volume in liters
 */
export function gallonsToLiters(gallons: number): number {
  return gallons * GALLONS_TO_LITERS;
}

/**
 * The fuel unit suffix for a unit system.
 * @param system - The unit system the amount is displayed in
 * @returns `"L"` for metric, `"gal"` for imperial
 */
export function fuelUnitSuffixFor(system: UnitSystem): string {
  return system === "metric" ? FUEL_UNIT_METRIC : FUEL_UNIT_IMPERIAL;
}

/**
 * Converts a fuel amount from internal liters to a unit system.
 * @param liters - Fuel amount in liters (internal unit)
 * @param system - The unit system to display it in
 * @returns The amount in liters (metric) or US gallons (imperial)
 */
export function fuelToUnitSystem(liters: number, system: UnitSystem): number {
  return system === "metric" ? liters : litersToGallons(liters);
}

/**
 * Converts a fuel amount from a unit system to internal liters.
 * @param amount - Fuel amount in the unit system's unit
 * @param system - The unit system the amount is in
 * @returns The amount in liters (internal unit)
 */
export function fuelFromUnitSystem(amount: number, system: UnitSystem): number {
  return system === "metric" ? amount : gallonsToLiters(amount);
}

/**
 * Formats a fuel amount in a unit system, with its unit suffix.
 * @param liters - Fuel amount in liters (internal unit)
 * @param system - The unit system to display it in
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string like "5.0 L" or "1.3 gal"
 */
export function formatFuelIn(liters: number, system: UnitSystem, decimals: number = 1): string {
  return `${fuelToUnitSystem(liters, system).toFixed(decimals)} ${fuelUnitSuffixFor(system)}`;
}

/**
 * Converts a temperature from degrees Celsius (the internal unit) to
 * degrees Fahrenheit. Unrounded: callers that speak or display it round
 * for their own purpose (issue #466).
 * @param celsius - Temperature in °C
 * @returns Temperature in °F
 */
export function celsiusToFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}
