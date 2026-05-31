/**
 * Title Settings, Border Settings, Graphic Settings, and Icon Assembly
 *
 * Pure functions for resolving settings and assembling final icons.
 * No dependencies on global settings stores — all inputs are parameters.
 */
import { applyBindingWarning } from "./binding-warning.js";
import { extractGraphicContent, generateBorderParts, ICON_BASE_TEMPLATE } from "./icon-base.js";
import {
  escapeXml,
  parseIconBorderDefaults,
  parseIconTitleDefaults,
  parseSvgViewBox,
  renderIconTemplate,
} from "./icon-template.js";
import type { SvgViewBox } from "./icon-template.js";
import { svgToDataUri } from "./svg-utils.js";

// ---------------------------------------------------------------------------
// Title Settings
// ---------------------------------------------------------------------------

export interface ResolvedTitleSettings {
  showTitle: boolean;
  showGraphics: boolean;
  titleText: string;
  bold: boolean;
  fontSize: number;
  position: "top" | "middle" | "bottom" | "custom";
  customPosition: number;
}

export interface GlobalTitleSettings {
  showTitle?: boolean;
  showGraphics?: boolean;
  bold?: boolean | "default";
  fontSize?: number | "default";
  position?: "top" | "middle" | "bottom" | "custom" | "default";
  customPosition?: number | "default";
}

/**
 * Per-action title overrides. Fields set to undefined fall through
 * to global → icon default → hardcoded default.
 */
export interface TitleOverrides {
  showTitle?: boolean;
  showGraphics?: boolean;
  titleText?: string;
  bold?: boolean;
  fontSizeEnabled?: boolean;
  fontSize?: number;
  position?: "top" | "middle" | "bottom" | "custom";
  customPosition?: number;
}

const TITLE_DEFAULTS: Omit<ResolvedTitleSettings, "titleText"> = {
  showTitle: true,
  showGraphics: true,
  bold: true,
  fontSize: 9,
  position: "bottom",
  customPosition: 0,
};

export { TITLE_DEFAULTS };

export interface GenerateTitleTextOptions {
  text: string;
  fontSize: number;
  bold: boolean;
  position: "top" | "middle" | "bottom" | "custom";
  customPosition: number;
  fill: string;
}

export function generateTitleText(options: GenerateTitleTextOptions): string {
  const { text, bold, position, customPosition, fill } = options;
  // Double the PI font size for SVG rendering (consistent with telemetry-display and chat)
  const fontSize = options.fontSize * 2;

  if (!text) return "";

  const lines = text.split("\n");
  const lineHeight = fontSize * 1.2;
  const weight = bold ? "bold" : "normal";

  const makeTextEl = (content: string, y: number): string =>
    `<text x="72" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}">${escapeXml(content)}</text>`;

  const yPositions = calculateYPositions(lines.length, fontSize, lineHeight, position, customPosition);

  return lines.map((line, i) => makeTextEl(line, yPositions[i])).join("\n  ");
}

/**
 * @internal Exported for testing and for computeGraphicArea
 */
export function calculateYPositions(
  lineCount: number,
  fontSize: number,
  lineHeight: number,
  position: "top" | "middle" | "bottom" | "custom",
  customPosition: number,
): number[] {
  const positions: number[] = [];
  const totalHeight = (lineCount - 1) * lineHeight;

  switch (position) {
    case "top": {
      const startY = fontSize + 8;

      for (let i = 0; i < lineCount; i++) {
        positions.push(startY + i * lineHeight);
      }

      break;
    }
    case "middle": {
      // Dynamic center that adjusts with font size, matching telemetry-display pattern
      const centerY = 88 + (fontSize - 44) / 3;
      const startY = centerY - totalHeight / 2;

      for (let i = 0; i < lineCount; i++) {
        positions.push(startY + i * lineHeight);
      }

      break;
    }
    case "bottom": {
      const endY = 130;
      const startY = endY - totalHeight;

      for (let i = 0; i < lineCount; i++) {
        positions.push(startY + i * lineHeight);
      }

      break;
    }
    case "custom": {
      const centerY = 88 + (fontSize - 44) / 3 + customPosition;
      const startY = centerY - totalHeight / 2;

      for (let i = 0; i < lineCount; i++) {
        positions.push(startY + i * lineHeight);
      }

      break;
    }
  }

  return positions;
}

