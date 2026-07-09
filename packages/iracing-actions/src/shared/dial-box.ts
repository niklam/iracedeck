/**
 * The shared Stream Deck+ dial "dash box" — the 200×100 touch-strip pixmap the
 * seven Setup dial surfaces (Brakes, Traction, Fuel, Engine, Aero, Chassis,
 * Hybrid) draw for their encoder slot. Each action was carrying its own copy of
 * this renderer (issue #817); this module is the single source (issue #811),
 * and adds user-adjustable colors + an optional border glow.
 *
 * The box is a rounded panel floating on the black device screen: the
 * background color fills the area INSIDE the border frame (the outer margin
 * stays transparent → device black), the border strokes that panel, an optional
 * blurred glow sits behind it, and the abbreviation label + live value sit on
 * top. Actions resolve their per-setting accent + any user overrides via
 * `resolveDialBoxColors`, spread `dialAppearanceFields` into their dial settings
 * schema, and route rendering through `renderDialBox`.
 */
import { applyBindingWarning } from "@iracedeck/deck-core";
import { z } from "zod";

/** Default panel background — near-black, ≈ the device screen, so the default look is unchanged. */
export const DIAL_BOX_BACKGROUND = "#0d0d0d";

/** Glow tunables (mirroring the key-icon border glow in `icon-composer`). */
const DIAL_GLOW_STD_DEV = 6;
const DIAL_GLOW_OPACITY = 0.4;
export const DIAL_GLOW_WIDTH_DEFAULT = 12;
export const DIAL_GLOW_WIDTH_MAX = 30;

/** The default identity-only (valueless) label scale, as a fraction of the box's shorter side. */
const DEFAULT_IDENTITY_LABEL_SCALE = 0.24;

/**
 * User color overrides for the dash box; an empty/absent slot inherits the
 * default. Keyed with the `*Color` suffix so the `ird-color-picker` PI control
 * infers a slot type and shows its Not-set / Black / White / recent swatches.
 */
export interface DialBoxColorOverrides {
  borderColor?: string;
  labelColor?: string;
  valueColor?: string;
  backgroundColor?: string;
}

/** Fully resolved dash-box colors (every slot concrete). */
export interface DialBoxColors {
  border: string;
  label: string;
  value: string;
  background: string;
}

/** Border-glow settings for the dash box. */
export interface DialBoxGlow {
  enabled: boolean;
  width: number;
}

/** An override string counts as "set" only when it is a non-empty string. */
function overrideOr(override: string | undefined, fallback: string): string {
  return typeof override === "string" && override !== "" ? override : fallback;
}

/**
 * Resolves the dash box's four colors from the user overrides and the setting's
 * accent. Border / label / value fall back to the accent; background falls back
 * to the dark default. An empty-string override is treated as unset.
 */
export function resolveDialBoxColors(overrides: DialBoxColorOverrides | undefined, accent: string): DialBoxColors {
  return {
    border: overrideOr(overrides?.borderColor, accent),
    label: overrideOr(overrides?.labelColor, accent),
    value: overrideOr(overrides?.valueColor, accent),
    background: overrideOr(overrides?.backgroundColor, DIAL_BOX_BACKGROUND),
  };
}

/**
 * Bold Arial digits + "." average ~0.6 em wide; shrink the value font so the
 * number fits the box width, capped so short values (e.g. "3") stay sensible.
 */
function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  const approx = maxWidth / Math.max(1, text.length * 0.6);

  return Math.round(Math.min(cap, approx));
}

/**
 * Renders the dash-box SVG. The background fills the panel INSIDE the border;
 * the border strokes it; an optional blurred glow (Elgato-only, gated on
 * `__FEATURE_BORDER_GLOW__`) sits behind it. An empty `value` (identity-only
 * setting) draws just the centered label. When the rotation binding is missing
 * the content dims under the centered #612 warning triangle.
 */
export function renderDialBox(args: {
  width: number;
  height: number;
  abbr: string;
  value: string;
  colors: DialBoxColors;
  glow: DialBoxGlow;
  identityLabelScale?: number;
  bindingMissing?: boolean;
}): string {
  const {
    width: w,
    height: h,
    abbr,
    value,
    colors,
    glow,
    identityLabelScale = DEFAULT_IDENTITY_LABEL_SCALE,
    bindingMissing = false,
  } = args;

  const minSide = Math.min(w, h);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const identityOnly = value === "";

  const labelFontSize = identityOnly ? Math.round(minSide * identityLabelScale) : Math.round(minSide * 0.15);
  const labelY = identityOnly ? Math.round(h * 0.5) : Math.round(h * 0.28);

  const labelText = `<text x="${w / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="central" fill="${colors.label}" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="bold">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(
      value,
      w - 2 * (inset + strokeWidth + Math.round(w * 0.05)),
      Math.round(h * 0.52),
    );
    const valueY = Math.round(h * 0.64) + 13;
    valueText = `<text x="${w / 2}" y="${valueY}" text-anchor="middle" dominant-baseline="central" fill="${colors.value}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${value}</text>`;
  }

  const content = labelText + valueText;

  const innerW = w - 2 * inset;
  const innerH = h - 2 * inset;
  const innerRx = Math.max(0, radius - inset);

  // The background fills the panel INSIDE the border; a single filled+stroked
  // inset rect leaves the outer margin transparent (device black).
  const panelRect = `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;

  let glowDefs = "";
  let glowRect = "";

  if (glow.enabled && __FEATURE_BORDER_GLOW__) {
    const glowWidth = Math.min(glow.width, DIAL_GLOW_WIDTH_MAX);
    glowDefs = `<defs><filter id="ird-dial-glow"><feGaussianBlur stdDeviation="${DIAL_GLOW_STD_DEV}"/></filter></defs>`;
    // Drawn before the panel: the blurred halo shows outside the border, its
    // inner half covered by the panel fill.
    glowRect = `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRx}" fill="none" stroke="${colors.border}" stroke-width="${glowWidth}" opacity="${DIAL_GLOW_OPACITY}" filter="url(#ird-dial-glow)"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    glowDefs +
    glowRect +
    panelRect +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}

/**
 * Dash-box appearance settings, spread into each Setup dial's `DialSettings`
 * schema (issue #811). All slots default so a keypad-only instance or a fresh
 * dial parses cleanly, and every field is `.catch`-guarded so a value written
 * by a newer plugin version degrades to its default instead of failing the
 * whole settings parse (the 2.0-settings-contamination failure mode).
 */
const dialColorField = z.string().catch("").default("");

export const dialAppearanceFields = {
  colors: z
    .object({
      borderColor: dialColorField,
      labelColor: dialColorField,
      valueColor: dialColorField,
      backgroundColor: dialColorField,
    })
    .prefault({}),
  glow: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((val) => val === true || val === "true")
    .catch(false),
  glowWidth: z.coerce.number().catch(DIAL_GLOW_WIDTH_DEFAULT).default(DIAL_GLOW_WIDTH_DEFAULT),
};
