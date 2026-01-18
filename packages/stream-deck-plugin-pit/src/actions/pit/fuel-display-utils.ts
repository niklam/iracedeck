/**
 * Fuel Display Utilities
 *
 * Pure functions for fuel display logic.
 */

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
 * Escapes special XML characters in a string.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Fuel pump body -->
    <rect x="18" y="6" width="20" height="30" rx="2" fill="none" stroke="${color}" stroke-width="2.5"/>

    <!-- Fuel gauge inside pump -->
    <rect x="22" y="10" width="12" height="8" rx="1" fill="none" stroke="${color}" stroke-width="1.5"/>

    <!-- Hose -->
    <path d="M38 14 h6 a4 4 0 0 1 4 4 v14" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>

    <!-- Nozzle -->
    <path d="M48 32 l6 -2 v8 l-6 -2 z" fill="${color}"/>
${disabledOverlay}${textElement}
  </g>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
