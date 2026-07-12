import type { ResolvedBorderSettings } from "./title-settings.js";

export const ICON_BASE_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect x="0" y="0" width="144" height="144" rx="24" fill="{{backgroundColor}}"/>
  {{borderContent}}
  {{graphicContent}}
  {{titleContent}}
</svg>`;

/**
 * Generates border SVG with defs and rects separated.
 * Dynamic templates place `defs` as a direct child of `<svg>` (via {{borderDefs}})
 * and `rects` inside the content group (via {{borderContent}}).
 * For ICON_BASE_TEMPLATE, callers can concatenate defs + rects into {{borderContent}}
 * since it's already a direct child of `<svg>`.
 */
export function generateBorderParts(border: ResolvedBorderSettings): {
  defs: string;
  rects: string;
} {
  if (!border.enabled) return { defs: "", rects: "" };

  const glowStdDev = 6;
  const glowOpacity = 0.4;

  const borderInset = border.borderWidth / 2;
  const borderRx = Math.max(0, 24 - borderInset);
  const borderRect = `<rect x="${borderInset}" y="${borderInset}" width="${144 - 2 * borderInset}" height="${144 - 2 * borderInset}" rx="${borderRx}" fill="none" stroke="${border.borderColor}" stroke-width="${border.borderWidth}"/>`;

  if (!border.glowEnabled) {
    return { defs: "", rects: borderRect };
  }

  const clampedGlowWidth = Math.min(border.glowWidth, 30);
  const glowInset = border.borderWidth;
  const glowRx = Math.max(0, 24 - glowInset);
  const glowDefs = `<defs><filter id="ird-border-glow"><feGaussianBlur stdDeviation="${glowStdDev}"/></filter></defs>`;
  const glowRect = `<rect x="${glowInset}" y="${glowInset}" width="${144 - 2 * glowInset}" height="${144 - 2 * glowInset}" rx="${glowRx}" fill="none" stroke="${border.borderColor}" stroke-width="${clampedGlowWidth}" opacity="${glowOpacity}" filter="url(#ird-border-glow)"/>`;

  return {
    defs: glowDefs,
    rects: glowRect + borderRect,
  };
}

/**
 * Extract the inner content of an SVG, stripping the outer <svg> wrapper,
 * <desc> metadata, background <rect>, and label <text> elements.
 * Returns only the graphic artwork.
 */
export function extractGraphicContent(svgTemplate: string): string {
  let content = svgTemplate;

  // Remove outer <svg> tags
  content = content.replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

  // Remove <desc> element
  content = content.replace(/<desc>[\s\S]*?<\/desc>/, "");

  // Remove background rect (the first rect filling the full canvas)
  content = content.replace(/<rect[^>]*width="144"[^>]*height="144"[^>]*fill="\{\{backgroundColor\}\}"[^>]*\/?>/i, "");

  // Remove mainLabel and subLabel text elements
  content = content.replace(/<text[^>]*>\{\{mainLabel\}\}<\/text>/g, "");
  content = content.replace(/<text[^>]*>\{\{subLabel\}\}<\/text>/g, "");

  // Remove <g filter="url(#activity-state)"> wrapper if present (keep inner content)
  // Only strip the closing </g> if the opening <g filter> was found and removed
  const hadActivityState = /<g\s+filter="url\(#activity-state\)"\s*>/.test(content);

  if (hadActivityState) {
    content = content.replace(/<g\s+filter="url\(#activity-state\)"\s*>/, "");
    content = content.replace(/<\/g>\s*$/, "");
  }

  // Remove <defs> and <filter> elements — activity-state filter is applied at render time by the overlay system
  content = content.replace(/<defs>[\s\S]*?<\/defs>/, "");

  return content.trim();
}
