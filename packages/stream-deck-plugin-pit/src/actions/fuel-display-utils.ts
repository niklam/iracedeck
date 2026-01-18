/**
 * Fuel Display Utilities
 *
 * Pure functions for fuel display logic.
 */
import { escapeXml, renderIconTemplate, svgToDataUri } from "@iracedeck/stream-deck-shared";

import displayFuelToAddTemplate from "../icons/display-fuel-to-add.svg";

/**
 * Default icon color for fuel pump (green when active).
 */
export const FUEL_ACTIVE_COLOR = "#2ecc71";

/**
 * Icon color for fuel pump when disabled (gray).
 */
export const FUEL_INACTIVE_COLOR = "#888888";

/**
 * Color for the X overlay when fuel fill is disabled.
 */
export const FUEL_DISABLED_X_COLOR = "#e74c3c";

/**
 * Generates an SVG fuel pump icon with fuel amount display.
 *
 * @param isFuelFillEnabled - Whether fuel fill is enabled in pit service
 * @param fuelAmount - The amount of fuel to display (in liters), or null if unavailable
 * @returns A base64-encoded data URI for the SVG
 */
export function generateFuelDisplaySvg(isFuelFillEnabled: boolean, fuelAmount: number | null): string {
  const color = isFuelFillEnabled ? FUEL_ACTIVE_COLOR : FUEL_INACTIVE_COLOR;
  const disabledOverlay = isFuelFillEnabled ? "" : generateDisabledOverlay();
  const textElement = generateFuelText(isFuelFillEnabled, fuelAmount);

  const svg = renderIconTemplate(displayFuelToAddTemplate, { color, disabledOverlay, textElement });

  return svgToDataUri(svg);
}

/**
 * Generates the red X overlay for disabled fuel fill.
 */
function generateDisabledOverlay(): string {
  return `
    <!-- Red X when fuel fill is disabled -->
    <line x1="21" y1="6" x2="51" y2="36" stroke="${FUEL_DISABLED_X_COLOR}" stroke-width="4" stroke-linecap="round"/>
    <line x1="51" y1="6" x2="21" y2="36" stroke="${FUEL_DISABLED_X_COLOR}" stroke-width="4" stroke-linecap="round"/>`;
}

/**
 * Generates the fuel amount text element.
 */
function generateFuelText(isFuelFillEnabled: boolean, fuelAmount: number | null): string {
  let displayText: string;

  if (isFuelFillEnabled) {
    if (fuelAmount !== null) {
      displayText = `${Math.round(fuelAmount)} L`;
    } else {
      displayText = "-";
    }
  } else {
    displayText = "No Refuel";
  }

  // Position text in the bottom portion of the icon (below the pump graphic)
  return `
    <text class="title" x="36" y="65" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="sans-serif" font-size="12" font-weight="bold">${escapeXml(displayText)}</text>`;
}
