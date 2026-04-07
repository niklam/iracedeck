const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";

/**
 * @internal Exported for testing
 *
 * Status bar showing ON state — full-width green bar with "ON" text at the bottom.
 */
export function statusBarOn(): string {
  return `
    <rect x="0" y="100" width="144" height="44" fill="${GREEN}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${WHITE}" font-family="Arial" font-size="20" font-weight="900">ON</text>`;
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
          fill="${WHITE}" font-family="Arial" font-size="22" font-weight="700">OFF</text>`;
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
          fill="${WHITE}" font-family="Arial" font-size="20" font-weight="900">N/A</text>`;
}

/**
 * @internal Exported for testing
 *
 * Maps a toggle state to the corresponding status bar color for border indicators.
 */
export function borderColorForState(state: "on" | "off" | "na"): string {
  switch (state) {
    case "on":
      return GREEN;
    case "off":
      return RED;
    case "na":
      return GRAY;
  }
}
