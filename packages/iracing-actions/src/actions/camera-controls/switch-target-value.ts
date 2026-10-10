/**
 * What the Switch by Car Number and Switch by Position keys draw in their
 * artwork (#1352): the configured car number (`42`) or position (`P3`), from
 * the key's own settings rather than from telemetry, so it shows out of a
 * session too.
 *
 * Pure and free of the action class, so the website's icon gallery fills its
 * sample keys through the same function the device does.
 */
import { escapeXml } from "@iracedeck/deck-core";

import { fitValueFontSize } from "../../shared/dial-fit.js";

/**
 * The frame each icon gives its value, in the icon's own viewBox units —
 * `packages/icons/camera-focus/switch-by-car-number.svg` and
 * `switch-by-position.svg`. `maxWidth` is the width a value may fill, `cap`
 * the font size a value that fits is drawn at, `centerY` the line the value is
 * centred on. The frame is fixed rather than following the text, so a row of
 * keys keeps one scale whatever each key is set to.
 */
const SWITCH_VALUE_FRAMES = {
  "switch-by-car-number": { maxWidth: 52, cap: 28, centerY: 23 },
  "switch-by-position": { maxWidth: 120, cap: 40, centerY: 15.5 },
} as const;

/** The two Camera Controls modes whose key draws its configured target. */
export type SwitchTarget = keyof typeof SWITCH_VALUE_FRAMES;

/**
 * Bold Arial / Arimo capitals and digits are 0.72 em tall, so a baseline
 * 0.36 em below a line centres them on it. Computed here because resvg ignores
 * `dominant-baseline` (`svg-platform-compatibility.md`).
 */
const BASELINE_OFFSET_EM = 0.36;

export interface SwitchTargetSettings {
  /** A digit string once #1353 keeps leading zeros; a number before it. */
  carNumber?: string | number;
  position?: number;
}

export function isSwitchTarget(target: string): target is SwitchTarget {
  return Object.hasOwn(SWITCH_VALUE_FRAMES, target);
}

/** The text a switch key draws: the stored car number as is, or `P<position>`. */
export function switchTargetText(target: SwitchTarget, settings: SwitchTargetSettings): string {
  return target === "switch-by-car-number" ? String(settings.carNumber ?? 0) : `P${settings.position ?? 1}`;
}

/**
 * The `templateValues` for `assembleIcon()`: the value, a font size fitted to
 * the icon's frame (a value too long for it shrinks instead of overflowing)
 * and the baseline that centres that size. `undefined` for every other mode.
 */
export function switchTargetTemplateValues(
  target: string,
  settings: SwitchTargetSettings,
): Record<string, string> | undefined {
  if (!isSwitchTarget(target)) return undefined;

  const frame = SWITCH_VALUE_FRAMES[target];
  const text = switchTargetText(target, settings);
  const fontSize = fitValueFontSize(text, frame.maxWidth, frame.cap);
  const baseline = Math.round((frame.centerY + BASELINE_OFFSET_EM * fontSize) * 100) / 100;

  return { value: escapeXml(text), valueFontSize: String(fontSize), valueY: String(baseline) };
}
