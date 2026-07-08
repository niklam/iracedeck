/**
 * Paired adjust key styles (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md).
 *
 * Lets two keys (both showing the live value) or three keys (View key in the
 * middle) form one increase/decrease control. This module owns the style
 * catalog, the shared Zod settings fields, fresh-key seeding, value-source
 * gating (via the VIEW_DEFS registry), unit-less value formatting, and (from
 * Tasks 2–3) the SVG renderer. Actions stay thin: they spread
 * `adjustStyleSettingsFields`, call `seedFreshKeyStyle` on first appear, route
 * rendering through `renderPairedIconOrNull`, and gate their telemetry
 * subscription with `pairedKeyNeedsTelemetry` / `telemetryMemoValue`.
 */
import {
  applyBindingWarning,
  type BorderOverrides,
  type ColorSlots,
  escapeXml,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  type TitleOverrides,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import adjustStyleTemplate from "../../icons/adjust-style.svg";
import { formatViewValue, isViewSetting, VIEW_DEFS, type ViewSettingId } from "./setup-view.js";

/** Every selectable key style. Which subset applies depends on the mode kind (adjust vs View). */
export const ADJUST_KEY_STYLES = [
  "legacy",
  // Value-showing directional styles (2-key pairs).
  "corner-badge",
  "edge-chevrons",
  "split",
  "ghost",
  "joined-pill",
  // No-value directional styles (3-key group outer keys; also fine standalone).
  "big-glyph",
  "big-chevron",
  "pill-end",
  // View-key display styles (3-key group middle).
  "pill-middle-horizontal",
  "pill-middle-vertical",
] as const;

export type AdjustKeyStyle = (typeof ADJUST_KEY_STYLES)[number];

export const PAIR_POSITIONS = ["auto", "left", "right", "top", "bottom"] as const;
export type PairPosition = (typeof PAIR_POSITIONS)[number];

/**
 * Shared settings fields — spread into each action's `CommonSettings.extend`.
 * `.catch` (not just `.default`) so a value persisted by a newer plugin
 * version degrades to the default instead of failing the whole settings parse
 * (which would reset the key to full defaults — the 2.0 contamination bug).
 */
export const adjustStyleSettingsFields = {
  keyStyle: z.enum(ADJUST_KEY_STYLES).default("legacy").catch("legacy"),
  pairPosition: z.enum(PAIR_POSITIONS).default("auto").catch("auto"),
};

/** Gap between repeat steps while a paired key is held (≈ 6–7 steps/sec). */
export const ADJUST_REPEAT_INTERVAL_MS = 150;
/** Safety cap for a held paired key — catches dropped keyUp events. */
export const ADJUST_REPEAT_SAFETY_MS = 15_000;

/**
 * One-shot default seeding: a key that appears with NO persisted settings at
 * all is a fresh placement and gets the modern default (`split`); any
 * persisted field means the key predates this feature (or was configured) and
 * stays on the schema default `legacy`. Note: a pre-existing key whose PI was
 * never opened also has empty settings and therefore also seeds to `split` —
 * accepted in the design (its user accepted defaults; the default changed).
 */
export function seedFreshKeyStyle(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) return null;

  const obj = (raw ?? {}) as Record<string, unknown>;

  if (Object.keys(obj).length > 0) return null;

  return { keyStyle: "split" };
}

/**
 * Unit-less display value: strips a trailing "%" (the only unit VIEW_DEFS
 * formatters emit), keeps signs and decimals. "Everyone knows the unit, so
 * bigger value is more important."
 */
export function stripUnit(value: string): string {
  return value.endsWith("%") ? value.slice(0, -1) : value;
}

/** Inverse of the VIEW_DEFS adjustmentMode mapping: adjust-mode id → View id. */
const ADJUSTMENT_TO_VIEW: ReadonlyMap<string, ViewSettingId> = new Map(
  (Object.keys(VIEW_DEFS) as ViewSettingId[]).map((viewId) => [VIEW_DEFS[viewId].adjustmentMode, viewId]),
);

export function getViewIdForAdjustment(adjustmentMode: string): ViewSettingId | undefined {
  return ADJUSTMENT_TO_VIEW.get(adjustmentMode);
}

/**
 * A mode can use paired styles only when a live value exists for it: either it
 * IS a View id, or it's an adjust mode with a matching View def. Directional
 * modes without telemetry (qualifying-tape, boost-level, springs/shocks) stay
 * legacy-only by design.
 */
