/**
 * SVG Overlay Utilities
 *
 * Functions for applying visual overlays to SVG images,
 * used to indicate inactive/disconnected state on Stream Deck buttons.
 */

/**
 * Default overlay color - semi-transparent gray
 */
const OVERLAY_COLOR = "rgba(128, 128, 128, 0.6)";

/**
 * Checks if a string is a base64 data URI
 */
export function isDataUri(value: string): boolean {
  return value.startsWith("data:");
}

/**
 * Checks if a string is raw SVG (starts with <svg or <?xml)
 */
export function isRawSvg(value: string): boolean {
  const trimmed = value.trim();

  return trimmed.startsWith("<svg") || trimmed.startsWith("<?xml");
}

/**
 * Converts raw SVG string to base64 data URI
 */
export function svgToDataUri(rawSvg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(rawSvg).toString("base64")}`;
}

/**
 * Converts base64 SVG data URI to raw SVG string
 */
export function dataUriToSvg(dataUri: string): string {
  // Handle both base64 and plain text data URIs
  const base64Match = dataUri.match(/^data:image\/svg\+xml;base64,(.+)$/);

  if (base64Match) {
    return Buffer.from(base64Match[1], "base64").toString("utf-8");
  }

  // Plain text data URI (rarely used but supported)
  const plainMatch = dataUri.match(/^data:image\/svg\+xml,(.+)$/);

  if (plainMatch) {
    return decodeURIComponent(plainMatch[1]);
  }

  throw new Error("Invalid SVG data URI format");
}

/**
 * Applies a semi-transparent gray overlay to an SVG image.
 * Used to indicate inactive/disconnected state.
 *
 * @param svg - Raw SVG string or base64 data URI
 * @returns SVG with overlay applied, in the same format as input
 */
export function applyInactiveOverlay(svg: string): string {
  const wasDataUri = isDataUri(svg);

  // Convert to raw SVG for manipulation
  let rawSvg: string;

  if (wasDataUri) {
    rawSvg = dataUriToSvg(svg);
  } else if (isRawSvg(svg)) {
    rawSvg = svg;
  } else {
    // Not a valid SVG format, return as-is
    return svg;
  }

  // Insert overlay rect just before </svg>
  const overlayRect = `<rect width="100%" height="100%" fill="${OVERLAY_COLOR}"/>`;
  const modifiedSvg = rawSvg.replace(/<\/svg>\s*$/i, `${overlayRect}</svg>`);

  // Return in same format as input
  return wasDataUri ? svgToDataUri(modifiedSvg) : modifiedSvg;
}
