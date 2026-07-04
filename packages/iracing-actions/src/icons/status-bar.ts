const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";

/**
 * Tri-state toggle indication shared by the status bars, state-driven key
 * borders, and the Fuel Service dial's bar styling: on (green) / off (red) / na (gray).
 */
export type ToggleState = "on" | "off" | "na";

/**
 * @internal Exported for testing
 *
 * Status bar showing ON state — full-width green bar with "ON" text at the bottom.
 */
export function statusBarOn(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GREEN}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">ON</text>`;
}

/**
 * @internal Exported for testing
 *
 * Status bar showing OFF state — full-width red bar with "OFF" text at the bottom.
 */
export function statusBarOff(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${RED}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">OFF</text>`;
}

/**
 * @internal Exported for testing
 *
 * Status bar showing N/A state — full-width gray bar with "N/A" text at the bottom.
 */
export function statusBarNA(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GRAY}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">N/A</text>`;
}

/**
 * @internal Exported for testing
 *
 * Maps a toggle state to the corresponding status bar color for border indicators.
 */
export function borderColorForState(state: ToggleState): string {
  switch (state) {
    case "on":
      return GREEN;
    case "off":
      return RED;
    case "na":
      return GRAY;
  }
}