export function hasPairedValueSource(setting: string): boolean {
  return isViewSetting(setting) || ADJUSTMENT_TO_VIEW.has(setting);
}

const VALUE_SHOWING_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "corner-badge",
  "edge-chevrons",
  "split",
  "ghost",
  "joined-pill",
  "pill-middle-horizontal",
  "pill-middle-vertical",
]);

export function styleShowsValue(style: AdjustKeyStyle): boolean {
  return VALUE_SHOWING_STYLES.has(style);
}

const PILL_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "joined-pill",
  "pill-end",
  "pill-middle-horizontal",
  "pill-middle-vertical",
]);

/** Pill styles suppress the normal border (locked off) — the pill IS the border. */
export function isPillStyle(style: AdjustKeyStyle): boolean {
  return PILL_STYLES.has(style);
}

const POSITION_AWARE_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "edge-chevrons",
  "joined-pill",
  "pill-end",
  "big-chevron",
]);

/** Styles whose artwork depends on where the partner key sits (PI shows Position in Pair). */
export function isPositionAwareStyle(style: AdjustKeyStyle): boolean {
  return POSITION_AWARE_STYLES.has(style);
}

export function isPillMiddleStyle(style: AdjustKeyStyle): boolean {
  return style === "pill-middle-horizontal" || style === "pill-middle-vertical";
}

/** `auto` = the common horizontal layout: increase on the right, decrease on the left. */
export function resolvePairPosition(
  position: PairPosition,
  direction: "increase" | "decrease",
): "left" | "right" | "top" | "bottom" {
  if (position !== "auto") return position;

  return direction === "increase" ? "right" : "left";
}

/** True when this key's icon must re-render on telemetry ticks beyond the View case. */
export function pairedKeyNeedsTelemetry(s: { setting: string; keyStyle: AdjustKeyStyle }): boolean {
  return (
    !isViewSetting(s.setting) &&
    s.keyStyle !== "legacy" &&
    styleShowsValue(s.keyStyle) &&
    hasPairedValueSource(s.setting)
  );
}

/**
 * The string to memoize icon re-renders on, or null when the key's icon does
 * not depend on telemetry. Views memoize the same formatted value they always
 * have; paired adjust keys memoize the SOURCE value (with unit) — stripping is
 * monotonic, so change detection is identical.
 */
export function telemetryMemoValue(
  s: { setting: string; keyStyle: AdjustKeyStyle },
  telemetry: TelemetryData | null,
): string | null {
  if (isViewSetting(s.setting)) return formatViewValue(s.setting, telemetry);

  if (pairedKeyNeedsTelemetry(s)) {
    const viewId = getViewIdForAdjustment(s.setting);

    return viewId ? formatViewValue(viewId, telemetry) : null;
  }

  return null;
}

export interface AdjustStyleRenderInputs {
  readonly style: Exclude<AdjustKeyStyle, "legacy">;
  readonly direction: "increase" | "decrease";
  readonly pairPosition: PairPosition;
  /** Already formatted + unit-stripped; null renders the "---" placeholder. */
  readonly value: string | null;
  /** Default label text, e.g. "BRAKE BIAS" (from VIEW_DEFS[...].label). */
  readonly label: string;
  /** Bump value font size for short integer readouts (from VIEW_DEFS valueFontSize ≥ 40). */
  readonly shortValue?: boolean;
  /** Representative static icon of the owning action — supplies background/text palette. */
  readonly colorSourceSvg?: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  readonly bindingMissing?: boolean;
}

/** Placeholder when no telemetry value is available (same string as View keys). */
const NULL_VALUE = "---";

/**
 * Per-style default-title sources. resolveTitleSettings reads title metadata
 * from an SVG string's <desc>; these tiny synthetic sources let each style set
 * its own defaults (and lock the fields that would break the layout) without a
 * file per style. Locked fields skip the GLOBAL title defaults only — a
 * per-key title override always wins (#755 semantics).
 */
const TITLE_SOURCE_BOTTOM = `<svg><desc>{"colors":{}}</desc></svg>`;
const TITLE_SOURCE_TOP = `<svg><desc>{"colors":{},"title":{"position":"top","locked":["position"]}}</desc></svg>`;
const TITLE_SOURCE_HIDDEN = `<svg><desc>{"colors":{},"title":{"showTitle":false,"locked":["showTitle"]}}</desc></svg>`;

/** Pill styles: the pill IS the border — normal border locked off (per-key override still wins). */
const PILL_BORDER_SOURCE = `<svg><desc>{"colors":{},"border":{"enabled":false,"glowEnabled":false,"locked":["enabled","glowEnabled"]}}</desc></svg>`;

