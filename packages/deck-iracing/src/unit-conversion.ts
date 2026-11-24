/**
 * Unit Conversion Utilities
 *
 * Handles conversion between metric and imperial units based on iRacing's DisplayUnits setting.
 * iRacing internally uses metric units (liters, kPa, etc.) - these utilities convert for display only.
 *
 * The conversions themselves are sim-neutral and live in
 * `@iracedeck/app-constants`, keyed by a {@link UnitSystem} (#1662); what is iRacing's is
 * the `DisplayUnits` encoding, which {@link unitSystemOf} maps onto it. The
 * functions below keep their DisplayUnits signatures as thin wrappers.
 */
import {
  formatFuelIn,
  fuelFromUnitSystem,
  fuelToUnitSystem,
  fuelUnitSuffixFor,
  type UnitSystem,
} from "@iracedeck/app-constants";
import { DisplayUnits } from "@iracedeck/iracing-sdk";

export {
  celsiusToFahrenheit,
  FUEL_UNIT_IMPERIAL,
  FUEL_UNIT_METRIC,
  GALLONS_TO_LITERS,
  gallonsToLiters,
  LITERS_TO_GALLONS,
  litersToGallons,
} from "@iracedeck/app-constants";

/**
 * Maps iRacing's DisplayUnits value onto the sim-neutral unit system: Metric is
 * metric, anything else — English, or a value not yet known — is imperial.
 * @param displayUnits - The iRacing DisplayUnits value (0=English, 1=Metric)
 * @returns `"metric"` for Metric, otherwise `"imperial"`
 */
export function unitSystemOf(displayUnits: DisplayUnits | number | undefined): UnitSystem {
  return displayUnits === DisplayUnits.Metric ? "metric" : "imperial";
}

/**
 * Gets the fuel unit suffix based on display units setting
 * @param displayUnits - The iRacing DisplayUnits value (0=English, 1=Metric)
 * @returns The appropriate unit suffix ("L" or "gal")
 */
export function getFuelUnitSuffix(displayUnits: DisplayUnits | number | undefined): string {
  return fuelUnitSuffixFor(unitSystemOf(displayUnits));
}

/**
 * Checks if display units are metric
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns true if metric, false if English/imperial
 */
export function isMetricUnits(displayUnits: DisplayUnits | number | undefined): boolean {
  return unitSystemOf(displayUnits) === "metric";
}

/**
 * Converts fuel amount from internal (liters) to display units
 * @param liters - Fuel amount in liters (internal unit)
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns Fuel amount in the user's preferred unit
 */
export function fuelToDisplayUnits(liters: number, displayUnits: DisplayUnits | number | undefined): number {
  return fuelToUnitSystem(liters, unitSystemOf(displayUnits));
}

/**
 * Converts fuel amount from display units to internal (liters)
 * @param amount - Fuel amount in display units
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns Fuel amount in liters (internal unit)
 */
export function fuelFromDisplayUnits(amount: number, displayUnits: DisplayUnits | number | undefined): number {
  return fuelFromUnitSystem(amount, unitSystemOf(displayUnits));
}

/**
 * Formats fuel amount with appropriate unit suffix
 * @param liters - Fuel amount in liters (internal unit)
 * @param displayUnits - The iRacing DisplayUnits value
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string like "5.0 L" or "1.3 gal"
 */
export function formatFuelAmount(
  liters: number,
  displayUnits: DisplayUnits | number | undefined,
  decimals: number = 1,
): string {
  return formatFuelIn(liters, unitSystemOf(displayUnits), decimals);
}
