import { Skies } from "@iracedeck/iracing-sdk";
import { generateIconText, renderIconTemplate, svgToDataUri } from "@iracedeck/stream-deck-shared";

import displaySkyTemplate from "../../icons/display-sky.svg";

/**
 * SVG graphics for each sky condition (without the outer svg wrapper)
 * These are the inner elements that go inside the <g filter="url(#activity-state)"> tag
 */
const SKY_GRAPHICS: Record<string, string> = {
  clear: `<!-- Clear sky - bright yellow sun -->
    <!-- Sun circle -->
    <circle cx="36" cy="21" r="10" fill="#FFD700"/>
    <!-- Sun rays -->
    <g stroke="#FFD700" stroke-width="2.5" stroke-linecap="round">
      <line x1="36" y1="5" x2="36" y2="8"/>
      <line x1="36" y1="34" x2="36" y2="37"/>
      <line x1="20" y1="21" x2="23" y2="21"/>
      <line x1="49" y1="21" x2="52" y2="21"/>
      <line x1="24.7" y1="9.7" x2="26.8" y2="11.8"/>
      <line x1="45.2" y1="30.2" x2="47.3" y2="32.3"/>
      <line x1="47.3" y1="9.7" x2="45.2" y2="11.8"/>
      <line x1="26.8" y1="30.2" x2="24.7" y2="32.3"/>
    </g>`,

  partlyCloudy: `<!-- Partly cloudy - sun with cloud partially covering -->
    <!-- Sun (upper left, centered around x=26, starts at y=6) -->
    <circle cx="26" cy="18" r="8" fill="#FFD700"/>
    <!-- Sun rays (all 8 directions) -->
    <g stroke="#FFD700" stroke-width="2" stroke-linecap="round">
      <line x1="26" y1="6" x2="26" y2="8"/>
      <line x1="26" y1="28" x2="26" y2="30"/>
      <line x1="14" y1="18" x2="16" y2="18"/>
      <line x1="36" y1="18" x2="38" y2="18"/>
      <line x1="17.5" y1="9.5" x2="19.2" y2="11.2"/>
      <line x1="32.8" y1="24.8" x2="34.5" y2="26.5"/>
      <line x1="34.5" y1="9.5" x2="32.8" y2="11.2"/>
      <line x1="19.2" y1="24.8" x2="17.5" y2="26.5"/>
    </g>
    <!-- Cloud (centered, partially covering sun) -->
    <ellipse cx="42" cy="30" rx="14" ry="8" fill="#FFFFFF"/>
    <ellipse cx="30" cy="32" rx="12" ry="7" fill="#FFFFFF"/>
    <ellipse cx="52" cy="32" rx="8" ry="5" fill="#FFFFFF"/>`,

  mostlyCloudy: `<!-- Mostly cloudy - large cloud with hint of sun -->
    <!-- Sun barely visible (upper left corner) -->
    <circle cx="18" cy="10" r="6" fill="#B8860B" opacity="0.6"/>
    <!-- Large cloud covering most of the area -->
    <ellipse cx="40" cy="20" rx="18" ry="10" fill="#C0C0C0"/>
    <ellipse cx="26" cy="24" rx="12" ry="8" fill="#D3D3D3"/>
    <ellipse cx="52" cy="24" rx="10" ry="7" fill="#D3D3D3"/>
    <ellipse cx="38" cy="14" rx="10" ry="6" fill="#E8E8E8"/>`,

  overcast: `<!-- Overcast - heavy dark clouds -->
    <!-- Upper cloud layer -->
    <ellipse cx="36" cy="12" rx="20" ry="8" fill="#808080"/>
    <ellipse cx="20" cy="14" rx="12" ry="6" fill="#707070"/>
    <ellipse cx="52" cy="14" rx="10" ry="5" fill="#707070"/>
    <!-- Lower cloud layer -->
    <ellipse cx="30" cy="26" rx="16" ry="9" fill="#909090"/>
    <ellipse cx="48" cy="28" rx="12" ry="7" fill="#909090"/>
    <ellipse cx="36" cy="20" rx="12" ry="6" fill="#A0A0A0"/>`,
};

/**
 * Default sky condition to use when no data is available
 */
const DEFAULT_SKY_CONDITION = "partlyCloudy";

/**
 * Get the SVG graphics content for a given sky condition
 * @param skies - The sky condition value from telemetry
 * @returns The SVG graphics content (inner elements)
 */
function getSkyGraphics(skies: number | null | undefined): string {
  if (skies === null || skies === undefined || typeof skies !== "number") {
    return SKY_GRAPHICS[DEFAULT_SKY_CONDITION];
  }

  switch (skies) {
    case Skies.Clear:
      return SKY_GRAPHICS.clear;
    case Skies.PartlyCloudy:
      return SKY_GRAPHICS.partlyCloudy;
    case Skies.MostlyCloudy:
      return SKY_GRAPHICS.mostlyCloudy;
    case Skies.Overcast:
      return SKY_GRAPHICS.overcast;
    default:
      return SKY_GRAPHICS[DEFAULT_SKY_CONDITION];
  }
}

/**
 * Generate a sky icon SVG with optional text label
 * @param skies - The sky condition value from telemetry
 * @param text - Optional text to display below the icon
 * @returns Base64-encoded SVG data URI
 */
export function generateSkyIcon(skies: number | null | undefined, text?: string): string {
  const skyGraphics = getSkyGraphics(skies);

  const textElement = text ? generateIconText({ text, fontSize: 12 }) : "";

  const svg = renderIconTemplate(displaySkyTemplate, { skyGraphics, textElement });

  return svgToDataUri(svg);
}

/**
 * Generate the default sky icon (partly cloudy, no text)
 * @returns Base64-encoded SVG data URI
 */
export function generateDefaultSkyIcon(): string {
  return generateSkyIcon(null);
}

/**
 * Get the display text for a given sky condition
 * @param skies - The sky condition value from telemetry
 * @returns Human-readable text describing the sky condition
 */
export function getSkyText(skies: number | null | undefined): string {
  if (skies === null || skies === undefined || typeof skies !== "number") {
    return "N/A";
  }

  switch (skies) {
    case Skies.Clear:
      return "Clear";
    case Skies.PartlyCloudy:
      return "Partly";
    case Skies.MostlyCloudy:
      return "Mostly";
    case Skies.Overcast:
      return "Overcast";
    default:
      return "N/A";
  }
}
