/**
 * SVG Overlay Utilities
 *
 * Functions for applying visual overlays to SVG images,
 * used to indicate inactive/disconnected state on Stream Deck buttons.
 */

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
 * Converts a hex color to grayscale.
 * Uses luminance formula: 0.299*R + 0.587*G + 0.114*B
 *
 * @param hex - Hex color string (#RGB, #RRGGBB, or without #)
 * @returns Grayscale hex color (#RRGGBB format)
 */
export function hexToGrayscale(hex: string): string {
  // Remove # if present
  const cleanHex = hex.replace(/^#/, "");

  // Validate hex characters
  if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
    return hex;
  }

  let r: number, g: number, b: number;

  if (cleanHex.length === 3) {
    // Short form: #RGB -> #RRGGBB
    r = parseInt(cleanHex[0] + cleanHex[0], 16);
    g = parseInt(cleanHex[1] + cleanHex[1], 16);
    b = parseInt(cleanHex[2] + cleanHex[2], 16);
  } else if (cleanHex.length === 6) {
    r = parseInt(cleanHex.slice(0, 2), 16);
    g = parseInt(cleanHex.slice(2, 4), 16);
    b = parseInt(cleanHex.slice(4, 6), 16);
  } else {
    // Invalid format, return as-is
    return hex;
  }

  // Calculate luminance (perceived brightness)
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

  // Convert back to hex
  const grayHex = gray.toString(16).padStart(2, "0");

  return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Applies a grayscale effect to an SVG image by converting all hex colors.
 * Used to indicate inactive/disconnected state.
 *
 * Finds all hex colors (#RGB or #RRGGBB) and converts them to grayscale.
 *
 * @param svg - Raw SVG string or base64 data URI
 * @returns SVG with colors converted to grayscale, in the same format as input
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

  const filters = `<defs>
    <filter id="activity-state">
      <feColorMatrix type="saturate" values="0" />
      <feColorMatrix type="matrix"
        values="0.5 0 0 0 0
                0 0.5 0 0 0
                0 0 0.5 0 0
                0 0 0 1 0" />
    </filter>
  </defs>`;

  const modifiedSvg = rawSvg.replace(/<svg(.*?)>/, `<svg$1>\n${filters}\n`);

  // Return in same format as input
  return wasDataUri ? svgToDataUri(modifiedSvg) : modifiedSvg;
}