/**
 * Resolves title settings by merging per-action overrides, global settings, and defaults.
 *
 * Resolution chain for non-text fields: actionOverrides → globalTitleSettings → TITLE_DEFAULTS
 * Resolution chain for titleText: actionOverrides.titleText → actionDefaultText → desc metadata → ""
 *
 * @param graphicSvg - SVG template string with optional <desc> title metadata
 * @param globalTitleSettings - Plugin-level global title settings
 * @param actionOverrides - Per-action title overrides from action settings (optional)
 * @param actionDefaultText - Default title text provided by action code (optional)
 * @returns Fully resolved title settings with all fields populated
 */
export function resolveTitleSettings(
  graphicSvg: string,
  globalTitleSettings: GlobalTitleSettings,
  actionOverrides?: TitleOverrides,
  actionDefaultText?: string,
): ResolvedTitleSettings {
  const iconDefaults = parseIconTitleDefaults(graphicSvg);
  const locked = new Set(iconDefaults.locked ?? []);

  // Resolution: per-action → global (if not "default" and not locked) → icon <desc> default → TITLE_DEFAULTS
  const resolve = <T>(
    actionVal: T | undefined,
    globalVal: T | "default" | undefined,
    iconDefault: T | undefined,
    fallback: T,
    field?: string,
  ): T => {
    if (actionVal !== undefined) return actionVal;

    if (!(field && locked.has(field)) && globalVal !== undefined && globalVal !== "default") return globalVal as T;

    if (iconDefault !== undefined) return iconDefault;

    return fallback;
  };

  const titleText =
    (actionOverrides?.titleText && actionOverrides.titleText.length > 0 ? actionOverrides.titleText : undefined) ??
    actionDefaultText ??
    iconDefaults.text ??
    "";

  return {
    showTitle: resolve(
      actionOverrides?.showTitle,
      globalTitleSettings.showTitle,
      iconDefaults.showTitle,
      TITLE_DEFAULTS.showTitle,
      "showTitle",
    ),
    showGraphics: resolve(
      actionOverrides?.showGraphics,
      globalTitleSettings.showGraphics,
      undefined,
      TITLE_DEFAULTS.showGraphics,
      "showGraphics",
    ),
    titleText,
    bold: resolve(actionOverrides?.bold, globalTitleSettings.bold, undefined, TITLE_DEFAULTS.bold, "bold"),
    fontSize: resolve(
      actionOverrides?.fontSizeEnabled ? actionOverrides?.fontSize : undefined,
      globalTitleSettings.fontSize,
      iconDefaults.fontSize,
      TITLE_DEFAULTS.fontSize,
      "fontSize",
    ),
    position: resolve(
      actionOverrides?.position,
      globalTitleSettings.position,
      iconDefaults.position,
      TITLE_DEFAULTS.position,
      "position",
    ),
    customPosition: resolve(
      actionOverrides?.customPosition,
      globalTitleSettings.customPosition,
      iconDefaults.customPosition,
      TITLE_DEFAULTS.customPosition,
      "customPosition",
    ),
  };
}

// ---------------------------------------------------------------------------
// Border Settings
// ---------------------------------------------------------------------------

export interface ResolvedBorderSettings {
  enabled: boolean;
  borderWidth: number;
  borderColor: string;
  glowEnabled: boolean;
  glowWidth: number;
}

