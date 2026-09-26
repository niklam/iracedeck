/**
 * The shared Stream Deck+ dial "dash box" — the 200×100 touch-strip pixmap the
 * seven Setup dial surfaces (Brakes, Traction, Fuel, Engine, Aero, Chassis,
 * Hybrid) draw for their encoder slot. Each action was carrying its own copy of
 * this renderer (issue #817); this module is the single source (issue #811),
 * and adds user-adjustable colors.
 *
 * The box is a rounded panel floating on the black device screen: the
 * background color fills the area INSIDE the border frame (the outer margin
 * stays transparent → device black), the border strokes that panel, and the
 * abbreviation label + live value sit on top. Actions resolve their per-setting
 * accent + any user overrides via `resolveDialBoxColors`, spread
 * `dialAppearanceFields` into their dial settings schema, and route rendering
 * through `renderDialBox`. Since #1013 this module is the dispatcher; the strip
 * drawing lives in `dial-strip-box.ts`, the knob drawing in `dial-knob-box.ts`.
 */
import type { DialCanvasProfile } from "@iracedeck/deck-core";
import { z } from "zod";

import { renderKnobBox } from "./dial-knob-box.js";
import type { DialPendingPreview } from "./dial-preview.js";
import { renderStripBox } from "./dial-strip-box.js";

/** Default panel background — near-black, ≈ the device screen, so the default look is unchanged. */
export const DIAL_BOX_BACKGROUND = "#0d0d0d";

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

/** What every dash-box surface hands the renderer; the canvas decides the drawing. */
export interface DialBoxArgs {
  abbr: string;
  value: string;
  colors: DialBoxColors;
  identityLabelScale?: number;
  bindingMissing?: boolean;
  /**
   * Draw fixed left/right triangles flanking the label, lighting the given
   * side and dimming the other (#953: the LR/RR spring dials). The label stays
   * centered — the markers occupy fixed slots so the text never shifts when
   * the user switches between the two sides.
   */
  sideMarker?: "left" | "right";
  /**
   * The pending long-press outcome (issue #1120). While set, the value slot
   * shows this instead of the live value, underlined by the shared pending bar —
   * so a hold past the threshold visibly changes the dial's screen and the
   * driver can release on the change rather than on a guess. An identity-only
   * box (no live value) borrows the value slot for the duration.
   */
  pending?: DialPendingPreview | null;
}

/**
 * Renders the dash box for the dial's own screen: the Stream Deck+ strip
 * drawing (`renderStripBox`, unchanged since #811) or the Stream Dock knob
 * drawing (`renderKnobBox`, #1013). Two renderers, one vocabulary — selected
 * by the profile's id, never by the platform.
 */
export function renderDialBox(canvas: DialCanvasProfile, args: DialBoxArgs): string {
  switch (canvas.id) {
    case "sd-plus-strip":
      return renderStripBox({ ...args, width: canvas.width, height: canvas.height });
    case "stream-dock-knob":
      return renderKnobBox(args);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`renderDialBox: no renderer for dial canvas "${String(unhandled)}"`);
    }
  }
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
    .prefault({})
    // A persisted non-object `colors` (string/array/… from a newer version)
    // degrades to empty overrides — preserving the rest of the dial config —
    // rather than throwing up to the dial-level `.catch`, which would reset the
    // whole `dial` object (setting, gestures) to defaults.
    .catch({ borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" }),
};
