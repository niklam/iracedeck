/**
 * Colour helpers.
 *
 * Pure functions over colour strings, shared by anything that recolours key
 * artwork (the unavailable look in `iracing-actions` is the first user).
 */

/**
 * Converts a hex color to grayscale.
 * Uses the luminance formula: 0.299*R + 0.587*G + 0.114*B
 *
 * @param hex - Hex color string (#RGB, #RRGGBB, or without #)
 * @returns Grayscale hex color (#RRGGBB format), or the input unchanged when it is not a hex color
 */
export function hexToGrayscale(hex: string): string {
  const cleanHex = hex.replace(/^#/, "");

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
    return hex;
  }

  // Perceived brightness
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayHex = gray.toString(16).padStart(2, "0");

  return `#${grayHex}${grayHex}${grayHex}`;
}
