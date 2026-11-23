/**
 * Camera Controls — the dial screen's drawing (#1662).
 *
 * The pure carousel renderers of the Camera Controls dial surface
 * (`camera-dial-surface.ts`, #803): the camera, sub-camera, car and
 * race-position strips for the Stream Deck+ touch strip, the knob carousel for
 * the Stream Dock knob screen (#1013), the hold-preview centre they share
 * (#1120), and the views they take. The surface resolves every view from
 * telemetry and session info; these functions read nothing else, so this
 * module imports no sim package — the website's icon gallery draws its Camera
 * Controls sample from it without loading the iRacing SDK.
 */
import { applyBindingWarning, escapeXml, STREAM_DOCK_KNOB_CANVAS } from "@iracedeck/deck-core";

import type { DialBoxColors } from "../../shared/dial-box.js";
import { fitValueFontSize } from "../../shared/dial-fit.js";
import { type DialPendingPreview, PENDING_BAR_HEIGHT, renderPendingBar } from "../../shared/dial-preview.js";

/** A colour-resolved camera-group icon glyph for the carousel. */
export interface CarouselGlyph {
  /** Source viewBox width of the group icon. */
  width: number;
  /** Source viewBox height. */
  height: number;
  /** The colour-resolved inner artwork (no `<svg>` wrapper). */
  artwork: string;
}

/** One camera carousel slot: a group name plus its glyph (null when unmapped). */
export interface CarouselSlot {
  name: string;
  glyph: CarouselGlyph | null;
}

/**
 * The car carousel readouts: the focused car's number plus, for car-number,
 * the adjacent car either way along the ascending order (every car the session
 * has had, departed ones included, #1281), already assigned to their STRIP
 * SIDES — left = the counter-clockwise detent's target, right = the clockwise
 * one (#884). Track-order leaves both sides null: iRacing picks its car
 * (#1277).
 */
export interface CarCarouselView {
  /** Focused car's display number (no `#`), or null out of a session. */
  center: string | null;
  left: string | null;
  right: string | null;
}

/**
 * The race-position carousel readouts: the focused car's POSITION (the
 * primary centre readout) and its car number (the secondary label beneath
 * it), plus the dimmed side previews — themselves POSITIONS, not car
 * numbers, since a side badge only needs to say "one detent away is P<n>"
 * (issue #803 rework). Sides follow the EFFECTIVE rotation mapping (#884):
 * left = the counter-clockwise detent's target, right = the clockwise one.
 */
export interface RacePositionCarouselView {
  /** Focused car's race position, or null when unclassified (pace/safety car). */
  centerPosition: number | null;
  /** Focused car's display number (no `#`), or null out of a session. */
  centerCarNumber: string | null;
  /** Recovery-aware target position one counter-clockwise detent away (see `computeRacePositionTarget`). */
  leftPosition: number | null;
  /** Recovery-aware target position one clockwise detent away. */
  rightPosition: number | null;
}

function svgWrap(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`;
}

/**
 * The rounded dash-box panel: the background fills the panel INSIDE the border
 * frame (outer margin stays device-black) and the border strokes it — matching
 * the shared `renderDialBox` geometry so the carousel strips look identical to
 * the label/value strips.
 */
function dialPanel(w: number, h: number, colors: DialBoxColors): string {
  const { radius, inset, strokeWidth } = panelFrame(w, h);
  const innerRx = Math.max(0, radius - inset);

  return `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;
}

/** The panel's frame geometry, shared by the panel rect and the pending mark's clamp. */
function panelFrame(w: number, h: number): { radius: number; inset: number; strokeWidth: number } {
  const minSide = Math.min(w, h);

  return {
    radius: Math.round(minSide * 0.16),
    inset: Math.max(5, Math.round(minSide * 0.045)),
    strokeWidth: Math.max(5, Math.round(minSide * 0.05)),
  };
}

/** The strip's hold-preview centre size: the car number size every car strip uses. */
const PENDING_CENTRE_FONT = 40;

/**
 * The centre slot while a hold preview is pending (issue #1120): the outcome
 * in the big car-number typography every car strip already uses for its
 * centre, in the preview's colour, underlined by the shared pending bar. ONE
 * helper for all four carousels, so a Camera preview and a Fuel Service
 * preview read as the same language — and so the sides, which every renderer
 * draws before its centre, are never touched by the preview.
 */