export interface GlobalBorderSettings {
  enabled?: boolean | "default";
  borderWidth?: number | "default";
  borderColor?: string;
  glowEnabled?: boolean | "default";
  glowWidth?: number | "default";
}

/**
 * Per-action border overrides. Fields set to undefined fall through
 * to global → icon default → hardcoded default.
 */
export interface BorderOverrides {
  enabled?: boolean;
  borderWidth?: number;
  borderColor?: string;
  glowEnabled?: boolean;
  glowWidth?: number;
}

const BORDER_DEFAULTS: ResolvedBorderSettings = {
  enabled: false,
  borderWidth: 7,
  borderColor: "#00aaff",
  glowEnabled: true,
  glowWidth: 18,
};

export { BORDER_DEFAULTS };

/**
 * Resolves border settings by merging per-action overrides, global settings, and icon defaults.
 *
 * Resolution chain: actionOverrides → globalBorderSettings → icon <desc> border defaults → BORDER_DEFAULTS
 *
 * @param graphicSvg - SVG template string with optional <desc> border metadata
 * @param globalBorderSettings - Plugin-level global border settings
 * @param actionOverrides - Per-action border overrides from settings (optional)
 * @param stateColor - State-driven color for toggle actions (overrides all color sources)
 */
export function resolveBorderSettings(
  graphicSvg: string,
  globalBorderSettings: GlobalBorderSettings,
  actionOverrides?: BorderOverrides,
  stateColor?: string,
): ResolvedBorderSettings {
  const iconDefaults = parseIconBorderDefaults(graphicSvg);

  const resolve = <T>(
    actionVal: T | undefined,
    globalVal: T | "default" | undefined,
    iconDefault: T | undefined,
    fallback: T,
  ): T => {
    if (actionVal !== undefined) return actionVal;

    if (globalVal !== undefined && globalVal !== "default") return globalVal as T;

    if (iconDefault !== undefined) return iconDefault;

    return fallback;
  };

  const borderColor =
    stateColor ??
    resolve(
      actionOverrides?.borderColor,
      globalBorderSettings.borderColor,
      iconDefaults.borderColor,
      BORDER_DEFAULTS.borderColor,
    );

  return {
    enabled: resolve(actionOverrides?.enabled, globalBorderSettings.enabled, undefined, BORDER_DEFAULTS.enabled),
    borderWidth: resolve(
      actionOverrides?.borderWidth,
      globalBorderSettings.borderWidth,
      undefined,
      BORDER_DEFAULTS.borderWidth,
    ),
    borderColor,
    glowEnabled:
      __FEATURE_BORDER_GLOW__ &&
      resolve(actionOverrides?.glowEnabled, globalBorderSettings.glowEnabled, undefined, BORDER_DEFAULTS.glowEnabled),
    glowWidth: resolve(
      actionOverrides?.glowWidth,
      globalBorderSettings.glowWidth,
      undefined,
      BORDER_DEFAULTS.glowWidth,
    ),
  };
}

// ---------------------------------------------------------------------------
// Graphic Settings (scaling & positioning)
// ---------------------------------------------------------------------------

export interface ResolvedGraphicSettings {
  /** Scale percentage (50–150). 100 = 85% of available area (comfortable fit). */
  scale: number;
}

export interface GlobalGraphicSettings {
  scale?: number | "default";
}

/**
 * Per-action graphic overrides.
 * scaleMode undefined = inherit from global.
 */
export interface GraphicOverrides {
  scaleMode?: "default" | "override";
  scale?: number;
}

const GRAPHIC_DEFAULTS: ResolvedGraphicSettings = {
  scale: 100,
};

export { GRAPHIC_DEFAULTS };

/**
 * Resolves graphic settings from per-action overrides and global settings.
 *
 * scaleMode resolution:
 *   undefined (inherit) → use global (if not "default") → GRAPHIC_DEFAULTS (100)
 *   "default"           → use 100% (ignores global)
 *   "override"          → use actionOverrides.scale (or 100 if not set)
 */
