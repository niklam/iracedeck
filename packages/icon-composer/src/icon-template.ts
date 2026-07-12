/**
 * Icon Template Utilities
 *
 * Functions for rendering SVG icon templates with placeholder support.
 * Templates use Mustache-style {{placeholder}} syntax.
 *
 * Icons support customizable color slots declared via <desc> JSON metadata.
 * Colors resolve through: per-action override → global default → icon default.
 */

/**
 * Color slots that an icon can declare as customizable.
 * Each slot maps to a Mustache placeholder in the SVG template.
 */
export interface ColorSlots {
  /** Full-canvas background rect fill */
  backgroundColor?: string;
  /** mainLabel + subLabel text fill */
  textColor?: string;
  /** Primary single-color artwork (arrows, outlines) */
  graphic1Color?: string;
  /** Secondary artwork accent element */
  graphic2Color?: string;
}

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
    // split/join avoids String.replace special $-sequences ($&, $`, $', etc.)
    result = result.split(`{{${key}}}`).join(value);
  }

  return result;
}

/**
 * Parses the <desc> element from an SVG template and returns its JSON content.
 * Returns an empty object if the element is missing or its content is not valid JSON.
 *
 * @internal Exported for testing and use by icon-related utilities
 */
export function parseDescMetadata(svgTemplate: string): Record<string, unknown> {
  const descMatch = svgTemplate.match(/<desc>(.*?)<\/desc>/s);

  if (!descMatch) {
    return {};
  }

  try {
    return JSON.parse(descMatch[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Parses color slot defaults from an SVG template's <desc> metadata.
 * The <desc> element should contain JSON: {"colors":{"backgroundColor":"#412244",...}}
 *
 * @param svgTemplate - SVG template string containing a <desc> element
 * @returns Declared color slots with their default values, or empty object if no metadata
 *
 * @internal Exported for testing
 */
export function parseIconDefaults(svgTemplate: string): ColorSlots {
  const parsed = parseDescMetadata(svgTemplate);

  return (parsed.colors ?? {}) as ColorSlots;
}

export interface IconTitleDefaults {
  text?: string;
  showTitle?: boolean;
  position?: "top" | "middle" | "bottom" | "custom";
  fontSize?: number;
  customPosition?: number;
  locked?: string[];
}

export function parseIconTitleDefaults(svgTemplate: string): IconTitleDefaults {
  const meta = parseDescMetadata(svgTemplate);

  if (!meta) return {};

  const title = meta.title as Record<string, unknown> | undefined;

  if (!title) return {};

  const pos = title.position;
  const validPositions = new Set(["top", "middle", "bottom", "custom"]);

  return {
    text: typeof title.text === "string" ? title.text : undefined,
    showTitle: typeof title.showTitle === "boolean" ? title.showTitle : undefined,
    position: typeof pos === "string" && validPositions.has(pos) ? (pos as IconTitleDefaults["position"]) : undefined,
    fontSize: typeof title.fontSize === "number" ? title.fontSize : undefined,
    customPosition: typeof title.customPosition === "number" ? title.customPosition : undefined,
    locked: (() => {
      if (!Array.isArray(title.locked)) return undefined;

      const filtered = title.locked.filter((item): item is string => typeof item === "string");

      return filtered.length > 0 ? filtered : undefined;
    })(),
  };
}

export interface IconBorderDefaults {
  borderColor?: string;
  enabled?: boolean;
  glowEnabled?: boolean;
  /**
   * Border fields protected from global border defaults (issue #755) — same
   * semantics as the title `locked` array: a locked field skips the global
   * step and uses the icon default, while a per-action override still wins.
   * Lockable field names: `enabled`, `borderWidth`, `color`, `glowEnabled`,
   * `glowWidth`.
   */
  locked?: string[];
}

export function parseIconBorderDefaults(svgTemplate: string): IconBorderDefaults {
  const meta = parseDescMetadata(svgTemplate);

  if (!meta) return {};

  const border = meta.border as Record<string, unknown> | undefined;

  if (!border) return {};

  return {
    borderColor: typeof border.color === "string" ? border.color : undefined,
    enabled: typeof border.enabled === "boolean" ? border.enabled : undefined,
    glowEnabled: typeof border.glowEnabled === "boolean" ? border.glowEnabled : undefined,
    locked: (() => {
      if (!Array.isArray(border.locked)) return undefined;

      const filtered = border.locked.filter((item): item is string => typeof item === "string");

      return filtered.length > 0 ? filtered : undefined;
    })(),
  };
}

/**
 * Parsed SVG viewBox.
 */
export interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Parses the viewBox from the root <svg> element. Returns undefined when the
 * attribute is absent or unparseable. Trimmed icons store their artwork extent
 * directly here, so this replaces the older artworkBounds metadata.
 */
export function parseSvgViewBox(svgTemplate: string): SvgViewBox | undefined {
  const match = svgTemplate.match(/<svg\b[^>]*\bviewBox\s*=\s*(["'])(.*?)\1/i);

  if (!match) return undefined;

  const parts = match[2]
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;

  const [x, y, width, height] = parts;

  if (width <= 0 || height <= 0) return undefined;

  return { x, y, width, height };
}

/**
 * Parses locked color slots from an SVG template's <desc> metadata.
 * Locked slots skip global color overrides but still accept per-action overrides.
 *
 * @param svgTemplate - SVG template string containing a <desc> element
 * @returns Set of slot names that are locked, or empty Set if none
 *
 * @internal Exported for testing
 */
export function parseIconLocked(svgTemplate: string): Set<string> {
  const parsed = parseDescMetadata(svgTemplate);

  return new Set(Array.isArray(parsed.locked) ? (parsed.locked as string[]) : []);
}

/**
 * Resolves icon colors by merging per-action overrides, global defaults, and icon defaults.
 * Only returns keys that the icon declares in its <desc> metadata — unsupported slots are omitted.
 *
 * Resolution chain: actionOverrides → globalColors → icon defaults (from <desc>)
 *
 * @param svgTemplate - SVG template string with <desc> color metadata
 * @param globalColors - User's global color preferences
 * @param actionOverrides - Per-action color overrides (optional)
 * @returns Merged color values for all slots declared by this icon
 *
 * @internal Exported for testing
 */
export function resolveIconColors(
  svgTemplate: string,
  globalColors: ColorSlots,
  actionOverrides?: ColorSlots,
): Record<string, string> {
  const parsed = parseDescMetadata(svgTemplate);
  const defaults = (parsed.colors ?? {}) as ColorSlots;
  const locked = new Set(Array.isArray(parsed.locked) ? (parsed.locked as string[]) : []);
  const result: Record<string, string> = {};

  for (const key of Object.keys(defaults) as (keyof ColorSlots)[]) {
    const defaultValue = defaults[key];

    if (defaultValue === undefined) {
      continue;
    }

    // Filter empty strings and #000001 (legacy sentinel from <sdpi-color> era — kept for backward compat)
    const pick = (v: string | undefined) => (v && v.length > 0 && v !== "#000001" ? v : undefined);

    const globalValue = locked.has(key) ? undefined : pick(globalColors[key]);

    result[key] = pick(actionOverrides?.[key]) ?? globalValue ?? defaultValue;
  }

  return result;
}

/**
 * Options for generating icon text elements.
 */
export interface GenerateIconTextOptions {
  text: string;
  fontSize?: number;
  baseY?: number;
  centerX?: number;
  lineHeightMultiplier?: number;
  fill?: string;
}

/**
 * Generates SVG text element(s) for icon display.
 * Supports multi-line text by splitting on "\n".
 */
export function generateIconText(options: GenerateIconTextOptions): string {
  const { text, fontSize = 28, baseY = 136, centerX = 72, lineHeightMultiplier = 1, fill = "#ffffff" } = options;

  const lines = text.split("\n");
  const lineHeight = fontSize * lineHeightMultiplier;

  if (lines.length === 1) {
    return `<text class="title" x="${centerX}" y="${baseY}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(text)}</text>`;
  }

  const totalBlockHeight = (lines.length - 1) * lineHeight;
  const startY = baseY - totalBlockHeight / 2;

  const textElements: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * lineHeight;
    textElements.push(
      `<text class="title" x="${centerX}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${escapeXml(lines[i])}</text>`,
    );
  }

  return textElements.join("\n    ");
}

export function validateIconTemplate(svg: string): string[] {
  const errors: string[] = [];

  // Check viewBox — must parse and have positive width/height. Trimmed icons
  // have variable viewBox dimensions (the artwork extent), so we no longer
  // hard-check 144x144 / 72x72 literals.
  const viewBox = parseSvgViewBox(svg);

  if (!viewBox) {
    errors.push('Missing or unparseable viewBox. Expected: <svg viewBox="0 0 W H"> with positive W and H.');
  } else if (viewBox.width > 144 || viewBox.height > 144) {
    errors.push(
      `Oversized viewBox ${viewBox.width}x${viewBox.height}. Expected dimensions <= 144 (standard render canvas).`,
    );
  }

  // Check for a dangling activity-state filter reference — the filter id is never defined
  // in the emitted SVG (it belongs to the disabled inactive-overlay feature), and resvg does
  // not render elements referencing an unresolvable filter (unlike the old QT renderers).
  if (svg.includes('filter="url(#activity-state)"')) {
    errors.push(
      'Dangling activity-state filter reference. Elements referencing an undefined filter are not rendered by resvg — remove filter="url(#activity-state)" (the inactive-overlay system injects its own filter when active).',
    );
  }

  // Check SVG namespace
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    errors.push('Missing SVG namespace. Expected: xmlns="http://www.w3.org/2000/svg"');
  }

  return errors;
}