function pendingCentre(w: number, h: number, pending: DialPendingPreview): string {
  const { inset, strokeWidth } = panelFrame(w, h);
  const valueY = Math.round(h * 0.72);
  // Fitted inside the panel, so a word preview (#1656's AUTO OFF) shrinks
  // where a car number keeps the full 40 px.
  const size = fitValueFontSize(pending.text, w - 2 * (inset + strokeWidth + 8), PENDING_CENTRE_FONT);
  const text = `<text x="${w / 2}" y="${valueY}" text-anchor="middle" fill="${pending.color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${escapeXml(pending.text)}</text>`;
  // Just under the value's baseline, clamped inside the panel — the border
  // strokes ON the inset rect, so half of it eats inward (as `renderDialBox`).
  const barTop = Math.min(valueY + 6, h - inset - Math.round(strokeWidth / 2) - PENDING_BAR_HEIGHT);

  return text + renderPendingBar({ centerX: w / 2, y: barTop, width: w, color: pending.color });
}

/** A centred identity label (out-of-session fallback). */
function identityBox(w: number, h: number, label: string, colors: DialBoxColors): string {
  const text = `<text x="${w / 2}" y="${Math.round(h * 0.5) + 8}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="24" font-weight="bold">${escapeXml(label)}</text>`;

  return svgWrap(w, h, dialPanel(w, h, colors) + text);
}

/** The strip's small top-line title — the mode name, drawn on every live strip (issue #803). */
function titleLine(w: number, h: number, title: string, colors: DialBoxColors): string {
  return `<text x="${w / 2}" y="${Math.round(h * 0.2)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="13" font-weight="bold" opacity="0.85">${escapeXml(title)}</text>`;
}

/** Places a glyph centred at (cx, cy), scaled so its longer side fits `size`. */
function placeGlyph(glyph: CarouselGlyph, cx: number, cy: number, size: number, opacity: number): string {
  const scale = size / Math.max(glyph.width, glyph.height);
  const x = cx - (glyph.width * scale) / 2;
  const y = cy - (glyph.height * scale) / 2;
  const op = opacity < 1 ? ` opacity="${opacity}"` : "";

  return `<g transform="translate(${x.toFixed(2)}, ${y.toFixed(2)}) scale(${scale.toFixed(4)})"${op}>${glyph.artwork}</g>`;
}

/**
 * @internal Exported for testing
 *
 * Renders the camera-carousel strip: the mode-name title on top, the current
 * group's icon in the centre with its name beneath, flanked by the smaller
 * dimmed neighbour groups — `left` is the counter-clockwise detent's target,
 * `right` the clockwise one (#884). Driving mode passes both as `null` for
 * a current-only render (no coherent neighbour to preview). Falls back to a
 * centred identity label out of a session (no current group). With `pending`
 * (issue #1120) the centre shows the hold preview instead of the current
 * group; the sides are drawn exactly as without it.
 */
