/**
 * The dial's own screen (issue #1013).
 *
 * A description of HARDWARE, not of a host: the Stream Deck+ touch-strip slot
 * an encoder action owns, and the LCD segment above a Stream Dock knob. It
 * lives here beside the other device profiles so a second action package gets
 * the same profiles, and it knows nothing about any sim or any host protocol —
 * the adapters decide which profile a context has, and renderers branch on
 * `id`, never on the platform.
 */

/** Which device class a dial drawing is for. */
export type DialCanvasId = "sd-plus-strip" | "stream-dock-knob";

export interface DialCanvasProfile {
  /** Which device class the drawing is for; renderers branch on this, never on the platform. */
  readonly id: DialCanvasId;
  /** Canvas width in px — the drawing's own `viewBox` width. */
  readonly width: number;
  /** Canvas height in px — the drawing's own `viewBox` height. */
  readonly height: number;
}

/** One encoder's slot of the Stream Deck+ 800×100 touch strip. */
export const SD_PLUS_STRIP_CANVAS: DialCanvasProfile = Object.freeze({ id: "sd-plus-strip", width: 200, height: 100 });

/**
 * The LCD segment above a Stream Dock knob (measured on an N4-class device;
 * one profile for every knob — a knob without a screen ignores the image).
 */
export const STREAM_DOCK_KNOB_CANVAS: DialCanvasProfile = Object.freeze({
  id: "stream-dock-knob",
  width: 176,
  height: 112,
});

/**
 * The layout item key every Elgato dial layout under `layouts/` uses for its
 * single full-canvas pixmap; the Elgato adapter's `setDialCanvas` pushes under it.
 */
export const DIAL_CANVAS_KEY = "box";