const GLYPH: Record<"increase" | "decrease", string> = { increase: "+", decrease: "−" };

/**
 * Converts a visual-center y to a text baseline y. Qt's SVG renderer (Stream
 * Deck / Mirabox / Ulanzi hosts) ignores `dominant-baseline`, so centering is
 * done by shifting the baseline down by half the cap height of Arial-bold
 * digits (~0.72em tall → 0.36em).
 */
const TEXT_CENTER_BASELINE_FACTOR = 0.36;

function valueText(value: string | null, x: number, y: number, size: number, fill: string): string {
  return `<text x="${x}" y="${y + Math.round(size * TEXT_CENTER_BASELINE_FACTOR)}" text-anchor="middle" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${value ?? NULL_VALUE}</text>`;
}

function glyphText(direction: "increase" | "decrease", x: number, y: number, size: number, fill: string): string {
  return `<text x="${x}" y="${y + Math.round(size * TEXT_CENTER_BASELINE_FACTOR)}" text-anchor="middle" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${GLYPH[direction]}</text>`;
}

/** Double chevron: `primary` is the outermost/leading chevron, the second is drawn at 45% opacity. */
function chevrons(primary: string, secondary: string, stroke: string, width: number): string {
  return (
    `<polyline points="${secondary}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>` +
    `<polyline points="${primary}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

/**
 * Pill frame path open toward the joined edge (the side opposite `position`),
 * rounded on the closed corners. `yTop`/`yBot` bound the closed span: for
 * `left`/`right` frames that span is the Y axis (the frame's height, open on
 * the X axis out to 0/144); for `top`/`bottom` frames the same two numbers
 * bound the X axis instead (the frame's width, open on the Y axis out to
 * 0/144) — callers pass the fixed 14/130 margins for those two positions,
 * matching the original hardcoded `d` strings exactly.
 */
function pillFramePath(position: "left" | "right" | "top" | "bottom", yTop: number, yBot: number): string {
  const near = yTop + 20;
  const far = yBot - 20;

  switch (position) {
    case "left":
      return `M144 ${yTop} H34 Q14 ${yTop} 14 ${near} V${far} Q14 ${yBot} 34 ${yBot} H144`;
    case "right":
      return `M0 ${yTop} H110 Q130 ${yTop} 130 ${near} V${far} Q130 ${yBot} 110 ${yBot} H0`;
    case "top":
      return `M${yTop} 144 V${near} Q${yTop} 14 ${near} 14 H${far} Q${yBot} 14 ${yBot} ${near} V144`;
    case "bottom":
      return `M${yTop} 0 V${far} Q${yTop} 130 ${near} 130 H${far} Q${yBot} 130 ${yBot} ${far} V0`;
  }
}

export function renderAdjustStyleSvg(inputs: AdjustStyleRenderInputs): string {
  const { style, direction } = inputs;
  const position = resolvePairPosition(inputs.pairPosition, direction);

  // Background/text palette from the owning action's representative icon; the
  // ACCENT (graphic1Color) resolves against this template's own desc so its
  // default is the chevron yellow #f1c40f (the action icons declare a locked
  // white graphic1Color that must not leak into the accent).
  const styleSource = inputs.colorSourceSvg ?? adjustStyleTemplate;
  const colors = resolveIconColors(styleSource, getGlobalColors(), inputs.colorOverrides);
  const accent = resolveIconColors(adjustStyleTemplate, getGlobalColors(), inputs.colorOverrides).graphic1Color;

  const titleSource =
    style === "split"
      ? TITLE_SOURCE_TOP
      : style === "big-glyph" || style === "big-chevron" || style === "pill-end"
        ? TITLE_SOURCE_HIDDEN
        : style === "edge-chevrons" && position === "bottom"
          ? TITLE_SOURCE_TOP
          : TITLE_SOURCE_BOTTOM;
  const title = resolveTitleSettings(titleSource, getGlobalTitleSettings(), inputs.titleOverrides, inputs.label);
  const titleContent = title.showTitle
    ? generateTitleText({
        text: title.titleText,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor,
      })
    : "";

  // Pill-middle labels live INSIDE the pill at a fixed spot; suppress the
  // standard positioned title and draw the label directly (text/bold/size/show
  // overrides still apply; position/customPosition are style-fixed).
  const pillMiddleLabel =
    isPillMiddleStyle(style) && title.showTitle
      ? `<text x="72" y="${style === "pill-middle-horizontal" ? 108 : 102}" text-anchor="middle" fill="${colors.textColor}" font-family="Arial, sans-serif" font-size="14" font-weight="${title.bold ? "bold" : "normal"}">${escapeXml(title.titleText)}</text>`
      : "";

  const borderSource = isPillStyle(style) ? PILL_BORDER_SOURCE : styleSource;
  const border = resolveBorderSettings(borderSource, getGlobalBorderSettings(), inputs.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const bump = inputs.shortValue ? 8 : 0;
  const art = buildStyleArt(inputs, position, colors.textColor, accent, bump, title.showTitle);

  const inner = inputs.bindingMissing ? applyBindingWarning(art) : art;

  const svg = renderIconTemplate(adjustStyleTemplate, {
    backgroundColor: colors.backgroundColor,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    content: inner + (isPillMiddleStyle(style) ? pillMiddleLabel : titleContent),
  });

  return svgToDataUri(svg);
}

/** Per-style artwork (value + direction accent), title excluded (rendered by the caller). */
function buildStyleArt(
  inputs: AdjustStyleRenderInputs,
  position: "left" | "right" | "top" | "bottom",
  textColor: string,
  accent: string,
  bump: number,
  labelShown: boolean,
): string {
  const { style, direction, value } = inputs;

  switch (style) {
    case "corner-badge":
      return (
        valueText(value, 72, 79, 44 + bump, textColor) +
        `<circle cx="119" cy="25" r="15" fill="${accent}"/>` +
        glyphText(direction, 119, 26, 26, "#2a2a2a")
      );

    case "split":
      return valueText(value, 72, 56, 38 + bump, textColor) + glyphText(direction, 72, 104, 62, accent);

    case "ghost":
      return (
        `<g opacity="0.2">${glyphText(direction, 72, 70, 130, accent)}</g>` +
        valueText(value, 72, 72, 44 + bump, textColor)
      );

    case "edge-chevrons": {
      // Chevrons sit on the `position` edge and point in the TRUE direction of
      // change: horizontal pairs point right for increase / left for decrease;
      // vertical pairs point up for increase / down for decrease.
      const horizontal = position === "left" || position === "right";

      if (horizontal) {
        // Point direction: increase → right, decrease → left. Edge: `position`.
        const pointsRight = direction === "increase";
        const onLeftEdge = position === "left";
        const art = pointsRight
          ? onLeftEdge
            ? chevrons("14,52 30,72 14,92", "30,52 46,72 30,92", accent, 7)
            : chevrons("114,52 130,72 114,92", "98,52 114,72 98,92", accent, 7)
          : onLeftEdge
            ? chevrons("30,52 14,72 30,92", "46,52 30,72 46,92", accent, 7)
            : chevrons("130,52 114,72 130,92", "114,52 98,72 114,92", accent, 7);
        const valueX = onLeftEdge ? 88 : 56;

        return art + valueText(value, valueX, 74, 38 + bump, textColor);
      }

      const onTopEdge = position === "top";
      const pointsUp = direction === "increase";
      const art = onTopEdge
        ? pointsUp
          ? chevrons("52,30 72,14 92,30", "52,46 72,30 92,46", accent, 7)
          : chevrons("52,14 72,30 92,14", "52,30 72,46 92,30", accent, 7)
        : pointsUp
          ? chevrons("52,130 72,114 92,130", "52,114 72,98 92,114", accent, 7)
          : chevrons("52,114 72,130 92,114", "52,98 72,114 92,98", accent, 7);
      const valueY = onTopEdge ? 84 : labelShown ? 62 : 60;

      return art + valueText(value, 72, valueY, 38 + bump, textColor);
    }

    case "big-glyph":
      return glyphText(direction, 72, 72, 96, accent);

    case "big-chevron": {
      const horizontal = position === "left" || position === "right";

      if (horizontal) {
        return direction === "increase"
          ? chevrons("68,36 104,72 68,108", "32,36 68,72 32,108", accent, 10)
          : chevrons("76,36 40,72 76,108", "112,36 76,72 112,108", accent, 10);
      }

      return direction === "increase"
        ? chevrons("36,76 72,40 108,76", "36,112 72,76 108,112", accent, 10)
        : chevrons("36,68 72,104 108,68", "36,32 72,68 108,32", accent, 10);
    }

    case "joined-pill": {
      // Frame open toward the partner (the JOINED edge is the opposite of `position`).
      // With a visible bottom label (horizontal pair) the frame shortens to y 14..108;
      // without one it uses the equal-margin frame y 14..130.
      const yBot = labelShown && (position === "left" || position === "right") ? 108 : 130;
      const framePath = `<path d="${pillFramePath(position, 14, yBot)}" fill="none" stroke="${accent}" stroke-width="5"/>`;

      switch (position) {
        case "left":
          return (
            framePath +
            glyphText(direction, 38, (14 + yBot) / 2, 38, accent) +
            valueText(value, 92, (14 + yBot) / 2, 34 + bump, textColor)
          );
        case "right":
          return (
            framePath +
            valueText(value, 52, (14 + yBot) / 2, 34 + bump, textColor) +
            glyphText(direction, 106, (14 + yBot) / 2, 38, accent)
          );
        case "top":
          return framePath + glyphText(direction, 72, 46, 38, accent) + valueText(value, 72, 88, 34 + bump, textColor);
        case "bottom":
          return framePath + valueText(value, 72, 58, 34 + bump, textColor) + glyphText(direction, 72, 100, 38, accent);
      }

      break;
    }

    case "pill-end": {
      const framePath = `<path d="${pillFramePath(position, 14, 130)}" fill="none" stroke="${accent}" stroke-width="5"/>`;

      switch (position) {
        case "left":
        case "right":
          return framePath + glyphText(direction, 72, 72, 52, accent);
        case "top":
          return framePath + glyphText(direction, 72, 80, 52, accent);
        case "bottom":
          return framePath + glyphText(direction, 72, 64, 52, accent);
      }

      break;
    }

    case "pill-middle-horizontal":
      return (
        `<path d="M0 14 H144 M0 130 H144" fill="none" stroke="${accent}" stroke-width="5"/>` +
        valueText(value, 72, 62, 42 + bump, textColor)
      );

    case "pill-middle-vertical":
      return (
        `<path d="M14 0 V144 M130 0 V144" fill="none" stroke="${accent}" stroke-width="5"/>` +
        valueText(value, 72, 58, 38 + bump, textColor)
      );
  }

  return valueText(inputs.value, 72, 72, 44, textColor); // unreachable — every style case returns above
}

export interface PairedIconOptions {
  readonly setting: string; // current mode id (adjust mode or View id)
  readonly direction: "increase" | "decrease";
  readonly keyStyle: AdjustKeyStyle;
  readonly pairPosition: PairPosition;
  readonly telemetry: TelemetryData | null;
  readonly colorSourceSvg: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  readonly bindingMissing?: boolean;
}

/**
 * The single per-action entry point: returns the styled paired icon, or null
 * when the key must fall back to its existing (legacy / View) render path.
 * Applies all gating: legacy style, valueless modes, and View modes with a
 * non-pill-middle style all return null.
 */
export function renderPairedIconOrNull(opts: PairedIconOptions): string | null {
  const { setting, keyStyle } = opts;

  if (keyStyle === "legacy") return null;

  if (isViewSetting(setting)) {
    if (!isPillMiddleStyle(keyStyle)) return null;

    const def = VIEW_DEFS[setting];

    return renderAdjustStyleSvg({
      style: keyStyle,
      direction: opts.direction,
      pairPosition: opts.pairPosition,
      value: stripUnit(formatViewValue(setting, opts.telemetry)),
      label: def.label,
      shortValue: (def.valueFontSize ?? 36) >= 40,
      colorSourceSvg: opts.colorSourceSvg,
      colorOverrides: opts.colorOverrides,
      titleOverrides: opts.titleOverrides,
      borderOverrides: opts.borderOverrides,
      bindingMissing: opts.bindingMissing,
    });
  }

  const viewId = getViewIdForAdjustment(setting);

  if (!viewId) return null;

  if (isPillMiddleStyle(keyStyle)) return null; // middle segments are View-key styles

  const def = VIEW_DEFS[viewId];

  return renderAdjustStyleSvg({
    style: keyStyle,
    direction: opts.direction,
    pairPosition: opts.pairPosition,
    value: styleShowsValue(keyStyle) ? stripUnit(formatViewValue(viewId, opts.telemetry)) : null,
    label: def.label,
    shortValue: (def.valueFontSize ?? 36) >= 40,
    colorSourceSvg: opts.colorSourceSvg,
    colorOverrides: opts.colorOverrides,
    titleOverrides: opts.titleOverrides,
    borderOverrides: opts.borderOverrides,
    bindingMissing: opts.bindingMissing,
  });
}
