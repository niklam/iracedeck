/**
 * Disconnected look (issue #1599).
 *
 * While the sim is absent, every key whose current mode needs it is drawn as
 * its own image, unchanged, under one full-canvas black layer at
 * {@link DISCONNECTED_DIM_OPACITY}, with a small "disconnected" badge in the
 * top-left corner on top of that layer: a white plug struck through by a white
 * slash on a red plate (chosen on the #1599 badge review, 2026-11-09). The dim
 * layer goes over the whole image, so any look the action drew itself (the #612 binding ⚠, the
 * unavailable grey) is dimmed with the rest of the key and still reads.
 *
 * Placement: the badge keeps clear of the bottom title band, the centre (the
 * #612 ⚠) and the top-right corner (the "A" automatic-mode badge), and takes
 * well under a third of the key's width.
 *
 * Cross-platform constraint: the badge carries essential information, so it
 * must read with `pngRasterization` off (Mirabox/Ulanzi QT5, SVG Tiny). It is
 * built only from `rect`, `circle`, `polygon` and `path` with plain fills,
 * strokes, `opacity` / `fill-opacity` and translate/scale/rotate transforms —
 * no filter, mask, clipPath, gradient, text, `<style>` or class. See
 * `.claude/rules/svg-platform-compatibility.md`.
 */
import { parseSvgViewBox, type SvgViewBox } from "./icon-template.js";
import { dataUriToSvg, isDataUri, isRawSvg, svgToDataUri } from "./svg-utils.js";

/** Opacity of the black layer drawn over the whole key while disconnected. */
export const DISCONNECTED_DIM_OPACITY = 0.55;

/** The reference canvas side the badges are authored for. */
const BADGE_CANVAS = 144;

/** Badge plate: a 40×40 rounded square inset 8 from the top-left corner (28 % of the key width). */
const PLATE = { x: 8, y: 8, size: 40, rx: 9 } as const;
/** Plate colour (the project's semantic red, darkened so the white glyph reads). */
const PLATE_RED = "#c0392b";
/** Light outline so the plate keeps its edge over dark art. */
const PLATE_OUTLINE = "#8a8a8a";
/** Glyph colour. */
const GLYPH_LIGHT = "#f2f2f2";

/** The rounded plate every badge sits on, so it reads over any artwork. */
function plate(fill: string): string {
  return (
    `<rect x="${PLATE.x}" y="${PLATE.y}" width="${PLATE.size}" height="${PLATE.size}" rx="${PLATE.rx}" ` +
    `fill="${fill}" stroke="${PLATE_OUTLINE}" stroke-width="1.5"/>`
  );
}

/** A plug seen from the side: body, two prongs pointing up, and the cord going down. */
function plug(fill: string): string {
  return [
    `<rect x="22" y="17" width="3.5" height="9" rx="1" fill="${fill}"/>`,
    `<rect x="30.5" y="17" width="3.5" height="9" rx="1" fill="${fill}"/>`,
    `<rect x="19" y="25" width="18" height="11" rx="3" fill="${fill}"/>`,
    `<rect x="26" y="35" width="4" height="9" rx="1" fill="${fill}"/>`,
  ].join("");
}

/**
 * A thick diagonal bar from (x1, y1) to (x2, y2), as a polygon, so it needs no
 * stroke caps or joins to look the same on every renderer.
 */
function bar(x1: number, y1: number, x2: number, y2: number, halfWidth: number, fill: string): string {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / length) * halfWidth;
  const ny = ((x2 - x1) / length) * halfWidth;
  const points = [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ]
    .map(([x, y]) => `${round(x)},${round(y)}`)
    .join(" ");

  return `<polygon points="${points}" fill="${fill}"/>`;
}

/** The "no" slash across the plate, with a cut in the plate colour so it separates from the glyph. */
function slash(cutFill: string, slashFill: string): string {
  return bar(14, 14, 42, 42, 4.2, cutFill) + bar(14, 14, 42, 42, 2.2, slashFill);
}

/**
 * The badge: a white plug struck through by a white slash, on a red rounded
 * plate in the top-left corner. A standalone snippet for the 144×144 canvas
 * (no wrapping `<svg>`).
 */
export const DISCONNECTED_BADGE: string = `<g>${plate(PLATE_RED)}${plug(GLYPH_LIGHT)}${slash(PLATE_RED, GLYPH_LIGHT)}</g>`;

/**
 * The overlay for a canvas: the full-canvas dim rectangle, then the badge,
 * scaled by the canvas's shorter side and anchored at its top-left corner
 * (respecting a non-zero viewBox origin).
 */
export function disconnectedOverlaySvg(box: SvgViewBox): string {
  const badge = DISCONNECTED_BADGE;
  const dim = `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#000000" fill-opacity="${DISCONNECTED_DIM_OPACITY}"/>`;

  const scale = Math.min(box.width, box.height) / BADGE_CANVAS;

  if (box.x === 0 && box.y === 0 && scale === 1) {
    return dim + badge;
  }

  return `${dim}<g transform="translate(${round(box.x)}, ${round(box.y)}) scale(${round(scale)})">${badge}</g>`;
}

/**
 * Draw the disconnected look over a key image.
 *
 * Accepts a raw SVG or an SVG data URI and returns the same form (a data URI
 * comes back base64-encoded). The overlay is inserted just before the root's
 * closing tag, the last `</svg>`, so nested `<svg>` elements are left alone.
 * The canvas is the root `viewBox`, or its `width` / `height` when it has
 * none. Anything that cannot be placed — a PNG data URI, a malformed data URI,
 * a non-SVG string, an SVG with neither a viewBox nor a usable size — is
 * returned unchanged.
 */
export function applyDisconnectedLook(svg: string): string {
  if (isDataUri(svg)) {
    if (!/^data:image\/svg\+xml[;,]/i.test(svg)) return svg;

    let raw: string;

    try {
      raw = dataUriToSvg(svg);
    } catch {
      return svg;
    }

    const decorated = decorateRawSvg(raw);

    return decorated === undefined ? svg : svgToDataUri(decorated);
  }

  if (!isRawSvg(svg)) return svg;

  return decorateRawSvg(svg) ?? svg;
}

/** Insert the overlay into a raw SVG, or `undefined` when it cannot be placed. */
function decorateRawSvg(svg: string): string | undefined {
  const rootTag = svg.match(/<svg\b[^>]*>/i)?.[0];

  if (!rootTag) return undefined;

  const box = rootCanvas(rootTag);
  const closeAt = svg.lastIndexOf("</svg>");

  if (!box || closeAt === -1) return undefined;

  return svg.slice(0, closeAt) + disconnectedOverlaySvg(box) + svg.slice(closeAt);
}

/** The root canvas: its viewBox, else its `width` and `height` in user units. */
function rootCanvas(rootTag: string): SvgViewBox | undefined {
  const viewBox = parseSvgViewBox(rootTag);

  if (viewBox) return viewBox;

  const width = lengthAttribute(rootTag, "width");
  const height = lengthAttribute(rootTag, "height");

  if (width === undefined || height === undefined) return undefined;

  return { x: 0, y: 0, width, height };
}

/** A positive length attribute in user units (bare or `px`); a percentage or other unit is not usable. */
function lengthAttribute(tag: string, name: string): number | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])\\s*([0-9]*\\.?[0-9]+)\\s*(?:px)?\\s*\\1`, "i"));

  if (!match) return undefined;

  const value = Number(match[2]);

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Trim transform values to a stable, compact precision. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