export function resolveGraphicSettings(
  globalSettings: GlobalGraphicSettings,
  actionOverrides?: GraphicOverrides,
): ResolvedGraphicSettings {
  if (actionOverrides?.scaleMode === "default") {
    return { scale: GRAPHIC_DEFAULTS.scale };
  }

  if (actionOverrides?.scaleMode === "override") {
    return { scale: clampScale(actionOverrides.scale ?? GRAPHIC_DEFAULTS.scale) };
  }

  // Inherit from global
  if (globalSettings.scale !== undefined && globalSettings.scale !== "default") {
    return { scale: clampScale(globalSettings.scale) };
  }

  return { scale: GRAPHIC_DEFAULTS.scale };
}

/** Clamp scale to valid 50–150 range for safety (global settings are not Zod-validated). */
function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 100;

  return Math.max(50, Math.min(150, value));
}

// ---------------------------------------------------------------------------
// Graphic Area Computation
// ---------------------------------------------------------------------------

export interface GraphicArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the available rectangle for the graphic based on resolved title settings.
 * The graphic should be scaled and centered within this area.
 *
 * @param title - Fully resolved title settings
 * @returns Available area rectangle within the 144x144 canvas
 */
export function computeGraphicArea(title: ResolvedTitleSettings): GraphicArea {
  const CANVAS = 144;
  const PADDING = 8;
  const fullArea = { x: PADDING, y: PADDING, width: CANVAS - 2 * PADDING, height: CANVAS - 2 * PADDING };

  if (!title.showTitle || !title.titleText) return fullArea;

  const fontSize = title.fontSize * 2;
  const lines = title.titleText.split("\n");
  const lineHeight = fontSize * 1.2;

  // Compute the "bottom" case height as the reference — used for both top and bottom
  // so the graphic is the same size AND position regardless of title placement.
  // The graphic stays put; only the title moves between top and bottom.
  const bottomPositions = calculateYPositions(lines.length, fontSize, lineHeight, "bottom", 0);
  const bottomTitleTop = bottomPositions[0] - fontSize / 2;
  const sharedHeight = Math.max(0, bottomTitleTop - PADDING - PADDING);

  switch (title.position) {
    case "bottom":
      return { x: PADDING, y: PADDING, width: CANVAS - 2 * PADDING, height: sharedHeight };
    case "top":
      // Mirror the bottom case: graphic in the lower portion, symmetric distance from edge
      return { x: PADDING, y: CANVAS - PADDING - sharedHeight, width: CANVAS - 2 * PADDING, height: sharedHeight };
    case "middle":
    case "custom":
      // Graphic goes behind text — no auto-scaling
      return fullArea;
  }
}

// ---------------------------------------------------------------------------
// Graphic Transform
// ---------------------------------------------------------------------------

/**
 * Wraps graphic content in a `<g transform>` to center and scale it
 * within the available area based on its source coordinate-space bounds.
 *
 * For static icons, callers typically pass `{x: 0, y: 0, width: viewBoxW, height: viewBoxH}`
 * derived from the SVG's viewBox (since trimmed icons place artwork at origin filling the viewBox).
 * For inline-assembled artwork (car-control, pit-crew) callers pass bounds matching the
 * coordinate space their content occupies.
 */
export function applyGraphicTransform(
  content: string,
  artworkBounds: SvgViewBox,
  availableArea: GraphicArea,
  userScale: number,
): string {
  // Whichever dimension is larger must fit — the other scales proportionally
  const fitScale = Math.min(availableArea.width / artworkBounds.width, availableArea.height / artworkBounds.height);
  const BASE_SCALE = 0.9;
  const scale = fitScale * BASE_SCALE * (userScale / 100);

  const areaCenterX = availableArea.x + availableArea.width / 2;
  const areaCenterY = availableArea.y + availableArea.height / 2;
  const artCenterX = artworkBounds.x + artworkBounds.width / 2;
  const artCenterY = artworkBounds.y + artworkBounds.height / 2;

  const tx = areaCenterX - artCenterX * scale;
  const ty = areaCenterY - artCenterY * scale;

  // Round to 2 decimals for cleaner SVG output
  const txR = Math.round(tx * 100) / 100;
  const tyR = Math.round(ty * 100) / 100;
  const sR = Math.round(scale * 10000) / 10000;

  return `<g transform="translate(${txR}, ${tyR}) scale(${sR})">${content}</g>`;
}

