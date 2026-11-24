/**
 * Audio Controls — the dial screen's drawing (#1662).
 *
 * The pure renderers of the Audio Controls dial surface
 * (`audio-dial-surface.ts`, #782): the Stream Deck+ touch strip and the Stream
 * Dock knob screen (#1013), and the dispatch between them. They take an
 * {@link AudioStripState} the surface resolves and read nothing else, so this
 * module imports no sim or audio package — the website's icon gallery draws
 * its Audio Controls sample from it without loading either.
 */
import { applyBindingWarning, type DialCanvasProfile } from "@iracedeck/deck-core";

import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH } from "../../shared/dial-knob-box.js";
import type { DialCategory } from "./audio-controls-settings.js";

/** The touch-strip slot; the SVG envelope and the #612 warning's canvas must agree on it. */
const STRIP = { width: 200, height: 100 } as const;

/** The Stream Dock knob screen (#1013) — the shared knob size; the same agreement holds. */
const KNOB = { width: KNOB_BOX_WIDTH, height: KNOB_BOX_HEIGHT } as const;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";
const BAND_BG = "#2a2f36";
const BAR_TRACK = "#1a1f26";

/** @internal Exported for testing */
export const CATEGORY_LABELS: Record<DialCategory, string> = {
  "voice-chat": "VOICE CHAT",
  master: "MASTER",
  spotter: "SPOTTER",
  "race-engineer": "RACE ENGINEER",
  radar: "RADAR",
};

/**
 * Everything the strip render needs, resolved by the surface so the renderer
 * stays pure. `volume`/`enabled` are set only for the internal categories.
 */
export interface AudioStripState {
  category: DialCategory;
  /** 0–100 volume for the internal categories; undefined for keybind ones. */
  volume?: number;
  /** Feature-gate state for the internal categories; undefined for keybind ones. */
  enabled?: boolean;
  /** True while the PTT binding is held (press action = push-to-talk). */
  pttHeld: boolean;
  /**
   * True when a binding this dial's rotate/press needs is unconfigured (#612),
   * or when the stored press cannot fire on this dial at all (#1196).
   */
  bindingMissing: boolean;
}

/**
 * @internal Exported for testing
 *
 * Draws the 200×100 touch-strip slot as one self-drawn pixmap (the fuel
 * surface convention): a top band with the category label (red "ON AIR"
 * while PTT is held), then a live level bar + numeric value for the internal
 * categories, or a "Turn to adjust volume" hint for the keybind categories
 * (iRacing exposes no volume state — identity only, by design). Text y values
 * are BASELINES (the deck app's QT renderer ignores dominant-baseline).
 */
export function renderAudioStripSvg(state: AudioStripState): string {
  const bandColor = state.pttHeld ? RED : BAND_BG;
  const bandText = state.pttHeld ? "ON AIR" : CATEGORY_LABELS[state.category];

  const parts = [
    `<rect x="0" y="0" width="200" height="30" fill="${bandColor}"/>`,
    `<text x="100" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">${bandText}</text>`,
  ];

  if (state.volume !== undefined) {
    const barX = 8;
    const barY = 50;
    const barW = 184;
    const barH = 32;
    const on = state.enabled !== false;
    const fillW = Math.max(0, Math.min(barW, (state.volume / 100) * barW));
    const valueText = on ? String(Math.round(state.volume)) : "OFF";

    parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="8" fill="${BAR_TRACK}"/>`);

    if (fillW > 0) {
      parts.push(
        `<rect x="${barX}" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="8" fill="${on ? GREEN : GRAY}"/>`,
      );
    }

    parts.push(
      `<text x="100" y="${barY + barH / 2 + 6}" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${valueText}</text>`,
    );
  } else {
    parts.push(
      `<text x="100" y="70" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="13">Turn to adjust volume</text>`,
    );
  }

  const content = parts.join("");

  // Missing binding: dim the slot and draw the #612 warning triangle over it,
  // centered on the strip canvas — without the canvas the glyph keeps its
  // 144x144 key placement (same convention as the Fuel Service strip box).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STRIP.width} ${STRIP.height}" width="${STRIP.width}" height="${STRIP.height}">${
    state.bindingMissing ? applyBindingWarning(content, STRIP) : content
  }</svg>`;
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderAudioStripSvg} (#1013): the same
 * band / bar / value vocabulary on the 176×112 segment — the band keeps its
 * 30 px, the bar grows to 36 px and the value to 22 px.
 */
export function renderAudioKnobSvg(state: AudioStripState): string {
  const w = KNOB.width;
  const h = KNOB.height;
  const bandColor = state.pttHeld ? RED : BAND_BG;
  const bandText = state.pttHeld ? "ON AIR" : CATEGORY_LABELS[state.category];
  const parts = [
    `<rect x="0" y="0" width="${w}" height="30" fill="${bandColor}"/>`,
    `<text x="${w / 2}" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">${bandText}</text>`,
  ];

  if (state.volume !== undefined) {
    const barX = 8;
    const barY = 58;
    const barW = w - 16;
    const barH = 36;
    const on = state.enabled !== false;
    const fillW = Math.max(0, Math.min(barW, (state.volume / 100) * barW));
    const valueText = on ? String(Math.round(state.volume)) : "OFF";

    parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="8" fill="${BAR_TRACK}"/>`);

    if (fillW > 0) {
      parts.push(
        `<rect x="${barX}" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="8" fill="${on ? GREEN : GRAY}"/>`,
      );
    }

    parts.push(
      `<text x="${w / 2}" y="${barY + barH / 2 + 8}" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">${valueText}</text>`,
    );
  } else {
    parts.push(
      `<text x="${w / 2}" y="78" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="14">Turn to adjust volume</text>`,
    );
  }

  const content = parts.join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${
    state.bindingMissing ? applyBindingWarning(content, KNOB) : content
  }</svg>`;
}

/** Picks the drawing for the dial's own screen by its profile (#1013). */
export function renderAudioCanvasFor(canvas: DialCanvasProfile, state: AudioStripState): string {
  switch (canvas.id) {
    case "sd-plus-strip":
      return renderAudioStripSvg(state);
    case "stream-dock-knob":
      return renderAudioKnobSvg(state);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`Audio Controls: no drawing for dial canvas "${String(unhandled)}"`);
    }
  }
}
