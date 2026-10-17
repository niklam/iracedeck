/**
 * Replay busy marks (issue #1437).
 *
 * The three looks a pressed replay key takes while its press is being carried
 * out: **working** (a ring of eight dots with one bright dot and a fading tail,
 * stepped by the caller), **waiting** (three still dots in a row, the press is
 * held behind something else) and **not done** (a red cross, the plugin gave
 * up or ignored the press). Drawn in place of the key's artwork, inside the
 * title-aware graphic area, by {@link assembleIcon}'s `busy` option or directly
 * by an action that assembles its icon by hand (Replay Control's Set Speed).
 *
 * Cross-platform constraint: built only from `circle`, `line` and opacity — no
 * filters, masks, clipPath or CSS — so the marks read the same with the
 * `pngRasterization` kill-switch off. See
 * `.claude/rules/svg-platform-compatibility.md`.
 */
import type { GraphicArea } from "./title-settings.js";

/** The look a busy replay key shows. `step` is the working ring's frame, any integer. */
export type BusyMark = { kind: "working"; step: number } | { kind: "waiting" } | { kind: "not-done" };

/** Frames in one turn of the working ring: step n and step n + 8 draw the same text. */
export const BUSY_MARK_FRAMES = 8;

/** The fixed semantic red of the not-done cross, whatever the key's colours. */
export const BUSY_NOT_DONE_COLOR = "#e74c3c";

/**
 * The smallest area side the marks are drawn at their authored sizes. Below
 * it every length scales by `side / BUSY_MARK_FULL_SIDE`, so a key whose title
 * leaves little room (three title lines, or a large font) shows the same mark
 * smaller instead of dots that crowd into each other or spill onto the title.
 */
const BUSY_MARK_FULL_SIDE = 72;

/**
 * The largest side the marks are laid out in. A key with no title (or its
 * title hidden) has the whole 128-unit square as its artwork area, where a ring
 * filling it read as too big beside the titled keys (maintainer, 2026-10-17);
 * 84 is the area a default two-line title leaves (83.4), so every key shows
 * the mark at most at the size it has on a titled key, centred where the
 * artwork sits.
 */
export const BUSY_MARK_MAX_SIDE = 84;

/** Working ring dot radius at full size; the newest dot is one unit larger. */
const WORKING_DOT = 7;
/** Working ring opacity by age, newest first. */
const WORKING_OPACITY = [1, 0.7, 0.45, 0.3, 0.2, 0.2, 0.2, 0.2] as const;

/** Waiting dots: radius and horizontal spacing at full size. */
const WAITING_DOT = 9;
const WAITING_SPACING = 26;

/** Not-done cross: inset from the area's half side, and stroke width, at full size. */
const NOT_DONE_INSET = 10;
const NOT_DONE_STROKE = 12;

/**
 * Return the SVG fragment of a busy mark, centred in `area`.
 *
 * `area` is a rectangle on the 144-unit key canvas, normally
 * {@link computeGraphicArea}'s answer for the key's title. `color` fills the
 * working and waiting dots; the not-done cross is always
 * {@link BUSY_NOT_DONE_COLOR}. Coordinates are rounded to two decimals, so the
 * same mark in the same area is the same text (the rasterizer's cache is the
 * frame cache). An area with no room (a side of zero or less) draws nothing.
 *
 * Sizes: the mark is laid out in a square of the area's smaller side, capped
 * at {@link BUSY_MARK_MAX_SIDE}. The authored sizes hold while that side is at
 * least 72 units; below that every length shrinks in proportion, so the mark
 * keeps its shape and stays inside the area.
 */
export function busyMarkSvg(mark: BusyMark, area: GraphicArea, color: string): string {
  const side = Math.min(area.width, area.height, BUSY_MARK_MAX_SIDE);

  if (!(side > 0)) return "";

  const k = Math.min(1, side / BUSY_MARK_FULL_SIDE);
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;

  switch (mark.kind) {
    case "working":
      return workingSvg(mark.step, cx, cy, side, k, color);
    case "waiting":
      return waitingSvg(cx, cy, k, color);
    case "not-done":
      return notDoneSvg(cx, cy, side, k);
  }
}

function workingSvg(step: number, cx: number, cy: number, side: number, k: number, color: string): string {
  const frames = BUSY_MARK_FRAMES;
  const whole = Number.isFinite(step) ? Math.trunc(step) : 0;
  const s = ((whole % frames) + frames) % frames;
  const dot = WORKING_DOT * k;
  const radius = side / 2 - dot - k;
  const circles: string[] = [];

  for (let i = 0; i < frames; i++) {
    const age = (s - i + frames) % frames;
    // 0° at the top, clockwise.
    const angle = (i * 2 * Math.PI) / frames;
    const x = cx + radius * Math.sin(angle);
    const y = cy - radius * Math.cos(angle);
    const r = age === 0 ? dot + k : dot;

    circles.push(
      `<circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" fill="${color}" opacity="${WORKING_OPACITY[age]}"/>`,
    );
  }

  return `<g>${circles.join("")}</g>`;
}

function waitingSvg(cx: number, cy: number, k: number, color: string): string {
  const r = round(WAITING_DOT * k);
  const circles = [-1, 0, 1].map(
    (n) => `<circle cx="${round(cx + n * WAITING_SPACING * k)}" cy="${round(cy)}" r="${r}" fill="${color}"/>`,
  );

  return `<g>${circles.join("")}</g>`;
}

function notDoneSvg(cx: number, cy: number, side: number, k: number): string {
  const half = side / 2 - NOT_DONE_INSET * k;
  const x1 = round(cx - half);
  const x2 = round(cx + half);
  const y1 = round(cy - half);
  const y2 = round(cy + half);
  const stroke = `stroke="${BUSY_NOT_DONE_COLOR}" stroke-width="${round(NOT_DONE_STROKE * k)}" stroke-linecap="round"`;

  return (
    `<g>` +
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}/>` +
    `<line x1="${x1}" y1="${y2}" x2="${x2}" y2="${y1}" ${stroke}/>` +
    `</g>`
  );
}

/** Two decimals, with no negative zero, so equal geometry is equal text. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;

  return rounded === 0 ? 0 : rounded;
}