// ---------------------------------------------------------------------------
// Icon Assembly
// ---------------------------------------------------------------------------

/**
 * Assembles a final icon data URI from a graphic SVG, resolved colors, and resolved settings.
 *
 * Steps:
 * 1. Extracts graphic artwork from the SVG (strips wrapper, background, labels)
 * 2. Colorizes the graphic with renderIconTemplate
 * 3. Optionally scales and positions the graphic based on artworkBounds and title state
 * 4. Generates title text with generateTitleText
 * 5. Generates optional border SVG
 * 6. Fills the base template (background + border + graphic + title)
 * 7. Converts to a data URI
 *
 * @param options.graphicSvg - Source SVG template with <desc> metadata
 * @param options.colors - Resolved color values for all slots
 * @param options.title - Fully resolved title settings
 * @param options.border - Fully resolved border settings
 * @param options.graphic - Fully resolved graphic settings (optional — omit for no scaling)
 * @param options.bindingMissing - When true, draw the centered binding-missing
 *   warning triangle over dimmed artwork (issue #612). Used for keybind modes
 *   that have neither a keyboard binding nor a SimHub role configured.
 * @returns SVG data URI string
 */
export function assembleIcon(options: {
  graphicSvg: string;
  colors: Record<string, string>;
  title: ResolvedTitleSettings;
  border: ResolvedBorderSettings;
  graphic?: ResolvedGraphicSettings;
  bindingMissing?: boolean;
}): string {
  const { graphicSvg, colors, title, border, graphic, bindingMissing } = options;

  const rawGraphic = extractGraphicContent(graphicSvg);
  let graphicContent = title.showGraphics ? renderIconTemplate(rawGraphic, colors) : "";

  // Trimmed icons place artwork at origin filling the viewBox, so the viewBox
  // dimensions ARE the artwork extent for scaling. Fail fast if the caller
  // requested scaling but the SVG is missing a parseable viewBox — silently
  // skipping would render raw 144-coord artwork at full size in the base
  // template, which is a user-visible bug rather than a no-op.
  if (graphicContent && graphic) {
    const viewBox = parseSvgViewBox(graphicSvg);

    if (!viewBox) {
      throw new Error("assembleIcon: graphic scaling requested but graphicSvg has no parseable viewBox");
    }

    const area = computeGraphicArea(title);

    graphicContent = applyGraphicTransform(
      graphicContent,
      { x: 0, y: 0, width: viewBox.width, height: viewBox.height },
      area,
      graphic.scale,
    );
  }

  // Binding-missing overlay: dim the artwork and draw the centered warning
  // triangle on top. Applied after scaling and regardless of showGraphics —
  // a missing required binding is a configuration error the user must see
  // even when artwork is hidden.
  if (bindingMissing) {
    graphicContent = applyBindingWarning(graphicContent);
  }

  const titleContent = title.showTitle
    ? generateTitleText({
        text: title.titleText,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor ?? "#ffffff",
      })
    : "";

  const borderSvg = generateBorderParts(border);
  const borderContent = borderSvg.defs + borderSvg.rects;

  const svg = renderIconTemplate(ICON_BASE_TEMPLATE, {
    backgroundColor: colors.backgroundColor ?? "#000000",
    borderContent,
    graphicContent,
    titleContent,
  });

  return svgToDataUri(svg);
}
