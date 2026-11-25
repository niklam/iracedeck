import { describe, expect, it } from "vitest";

import type { DialBoxColors } from "../../shared/dial-box.js";
import { AUTO_GROUP_MARKER_SIZE, renderAutoGroupMarker } from "./auto-group-marker.js";

// The two dial screens Camera Controls draws on (deck-core's SD_PLUS_STRIP_CANVAS
// and STREAM_DOCK_KNOB_CANVAS), by size: the marker module takes only a size.
const STRIP = { width: 200, height: 100 };
const KNOB = { width: 176, height: 112 };

const COLORS: DialBoxColors = { border: "#3498db", label: "#1abc9c", value: "#e67e22", background: "#0d0d0d" };

interface Badge {
  x: number;
  y: number;
  size: number;
  inner: string;
}

function parse(fragment: string): Badge {
  const match = fragment.match(
    /^<g data-auto-group-marker="on" transform="translate\(([\d.]+) ([\d.]+)\)">(.*)<\/g>$/s,
  );

  if (!match) throw new Error(`not a marker fragment: ${fragment}`);

  const rect = match[3].match(/<rect x="0" y="0" width="([\d.]+)" height="([\d.]+)"/);

  if (!rect) throw new Error(`marker has no badge rect: ${fragment}`);

  expect(rect[1]).toBe(rect[2]);

  return { x: Number(match[1]), y: Number(match[2]), size: Number(rect[1]), inner: match[3] };
}

/**
 * The inside of the dial panel's border, as `camera-dial-surface.ts`' `dialPanel`
 * draws it: a rect at `inset` with corner radius `radius - inset`, stroked
 * `strokeWidth` wide on its edge, so half the stroke eats inward.
 */
function panelInside(canvas: { width: number; height: number }): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  radius: number;
} {
  const minSide = Math.min(canvas.width, canvas.height);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const edge = inset + strokeWidth / 2;

  return {
    left: edge,
    top: edge,
    right: canvas.width - edge,
    bottom: canvas.height - edge,
    radius: radius - inset - strokeWidth / 2,
  };
}

/** Whether a point lies inside the panel's rounded inner boundary (top-right corner checked; the badge lives there). */
function insidePanel(canvas: { width: number; height: number }, px: number, py: number): boolean {
  const p = panelInside(canvas);

  if (px < p.left || px > p.right || py < p.top || py > p.bottom) return false;

  const cx = p.right - p.radius;
  const cy = p.top + p.radius;

  if (px > cx && py < cy) return Math.hypot(px - cx, py - cy) <= p.radius;

  return true;
}

describe("renderAutoGroupMarker", () => {
  it.each([
    ["strip", STRIP],
    ["knob", KNOB],
  ])("draws a 16 px A badge wrapped in the on marker group on the %s", (_name, canvas) => {
    const fragment = renderAutoGroupMarker(canvas, COLORS);
    const badge = parse(fragment);

    expect(fragment.startsWith('<g data-auto-group-marker="on"')).toBe(true);
    expect(badge.size).toBe(AUTO_GROUP_MARKER_SIZE);
    expect(badge.inner).toMatch(/<text [^>]*>A<\/text>/);
  });

  it.each([
    ["strip", STRIP],
    ["knob", KNOB],
  ])("keeps the badge inside the panel's inner border on the %s", (_name, canvas) => {
    const { x, y, size } = parse(renderAutoGroupMarker(canvas, COLORS));

    // All four corners of the badge's bounding square, so the rounded panel corner is covered too.
    for (const [px, py] of [
      [x, y],
      [x + size, y],
      [x, y + size],
      [x + size, y + size],
    ]) {
      expect(insidePanel(canvas, px, py), `(${px}, ${py})`).toBe(true);
    }
  });

  it("sits right of the strip's title and above its right side slot", () => {
    const { x, y, size } = parse(renderAutoGroupMarker(STRIP, COLORS));

    // The longest strip title, TRACK ORDER, is 96 px wide in 13 px bold Arial, centred: it ends at x 148.
    expect(x).toBeGreaterThanOrEqual(150);
    // The right side slot's glyph is 26 px, centred on the middle line (y 50): it starts at y 37.
    expect(y + size).toBeLessThan(37);
  });

  it("sits under the knob's title, above its centre value and right of its centre glyph", () => {
    const { x, y, size } = parse(renderAutoGroupMarker(KNOB, COLORS));

    // The knob title's baseline is y 28 and its longest (TRACK ORDER, 16 px) spans x 29-147.
    expect(y).toBeGreaterThanOrEqual(28);
    // A 44 px centre value has its baseline at 62 + 16 = 78, so its capitals start at y ≈ 46.5.
    expect(y + size).toBeLessThan(46.5);
    // The centre glyph is 40 px centred on x 88: it ends at x 108.
    expect(x).toBeGreaterThan(108);
  });

  it("draws the same badge on the strip and the knob, only placed differently", () => {
    const strip = parse(renderAutoGroupMarker(STRIP, COLORS));
    const knob = parse(renderAutoGroupMarker(KNOB, COLORS));

    expect(knob.inner).toBe(strip.inner);
    expect([knob.x, knob.y]).not.toEqual([strip.x, strip.y]);
  });

  it("fills the badge with the value colour and cuts the A out in the background", () => {
    const { inner } = parse(renderAutoGroupMarker(STRIP, COLORS));

    expect(inner).toMatch(new RegExp(`<rect [^>]*fill="${COLORS.value}"`));
    expect(inner).toMatch(new RegExp(`<text [^>]*fill="${COLORS.background}"[^>]*>A</text>`));
    // Only the passed colours: no fixed hex of its own.
    expect(inner.match(/#[0-9a-f]{6}/gi)?.sort()).toEqual([COLORS.background, COLORS.value].sort());
  });

  it("follows a recoloured dial", () => {
    const recoloured: DialBoxColors = { ...COLORS, value: "#ffffff", background: "#123456" };
    const { inner } = parse(renderAutoGroupMarker(KNOB, recoloured));

    expect(inner).toContain('fill="#ffffff"');
    expect(inner).toContain('fill="#123456"');
    expect(inner).not.toContain(COLORS.value);
  });
});
