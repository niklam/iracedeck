/**
 * Paired +/− key styles on the volume keys (#1453; spec:
 * docs/superpowers/specs/2026-10-18-issue-1453-volume-key-styles.md).
 *
 * The style catalog, settings fields, fresh-key seed, renderer and repeat
 * constants stay in `adjust-styles.ts`; its value lookup is tied to the setup
 * actions' telemetry registry, so the volume keys come through here instead.
 * Each action maps its own settings to a {@link VolumeKeyDescription}:
 * Audio Controls from `{category, action}`, AI Spotter Controls from
 * `louder` / `quieter`. This module imports from neither action folder — a
 * level-showing key hands its level reader in.
 */
import type { BorderOverrides, ColorSlots, TitleOverrides } from "@iracedeck/deck-core";

import {
  type AdjustKeyStyle,
  isPillMiddleStyle,
  noValueFormOf,
  type PairPosition,
  renderAdjustStyleSvg,
  styleShowsValue,
} from "./adjust-styles.js";

/** A level-showing volume's state: the 0–100 level and whether its feature is switched on. */
export interface VolumeLevel {
  readonly level: number;
  readonly enabled: boolean;
}

/** What a volume key is, as far as its paired style is concerned. */
export interface VolumeKeyDescription {
  /** One-word label (MASTER, VOICE, SPOTTER, ENGINEER, RADAR) — the glyph gives the direction. */
  readonly label: string;
  readonly direction: "increase" | "decrease";
  /**
   * Reads the level this key shows (iRaceDeck's own volumes). Absent for
   * iRacing's volumes, which iRacing does not report: those keys draw a value
   * style in its no-value form.
   */
  readonly readLevel?: () => VolumeLevel;
}

/** A style a volume key can draw: every pair style but Legacy and the View-key (pill middle) styles. */
export type VolumePairStyle = Exclude<AdjustKeyStyle, "legacy" | "pill-middle-horizontal" | "pill-middle-vertical">;

const PAIR_STYLES: ReadonlySet<string> = new Set<VolumePairStyle>([
  "split",
  "edge-chevrons",
  "joined-pill",
  "big-glyph",
  "big-chevron",
  "pill-end",
]);

/**
 * The style a volume key draws, or null for its existing (legacy) icon. Null
 * for Legacy, and for anything that is not a volume pair style — a View-key
 * style or a missing value — which the key treats as Legacy, as #810's modes
 * do. On a key with no level a value style becomes its no-value form; the
 * stored value is left as it is.
 */
export function resolveVolumeKeyStyle(stored: AdjustKeyStyle | undefined, hasLevel: boolean): VolumePairStyle | null {
  if (stored === undefined || !PAIR_STYLES.has(stored)) return null;

  const style = hasLevel ? stored : noValueFormOf(stored);

  // noValueFormOf never yields a pill-middle style from a pair style; the guard keeps the type honest.
  return isPillMiddleStyle(style) || style === "legacy" ? null : (style as VolumePairStyle);
}

/** Whether a key in this stored style steps repeatedly while held: every volume pair style, never Legacy. */
export function volumeKeyRepeats(stored: AdjustKeyStyle | undefined): boolean {
  return resolveVolumeKeyStyle(stored, true) !== null;
}

/** The shown level text: the integer level without a unit (`"55"`), or `"OFF"` while the feature is switched off. */
export function volumeLevelText(state: VolumeLevel): string {
  return state.enabled ? String(Math.round(state.level)) : "OFF";
}

export interface VolumeKeyIconOptions {
  readonly description: VolumeKeyDescription;
  readonly keyStyle: AdjustKeyStyle | undefined;
  readonly pairPosition: PairPosition;
  /** The action's own icon for this key — supplies the background and text palette. */
  readonly colorSourceSvg: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  /** The #612 missing-binding overlay (iRacing volumes only; iRaceDeck's own need no binding). */
  readonly bindingMissing?: boolean;
}

/**
 * The volume key's styled icon, or null when it draws its existing icon
 * (Legacy, or a style a volume key does not offer) — the caller then falls
 * back to its own renderer, as the setup actions do with
 * `renderPairedIconOrNull`.
 */
export function renderVolumeKeyIconOrNull(opts: VolumeKeyIconOptions): string | null {
  const { description } = opts;
  const style = resolveVolumeKeyStyle(opts.keyStyle, description.readLevel !== undefined);

  if (style === null) return null;

  const value = styleShowsValue(style) && description.readLevel ? volumeLevelText(description.readLevel()) : null;

  return renderAdjustStyleSvg({
    style,
    direction: description.direction,
    pairPosition: opts.pairPosition,
    value,
    label: description.label,
    labelOnNoValueStyles: true,
    colorSourceSvg: opts.colorSourceSvg,
    colorOverrides: opts.colorOverrides,
    titleOverrides: opts.titleOverrides,
    borderOverrides: opts.borderOverrides,
    bindingMissing: opts.bindingMissing,
  });
}