export function renderCameraCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  current: CarouselSlot | null;
  left: CarouselSlot | null;
  right: CarouselSlot | null;
  pending?: DialPendingPreview | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.current && !args.pending) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  // Side slots (dimmed), drawn behind the centre.
  for (const [slot, cx] of [
    [args.left, w * 0.18],
    [args.right, w * 0.82],
  ] as const) {
    if (!slot) continue;

    if (slot.glyph) parts.push(placeGlyph(slot.glyph, cx, h * 0.5, 26, 0.4));
    else
      parts.push(
        `<text x="${cx}" y="${Math.round(h * 0.56)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" opacity="0.4">${escapeXml(slot.name.toUpperCase())}</text>`,
      );
  }

  if (args.pending) {
    parts.push(pendingCentre(w, h, args.pending));
  } else if (args.current) {
    // Centre glyph (if mapped) with the group name beneath it.
    if (args.current.glyph) parts.push(placeGlyph(args.current.glyph, w / 2, h * 0.5, 42, 1));

    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.9)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="14" font-weight="bold">${escapeXml(args.current.name.toUpperCase())}</text>`,
    );
  }

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the sub-camera carousel: the mode-name title on top, the current
 * camera's NAME within the focused group large in the centre, flanked by the
 * smaller dimmed adjacent camera names from the group's `Cameras[]` list —
 * `left` is the counter-clockwise detent's target, `right` the clockwise one
 * (#884). Since #852 the detent taps iRacing's own sub-camera binding, so the
 * sim owns the stepping order and the sides are a guide to the group's camera
 * list rather than a guaranteed landing spot. Falls back to a centred identity
 * label out of a session (no current camera), or to the #612 missing-binding
 * warning when `bindingMissing` is set. With `pending` (issue #1120) the
 * centre shows the hold preview instead of the current camera name.
 */
export function renderSubCameraCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  current: string | null;
  left: string | null;
  right: string | null;
  /** #612 overlay: the Sub-Camera bindings (#852) are unset, so a detent would do nothing. */
  bindingMissing?: boolean;
  pending?: DialPendingPreview | null;
}): string {
  const { width: w, height: h, colors } = args;

  // A pending preview outranks the missing-binding warning for the length of the
  // hold (#1120). That warning is about ROTATION — the Sub-Camera bindings of
  // #852 — while the press gesture being previewed works regardless, so keeping
  // the warning here would compute a preview the strip never draws and then push
  // a revert frame for something nobody saw. The warning is back the moment the
  // hold ends. The car carousel's track-order warning (#1277) follows the same
  // rule.
  if (args.bindingMissing && !args.pending) {
    // Pass the strip canvas: the glyph is authored for the 144×144 key canvas
    // and only recentres/rescales onto the 200×100 strip when it is given
    // (#775) — without it the triangle lands off-centre and clipped.
    return svgWrap(
      w,
      h,
      applyBindingWarning(dialPanel(w, h, colors) + titleLine(w, h, args.title, colors), { width: w, height: h }),
    );
  }

  if (!args.current && !args.pending) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [name, cx] of [
    [args.left, w * 0.15],
    [args.right, w * 0.85],
  ] as const) {
    if (!name) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.52)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" opacity="0.4">${escapeXml(name.toUpperCase())}</text>`,
    );
  }

  if (args.pending) {
    parts.push(pendingCentre(w, h, args.pending));
  } else if (args.current) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.68)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">${escapeXml(args.current.toUpperCase())}</text>`,
    );
  }

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the car carousel strip (shared by the car-number and track-order
 * modes): the mode-name title on top, the focused car's number large in the
 * centre, flanked by the smaller dimmed numbers of the cars one detent away
 * where the mode previews them (car-number: the adjacent cars, #1281;
 * `left` is the counter-clockwise detent's target, `right` the clockwise one,
 * #884; track-order passes no sides, #1277). Falls back to a centred identity
 * label out of a session (no focused car number), or to the #612
 * missing-binding warning when `bindingMissing` is set. With `pending` (issue
 * #1120) the centre shows the hold preview instead of the focused number; the
 * sides are unchanged.
 */
export function renderCarCarousel(
  args: {
    width: number;
    height: number;
    colors: DialBoxColors;
    title: string;
    identityLabel: string;
    /** #612 overlay: track-order's Next / Previous Car bindings (#1277) are unset, so a detent would do nothing. */
    bindingMissing?: boolean;
    pending?: DialPendingPreview | null;
  } & CarCarouselView,
): string {
  const { width: w, height: h, colors } = args;

  // As on the sub-camera strip, a pending preview outranks the warning for the
  // length of the hold (#1120): the warning is about ROTATION, and the press
  // gesture being previewed works regardless.
  if (args.bindingMissing && !args.pending) {
    return svgWrap(
      w,
      h,
      applyBindingWarning(dialPanel(w, h, colors) + titleLine(w, h, args.title, colors), { width: w, height: h }),
    );
  }

  if (!args.center && !args.pending) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [num, cx] of [
    [args.left, w * 0.16],
    [args.right, w * 0.84],
  ] as const) {
    if (!num) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.62)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" opacity="0.45">#${escapeXml(num)}</text>`,
    );
  }

  if (args.pending) {
    parts.push(pendingCentre(w, h, args.pending));
  } else if (args.center) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.72)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">#${escapeXml(args.center)}</text>`,
    );
  }

  return svgWrap(w, h, parts.join(""));
}

/**
 * @internal Exported for testing
 *
 * Renders the race-position carousel strip: the mode-name title on top, the
 * focused car's race POSITION large in the centre (`P<pos>`, the primary
 * readout — issue #803 rework) with its car number smaller beneath it,
 * flanked by the smaller dimmed POSITION previews (the SAME recovery-aware
 * targets the rotation focuses — see `computeRacePositionTarget`; `left` is
 * the counter-clockwise detent's target, `right` the clockwise one, #884).
 * When the focused car has no classified position (the pace / safety car),
 * the centre falls back to a number-only readout rather than a lying `P`
 * badge; the side previews still show the recovery targets. Falls back to a
 * centred identity label out of a session (no focused car number). With
 * `pending` (issue #1120) the centre shows the hold preview instead of the
 * position + number pair; the side positions are unchanged.
 */
