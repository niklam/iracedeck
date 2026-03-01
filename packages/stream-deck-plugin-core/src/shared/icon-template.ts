/**
 * Icon Template Utilities
 *
 * Functions for loading and rendering SVG icon templates with placeholder support.
 * Templates use Mustache-style {{placeholder}} syntax.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { svgToDataUri } from "./overlay-utils.js";

/**
 * Cache for loaded templates to avoid repeated file I/O
 */
const templateCache = new Map<string, string>();

/**
 * Escapes special XML characters in a string.
 * Use this for text values that will be inserted into SVG.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Loads an SVG template from the file system.
 *
 * @param pluginPath - Base path to the .sdPlugin directory
 * @param actionName - Name of the action (e.g., "do-fuel-add" or "vehicle/display-gear")
 * @returns The raw SVG template string
 */
export function loadIconTemplate(pluginPath: string, actionName: string): string {
  const cacheKey = `${pluginPath}:${actionName}`;

  const cached = templateCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const templatePath = join(pluginPath, "imgs", "actions", actionName, "key-template.svg");
  const template = readFileSync(templatePath, "utf-8");

  templateCache.set(cacheKey, template);

  return template;
}

/**
 * Renders a template by replacing {{placeholder}} with values.
 * Values are NOT automatically XML-escaped - use escapeXml() for text content.
 *
 * @param template - The SVG template string with {{placeholder}} markers
 * @param values - Object mapping placeholder names to replacement values
 * @returns The rendered SVG string
 */
export function renderIconTemplate(template: string, values: Record<string, string>): string {
  let result = template;

  for (const [key, value] of Object.entries(values)) {
    // Replace all occurrences of {{key}} with value
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  return result;
}

/**
 * Loads a template, renders it with values, and converts to data URI.
 *
 * @param pluginPath - Base path to the .sdPlugin directory
 * @param actionName - Name of the action (e.g., "do-fuel-add" or "vehicle/display-gear")
 * @param values - Object mapping placeholder names to replacement values
 * @returns Base64-encoded data URI for the rendered SVG
 */
export function renderIcon(pluginPath: string, actionName: string, values: Record<string, string>): string {
  const template = loadIconTemplate(pluginPath, actionName);
  const rendered = renderIconTemplate(template, values);

  return svgToDataUri(rendered);
}

/**
 * Clears the template cache.
 * Useful for testing or when templates may have changed.
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}

/**
 * Validates that an SVG template follows the required format.
 * Returns an array of validation errors (empty if valid).
 *
 * Required format:
 * - viewBox="0 0 72 72"
 * - Contains <g filter="url(#activity-state)">
 * - Text elements at y="62" for bottom positioning
 * - Dynamic text elements have class="title"
 */
/**
 * Options for generating icon text elements.
 */
export interface GenerateIconTextOptions {
  /**
   * The text to display. Use "\n" to create multiple lines.
   */
  text: string;
  /**
   * Font size in pixels. Default: 14
   */
  fontSize?: number;
  /**
   * Base Y position for single line or bottom line of multi-line text. Default: 62
   */
  baseY?: number;
  /**
   * Line height multiplier relative to font size. Default: 1
   */
  lineHeightMultiplier?: number;
  /**
   * Fill color for the text. Default: "#ffffff"
   */
  fill?: string;
}

/**
 * Generates SVG text element(s) for icon display.
 * Supports multi-line text by splitting on "\n".
 *
 * For single line: places text at baseY (default 62)
 * For multiple lines: centers the text block vertically around baseY
 * (each additional line shifts the block up by half the line height)
 *
 * @param options - Configuration options for text generation
 * @returns SVG text element(s) string to be used with {{textElement}} placeholder
 *
 * @example
 * // Single line
 * generateIconText({ text: "+5 L" })
 * // Returns: <text class="title" x="36" y="62" ...>+5 L</text>
 *
 * @example
 * // Multi-line
 * generateIconText({ text: "Line 1\nLine 2", fontSize: 12 })
 * // Returns two <text> elements centered around baseY
 */
export function generateIconText(options: GenerateIconTextOptions): string {
  const { text, fontSize = 14, baseY = 62, lineHeightMultiplier = 1, fill = "#ffffff" } = options;

  const lines = text.split("\n");
  const lineHeight = fontSize * lineHeightMultiplier;

  if (lines.length === 1) {
    return `<text class="title" x="36" y="${baseY}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(text)}</text>`;
  }

  // For multiple lines, center the text block around baseY
  // Total height of text block is (lines.length - 1) * lineHeight
  // We offset up by half of that to center it
  const totalBlockHeight = (lines.length - 1) * lineHeight;
  const startY = baseY - totalBlockHeight / 2;

  const textElements: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * lineHeight;
    textElements.push(
      `<text class="title" x="36" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(lines[i])}</text>`,
    );
  }

  return textElements.join("\n    ");
}

export function validateIconTemplate(svg: string): string[] {
  const errors: string[] = [];

  // Check viewBox
  if (!svg.includes('viewBox="0 0 72 72"')) {
    errors.push('Missing or incorrect viewBox. Expected: viewBox="0 0 72 72"');
  }

  // Check for activity-state filter group
  if (!svg.includes('filter="url(#activity-state)"')) {
    errors.push('Missing activity-state filter group. Expected: <g filter="url(#activity-state)">');
  }

  // Check SVG namespace
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    errors.push('Missing SVG namespace. Expected: xmlns="http://www.w3.org/2000/svg"');
  }

  return errors;
}
