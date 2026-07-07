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
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

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
