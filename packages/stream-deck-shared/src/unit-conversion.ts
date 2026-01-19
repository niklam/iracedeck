/**
 * Unit Conversion Utilities
 *
 * Handles conversion between metric and imperial units based on iRacing's DisplayUnits setting.
 * iRacing internally uses metric units (liters, kPa, etc.) - these utilities convert for display only.
 */
import { DisplayUnits } from "@iracedeck/iracing-sdk";

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
 * Gets the fuel unit suffix based on display units setting
 * @param displayUnits - The iRacing DisplayUnits value (0=English, 1=Metric)
 * @returns The appropriate unit suffix ("L" or "gal")
 */
export function getFuelUnitSuffix(displayUnits: DisplayUnits | number | undefined): string {
  return displayUnits === DisplayUnits.Metric ? FUEL_UNIT_METRIC : FUEL_UNIT_IMPERIAL;
}

/**
 * Checks if display units are metric
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns true if metric, false if English/imperial
 */
export function isMetricUnits(displayUnits: DisplayUnits | number | undefined): boolean {
  return displayUnits === DisplayUnits.Metric;
}

/**
 * Converts fuel amount from internal (liters) to display units
 * @param liters - Fuel amount in liters (internal unit)
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns Fuel amount in the user's preferred unit
 */
export function fuelToDisplayUnits(liters: number, displayUnits: DisplayUnits | number | undefined): number {
  if (displayUnits === DisplayUnits.Metric) {
    return liters;
  }

  return litersToGallons(liters);
}

/**
 * Converts fuel amount from display units to internal (liters)
 * @param amount - Fuel amount in display units
 * @param displayUnits - The iRacing DisplayUnits value
 * @returns Fuel amount in liters (internal unit)
 */
export function fuelFromDisplayUnits(amount: number, displayUnits: DisplayUnits | number | undefined): number {
  if (displayUnits === DisplayUnits.Metric) {
    return amount;
  }

  return gallonsToLiters(amount);
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
  const displayValue = fuelToDisplayUnits(liters, displayUnits);
  const suffix = getFuelUnitSuffix(displayUnits);

  return `${displayValue.toFixed(decimals)} ${suffix}`;
}

/**
 * Formats fuel amount for button display (with +/- prefix)
 * Note: This converts from internal liters to display units
 * @param liters - Fuel amount in liters (internal unit)
 * @param displayUnits - The iRacing DisplayUnits value
 * @param prefix - The prefix to add (e.g., "+" or "-")
 * @param decimals - Number of decimal places (default: 0 for whole numbers)
 * @returns Formatted string like "+5 L" or "-1 gal"
 */
export function formatFuelAmountWithPrefix(
  liters: number,
  displayUnits: DisplayUnits | number | undefined,
  prefix: string,
  decimals: number = 0,
): string {
  const displayValue = fuelToDisplayUnits(liters, displayUnits);
  const suffix = getFuelUnitSuffix(displayUnits);

  return `${prefix}${displayValue.toFixed(decimals)} ${suffix}`;
}

/**
 * Formats a fuel setting value (already in display units) with the appropriate unit suffix
 * Use this for user-configured amounts that are already in the user's preferred unit
 * @param amount - Fuel amount already in display units (no conversion)
 * @param displayUnits - The iRacing DisplayUnits value
 * @param prefix - Optional prefix to add (e.g., "+" or "-")
 * @param decimals - Number of decimal places for non-integers (default: 1). Integers are shown without decimals.
 * @returns Formatted string like "+5 L" or "-1.5 gal"
 */
export function formatFuelSettingWithUnit(
  amount: number,
  displayUnits: DisplayUnits | number | undefined,
  prefix: string = "",
  decimals: number = 1,
): string {
  const suffix = getFuelUnitSuffix(displayUnits);
  // Use tolerance-based check for integers to handle floating point precision issues
  const rounded = Math.round(amount);
  const isEffectivelyInteger = Math.abs(amount - rounded) < 0.0001;
  const formattedAmount = isEffectivelyInteger ? rounded.toString() : amount.toFixed(decimals);

  return `${prefix}${formattedAmount} ${suffix}`;
}
