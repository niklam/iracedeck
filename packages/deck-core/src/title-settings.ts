import type { GlobalBorderSettings, GlobalGraphicSettings, GlobalTitleSettings } from "@iracedeck/icon-composer";

import { getGlobalSettings } from "./global-settings.js";

/**
 * Title, Border, and Graphic Settings — deck-core layer
 *
 * This file provides the global settings readers that connect to the
 * plugin settings store. All pure assembly and resolution functions
 * have been moved to @iracedeck/icon-composer.
 */

// Re-export everything from icon-composer for backward compatibility
export {
  applyGraphicTransform,
  assembleIcon,
  BORDER_DEFAULTS,
  calculateYPositions,
  computeGraphicArea,
  generateTitleText,
  GRAPHIC_DEFAULTS,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveTitleSettings,
  TITLE_DEFAULTS,
  type BorderOverrides,
  type GenerateTitleTextOptions,
  type GlobalBorderSettings,
  type GlobalGraphicSettings,
  type GraphicArea,
  type GraphicOverrides,
  type ResolvedBorderSettings,
  type ResolvedGraphicSettings,
  type ResolvedTitleSettings,
  type GlobalTitleSettings,
  type TitleOverrides,
} from "@iracedeck/icon-composer";

// Binding-missing warning overlay (issue #612)
export {
  applyBindingWarning,
  BINDING_WARNING_DIM_OPACITY,
  BINDING_WARNING_GLYPH,
  bindingWarningSvg,
  dimForBindingWarning,
} from "@iracedeck/icon-composer";

// ---------------------------------------------------------------------------
// Global Title Settings Reader
// ---------------------------------------------------------------------------

/**
 * Reads plugin-level global title settings from the global settings store.
 * Keys are flat with a `title` prefix (e.g., `titleFontSize`, `titleBold`).
 */
export function getGlobalTitleSettings(): GlobalTitleSettings {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const result: GlobalTitleSettings = {};

  const bool = (key: string): boolean | undefined => {
    const val = settings[key];

    if (val === true || val === "true") return true;

    if (val === false || val === "false") return false;

    return undefined;
  };

  const num = (key: string): number | undefined => {
    const val = settings[key];

    if (typeof val === "number") return val;

    if (typeof val === "string" && val.length > 0) {
      const n = Number(val);

      return Number.isFinite(n) ? n : undefined;
    }

    return undefined;
  };

  const str = (key: string): string | undefined => {
    const val = settings[key];

    return typeof val === "string" && val.length > 0 ? val : undefined;
  };

  const showTitle = bool("titleShowTitle");

  if (showTitle !== undefined) result.showTitle = showTitle;

  const showGraphics = bool("titleShowGraphics");

  if (showGraphics !== undefined) result.showGraphics = showGraphics;

  // Bold: supports "default" to defer to icon defaults
  const boldVal = settings["titleBold"];

  if (boldVal === "default") {
    result.bold = "default";
  } else {
    const bold = bool("titleBold");

    if (bold !== undefined) result.bold = bold;
  }

  // Font size: "default" checkbox means defer to icon defaults
  const fontSizeDefault = bool("titleFontSizeDefault");

  if (fontSizeDefault) {
    result.fontSize = "default";
  } else {
    const fontSize = num("titleFontSize");

    if (fontSize !== undefined) result.fontSize = fontSize;
  }

  // Position: supports "default" to defer to icon defaults
  const position = str("titlePosition") as GlobalTitleSettings["position"];

  if (position !== undefined) result.position = position;

  // Custom position: follows position — "default" when position is "default"
  if (position === "default") {
    result.customPosition = "default";
  } else {
    const customPosition = num("titleCustomPosition");

    if (customPosition !== undefined) result.customPosition = customPosition;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Global Border Settings Reader
// ---------------------------------------------------------------------------

/**
 * Reads plugin-level global border settings from the global settings store.
 * Keys are flat with a `border` prefix (e.g., `borderEnabled`, `borderWidth`).
 */
export function getGlobalBorderSettings(): GlobalBorderSettings {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const result: GlobalBorderSettings = {};

  const bool = (key: string): boolean | undefined => {
    const val = settings[key];

    if (val === true || val === "true") return true;

    if (val === false || val === "false") return false;

    return undefined;
  };

  const num = (key: string): number | undefined => {
    const val = settings[key];

    if (typeof val === "number") return val;

    if (typeof val === "string" && val.length > 0) {
      const n = Number(val);

      return Number.isFinite(n) ? n : undefined;
    }

    return undefined;
  };

  const str = (key: string): string | undefined => {
    const val = settings[key];

    // #000001 is the legacy "not set" sentinel from <sdpi-color> era — kept for backward compat
    return typeof val === "string" && val.length > 0 && val !== "#000001" ? val : undefined;
  };

  // Enabled: supports "default" to defer to icon defaults
  const enabledVal = settings["borderEnabled"];

  if (enabledVal === "default") {
    result.enabled = "default";
  } else {
    const enabled = bool("borderEnabled");

    if (enabled !== undefined) result.enabled = enabled;
  }

  const borderWidth = num("borderWidth");

  if (borderWidth !== undefined) result.borderWidth = borderWidth;

  const borderColor = str("borderColor");

  if (borderColor !== undefined) result.borderColor = borderColor;

  // Glow enabled: supports "default"
  const glowEnabledVal = settings["borderGlowEnabled"];

  if (glowEnabledVal === "default") {
    result.glowEnabled = "default";
  } else {
    const glowEnabled = bool("borderGlowEnabled");

    if (glowEnabled !== undefined) result.glowEnabled = glowEnabled;
  }

  const glowWidth = num("borderGlowWidth");

  if (glowWidth !== undefined) result.glowWidth = glowWidth;

  return result;
}

// ---------------------------------------------------------------------------
// Global Graphic Settings Reader
// ---------------------------------------------------------------------------

/**
 * Reads plugin-level global graphic settings from the global settings store.
 * Key: `graphicScale` (flat, no prefix).
 */
export function getGlobalGraphicSettings(): GlobalGraphicSettings {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const result: GlobalGraphicSettings = {};

  const val = settings["graphicScale"];

  if (typeof val === "number") {
    result.scale = val;
  } else if (typeof val === "string" && val.length > 0) {
    const n = Number(val);

    if (Number.isFinite(n)) result.scale = n;
  }

  return result;
}