export function renderRacePositionCarousel(args: {
  width: number;
  height: number;
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  centerPosition: number | null;
  centerCarNumber: string | null;
  leftPosition: number | null;
  rightPosition: number | null;
  pending?: DialPendingPreview | null;
}): string {
  const { width: w, height: h, colors } = args;

  if (!args.centerCarNumber && !args.pending) return identityBox(w, h, args.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), titleLine(w, h, args.title, colors)];

  for (const [pos, cx] of [
    [args.leftPosition, w * 0.16],
    [args.rightPosition, w * 0.84],
  ] as const) {
    if (pos === null) continue;

    parts.push(
      `<text x="${cx}" y="${Math.round(h * 0.62)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" opacity="0.45">P${pos}</text>`,
    );
  }

  if (args.pending) {
    parts.push(pendingCentre(w, h, args.pending));
  } else if (args.centerCarNumber && args.centerPosition !== null) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.68)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">P${args.centerPosition}</text>`,
    );
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.9)}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="15" font-weight="bold">#${escapeXml(args.centerCarNumber)}</text>`,
    );
  } else if (args.centerCarNumber) {
    parts.push(
      `<text x="${w / 2}" y="${Math.round(h * 0.72)}" text-anchor="middle" fill="${colors.value}" font-family="Arial, sans-serif" font-size="40" font-weight="bold">#${escapeXml(args.centerCarNumber)}</text>`,
    );
  }

  return svgWrap(w, h, parts.join(""));
}

// --- Knob carousel (#1013) ----------------------------------------------------

/** The knob carousel's mode title: the knob dash box's label line (16 px on a top line). */
const KNOB_TITLE_FONT = 16;
const KNOB_TITLE_Y = 28;
/** The centre readout: capped at 44 px and centred on this line, above the bottom row. */
const KNOB_VALUE_CAP = 44;
const KNOB_VALUE_CENTER_Y = 62;
/** The centre glyph (camera modes) and the group name beneath it. */
const KNOB_GLYPH_CY = 52;
const KNOB_GLYPH_SIZE = 40;
const KNOB_GLYPH_NAME_Y = 84;
const KNOB_GLYPH_NAME_CAP = 14;
/** The bottom row: the two detent targets in the corners, and race-position's car number between them. */
const KNOB_SIDE_FONT = 16;
const KNOB_SIDE_GLYPH_SIZE = 24;
const KNOB_SIDE_OPACITY = 0.45;
const KNOB_SUB_FONT = 13;

/**
 * @internal Exported for testing
 *
 * What the knob carousel draws, resolved from the same per-mode view the strip
 * carousels draw: the centre target (a glyph with its name beneath for the
 * camera modes, a secondary line beneath for race-position) and the two detent
 * targets — `left` the counter-clockwise one, `right` the clockwise one (#884)
 * — each a number, or a glyph where the strip shows one. The knob's corners
 * are deliberately simpler than the strip's sides (design gate, #1013): no
 * sub-camera names, only numbers and glyphs.
 */
export interface KnobCarouselView {
  colors: DialBoxColors;
  title: string;
  identityLabel: string;
  centre: { text: string; glyph?: CarouselGlyph | null; sub?: string } | null;
  left: { text: string; glyph?: CarouselGlyph | null } | null;
  right: { text: string; glyph?: CarouselGlyph | null } | null;
  bindingMissing?: boolean;
  pending?: DialPendingPreview | null;
}

/**
 * @internal Exported for testing
 *
 * The knob-screen carousel (#1013): the mode title on the knob dash box's top
 * line, the current target large in the centre (a glyph with its name beneath
 * for the camera modes), and the two detent targets dimmed in the bottom
 * corners, each fitted to its corner so a three-digit number stays legible
 * and clear of the centre and the border — the strip's left/centre/right
 * composed for a screen that is nearly square. With
 * `pending` the centre shows the hold preview; the corners are unchanged. Out
 * of a session (no centre, no preview) the identity label; with
 * `bindingMissing` (and no preview, as on the strip) the #612 warning.
 */
export function renderKnobCarousel(view: KnobCarouselView): string {
  const w = STREAM_DOCK_KNOB_CANVAS.width;
  const h = STREAM_DOCK_KNOB_CANVAS.height;
  const { colors } = view;
  const { inset, strokeWidth } = panelFrame(w, h);
  const font = 'font-family="Arial, sans-serif" font-weight="bold"';
  const title = `<text x="${w / 2}" y="${KNOB_TITLE_Y}" text-anchor="middle" fill="${colors.label}" ${font} font-size="${KNOB_TITLE_FONT}">${escapeXml(view.title)}</text>`;

  if (view.bindingMissing && !view.pending) {
    return svgWrap(w, h, applyBindingWarning(dialPanel(w, h, colors) + title, { width: w, height: h }));
  }

  if (!view.centre && !view.pending) return identityBox(w, h, view.identityLabel, colors);

  const parts: string[] = [dialPanel(w, h, colors), title];
  // The bottom row sits just inside the panel's inner edge; the corners hug the sides.
  const rowY = h - 14;
  const edge = inset + strokeWidth + 7;
  // Each corner owns under a third of the row, so the two can never meet in the middle.
  const sideMaxWidth = Math.round(w * 0.3);

  for (const [slot, side] of [
    [view.left, "left"],
    [view.right, "right"],
  ] as const) {
    if (!slot) continue;

    if (slot.glyph) {
      const cx = side === "left" ? edge + KNOB_SIDE_GLYPH_SIZE / 2 : w - edge - KNOB_SIDE_GLYPH_SIZE / 2;
      parts.push(placeGlyph(slot.glyph, cx, rowY - 8, KNOB_SIDE_GLYPH_SIZE, 0.4));
      continue;
    }

    const size = fitValueFontSize(slot.text, sideMaxWidth, KNOB_SIDE_FONT);
    const x = side === "left" ? edge : w - edge;
    const anchor = side === "left" ? "start" : "end";

    parts.push(
      `<text x="${x}" y="${rowY}" text-anchor="${anchor}" fill="${colors.label}" ${font} font-size="${size}" opacity="${KNOB_SIDE_OPACITY}">${escapeXml(slot.text)}</text>`,
    );
  }

  const valueMaxWidth = w - 2 * (inset + strokeWidth + 8);

  if (view.pending) {
    const size = fitValueFontSize(view.pending.text, valueMaxWidth, KNOB_VALUE_CAP);
    const valueY = KNOB_VALUE_CENTER_Y + Math.round(size * 0.36);
    parts.push(
      `<text x="${w / 2}" y="${valueY}" text-anchor="middle" fill="${view.pending.color}" ${font} font-size="${size}">${escapeXml(view.pending.text)}</text>`,
    );
    parts.push(renderPendingBar({ centerX: w / 2, y: valueY + 4, width: w, color: view.pending.color }));
  } else if (view.centre) {
    if (view.centre.glyph) {
      // Between the corner glyphs, so a long group name shrinks rather than overlapping them.
      const nameMaxWidth = w - 2 * (edge + KNOB_SIDE_GLYPH_SIZE + 6);
      const nameSize = fitValueFontSize(view.centre.text, nameMaxWidth, KNOB_GLYPH_NAME_CAP);
      parts.push(placeGlyph(view.centre.glyph, w / 2, KNOB_GLYPH_CY, KNOB_GLYPH_SIZE, 1));
      parts.push(
        `<text x="${w / 2}" y="${KNOB_GLYPH_NAME_Y}" text-anchor="middle" fill="${colors.value}" ${font} font-size="${nameSize}">${escapeXml(view.centre.text)}</text>`,
      );
    } else {
      const size = fitValueFontSize(view.centre.text, valueMaxWidth, KNOB_VALUE_CAP);
      const valueY = KNOB_VALUE_CENTER_Y + Math.round(size * 0.36);
      parts.push(
        `<text x="${w / 2}" y="${valueY}" text-anchor="middle" fill="${colors.value}" ${font} font-size="${size}">${escapeXml(view.centre.text)}</text>`,
      );

      if (view.centre.sub) {
        parts.push(
          `<text x="${w / 2}" y="${rowY}" text-anchor="middle" fill="${colors.label}" ${font} font-size="${KNOB_SUB_FONT}">${escapeXml(view.centre.sub)}</text>`,
        );
      }
    }
  }

  return svgWrap(w, h, parts.join(""));
}
