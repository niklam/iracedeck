/**
 * Black Box Selector — the dial screen's drawing (#1662).
 *
 * The pure renderers of the Black Box Selector dial surface
 * (`black-box-selector-dial-surface.ts`, #808): the static Stream Deck+ strip
 * and Stream Dock knob drawings for each rotation (#1013, #1585), the two
 * Switch Select / Adjust hold-preview strips (#1120), and the dispatch between
 * them. They take the resolved colours and the #612 warning flag and read
 * nothing else, so this module imports no sim package — the website's icon
 * gallery draws its Black Box Selector sample from it.
 */
import { applyBindingWarning, type DialCanvasProfile } from "@iracedeck/deck-core";

import type { DialBoxColors } from "../../shared/dial-box.js";
import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH } from "../../shared/dial-knob-box.js";
import { renderPendingBar } from "../../shared/dial-preview.js";
import type { DialRotation, SwitchableRotation } from "./black-box-selector-dial-surface.js";

/** What every dial-screen drawing takes. */
export interface BlackBoxDrawingArgs {
  colors: DialBoxColors;
  bindingMissing: boolean;
}

/** One drawing of the dial's screen. */
type BlackBoxDrawing = (args: BlackBoxDrawingArgs) => string;

const STRIP_WIDTH = 200;
const STRIP_HEIGHT = 100;

/** The muted opacity of the d-pad key icons' unlit parts, which the arrow screens' centre dot takes. */
const MUTED_OPACITY = 0.35;

/** The stroke the approved d-pad key icons draw their arrows and centre dot with. */
const ARROW_STROKE_WIDTH = 2;

/** The Stream Deck+ strip slot's inset panel, the frame every strip drawing sits in. */
function stripFrame(colors: DialBoxColors): string {
  const inset = 7;

  return `<rect x="${inset}" y="${inset}" width="${STRIP_WIDTH - 2 * inset}" height="${STRIP_HEIGHT - 2 * inset}" rx="10" fill="${colors.background}" stroke="${colors.border}" stroke-width="9"/>`;
}

/**
 * The knob segment's panel: the shared knob box's frame (inset 5, stroke 6,
 * outer radius 18 → rx 13), so Black Box sits in the same frame as every other
 * knob surface.
 */
function knobFrame(colors: DialBoxColors): string {
  const inset = 5;

  return `<rect x="${inset}" y="${inset}" width="${KNOB_BOX_WIDTH - 2 * inset}" height="${KNOB_BOX_HEIGHT - 2 * inset}" rx="13" fill="${colors.background}" stroke="${colors.border}" stroke-width="6"/>`;
}

/**
 * Wraps a drawing's frame and content into the screen's SVG. When the
 * rotation's bindings are not all set, the content dims under the centred #612
 * warning triangle; the frame stays as it is.
 */
function screenSvg(width: number, height: number, frame: string, content: string, bindingMissing: boolean): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    frame +
    `${bindingMissing ? applyBindingWarning(content, { width, height }) : content}</svg>`
  );
}

/** Rounds a coordinate to two decimals, so a drawing's numbers stay short and stable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * A filled arrow triangle centred on (cx, cy), `base` across its base and
 * `depth` from base to apex, drawn as the approved d-pad key icons draw theirs:
 * filled, with a same-colour round-joined stroke.
 */
function arrow(direction: ArrowDirection, cx: number, cy: number, base: number, depth: number, color: string): string {
  const hb = base / 2;
  const hd = depth / 2;
  let points: Array<[number, number]>;

  switch (direction) {
    case "up":
      points = [
        [cx, cy - hd],
        [cx + hb, cy + hd],
        [cx - hb, cy + hd],
      ];
      break;
    case "down":
      points = [
        [cx, cy + hd],
        [cx - hb, cy - hd],
        [cx + hb, cy - hd],
      ];
      break;
    case "left":
      points = [
        [cx - hd, cy],
        [cx + hd, cy - hb],
        [cx + hd, cy + hb],
      ];
      break;
    case "right":
      points = [
        [cx + hd, cy],
        [cx - hd, cy + hb],
        [cx - hd, cy - hb],
      ];
      break;
    default: {
      const unhandled: never = direction;

      throw new Error(`Black Box Selector: no arrow pointing "${String(unhandled)}"`);
    }
  }

  const coords = points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");

  return `<polygon points="${coords}" fill="${color}" stroke="${color}" stroke-width="${ARROW_STROKE_WIDTH}" stroke-linejoin="round"/>`;
}

/** The d-pad's centre toggle, muted: the point the arrow screens' arrows sit around. */
function centreDot(cx: number, cy: number, radius: number, color: string): string {
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(radius)}" fill="${color}" stroke="${color}" stroke-width="${ARROW_STROKE_WIDTH}" opacity="${MUTED_OPACITY}"/>`;
}

/** The BLACK BOX wordmark under the Cycle Black Boxes screen's badge, centred on x. */
function blackBoxText(x: number, baseline: number, size: number, color: string): string {
  return `<text x="${x}" y="${baseline}" text-anchor="middle" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">BLACK BOX</text>`;
}

/**
 * @internal Exported for testing
 *
 * The Cycle Black Boxes strip (`boxes`): the 200×100 touch-strip slot as one
 * self-drawn pixmap, an inset rounded panel with a "BB" badge over the BLACK BOX
 * wordmark — action identity only, since iRacing exposes no open-box readback.
 * Text y values are BASELINES (the deck app's QT renderer ignores
 * dominant-baseline).
 */
export function renderBlackBoxStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const content =
    `<rect x="72" y="20" width="56" height="34" rx="7" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="100" y="45" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="22" font-weight="bold">BB</text>` +
    blackBoxText(100, 78, 17, colors.label);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderBlackBoxStrip} (#1013): the same badge
 * and wordmark, composed for the squarer 176×112 segment — the badge larger and
 * higher, the wordmark on its own line beneath, centred on x.
 */
export function renderBlackBoxKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const content =
    `<rect x="56" y="18" width="64" height="40" rx="8" fill="none" stroke="${colors.border}" stroke-width="3"/>` +
    `<text x="88" y="47" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="26" font-weight="bold">BB</text>` +
    blackBoxText(88, 90, 18, colors.label);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The Select Control strip (`select-control`, #1585): no badge and no word, a
 * large up and down arrow around the d-pad's muted centre dot — the pair the
 * Selected Control key icons light for walking the controls. Arrows take the
 * label colour, as the dial side markers do.
 */
export function renderSelectControlStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("up", 100, 29, 46, 22, c) + centreDot(100, 50, 5, c) + arrow("down", 100, 71, 46, 22, c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The Adjust Control strip (`adjust-control`, #1585): a large left and right
 * arrow around the muted centre dot — the pair the key icons light for
 * changing the selected control.
 */
export function renderAdjustControlStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("left", 66, 50, 48, 30, c) + centreDot(100, 50, 6, c) + arrow("right", 134, 50, 48, 30, c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderSelectControlStrip}, larger for the
 * squarer 176×112 segment.
 */
export function renderSelectControlKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("up", 88, 31, 52, 25, c) + centreDot(88, 56, 6, c) + arrow("down", 88, 81, 52, 25, c);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The knob-screen version of {@link renderAdjustControlStrip}.
 */
export function renderAdjustControlKnob({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content = arrow("left", 52, 56, 52, 32, c) + centreDot(88, 56, 6, c) + arrow("right", 124, 56, 52, 32, c);

  return screenSvg(KNOB_BOX_WIDTH, KNOB_BOX_HEIGHT, knobFrame(colors), content, bindingMissing);
}

/**
 * Top edge of the pending bar on the two hold-preview strips (#1120, #1585):
 * low in the panel, under the arrows, at the same height on both so the mark
 * sits still whichever way the switch goes.
 */
const PENDING_BAR_Y = 77;

/** The shared pending bar, centred under a hold-preview strip's arrows, in their colour. */
function stripPendingBar(color: string): string {
  return renderPendingBar({ centerX: STRIP_WIDTH / 2, y: PENDING_BAR_Y, width: STRIP_WIDTH, color });
}

/**
 * @internal Exported for testing
 *
 * The hold preview of a switch TO Select Control (#1120, #1585), shown while
 * the Long Press is held past the threshold on an Adjust dial: the Select
 * Control strip's up and down arrows around the centre dot, a touch smaller
 * and nudged up, above the shared pending bar. A drawing of its own, so the
 * approved {@link renderSelectControlStrip} stays exactly as it is.
 */
export function renderSelectControlPendingStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content =
    arrow("up", 100, 26, 40, 18, c) +
    centreDot(100, 44.5, 5, c) +
    arrow("down", 100, 63, 40, 18, c) +
    stripPendingBar(c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The hold preview of a switch TO Adjust Control (#1120, #1585), shown while
 * the Long Press is held past the threshold on a Select dial: the Adjust
 * Control strip's left and right arrows around the centre dot, at their own
 * size and nudged up, above the shared pending bar. A drawing of its own, so
 * the approved {@link renderAdjustControlStrip} stays exactly as it is.
 */
export function renderAdjustControlPendingStrip({ colors, bindingMissing }: BlackBoxDrawingArgs): string {
  const c = colors.label;
  const content =
    arrow("left", 66, 43, 48, 30, c) +
    centreDot(100, 43, 6, c) +
    arrow("right", 134, 43, 48, 30, c) +
    stripPendingBar(c);

  return screenSvg(STRIP_WIDTH, STRIP_HEIGHT, stripFrame(colors), content, bindingMissing);
}

/**
 * The strip and knob drawings for what a turn does (#1585) — exhaustive over
 * {@link ROTATIONS}, so a new rotation cannot silently borrow another's screen.
 */
function drawingsFor(rotation: DialRotation): { strip: BlackBoxDrawing; knob: BlackBoxDrawing } {
  switch (rotation) {
    case "boxes":
      return { strip: renderBlackBoxStrip, knob: renderBlackBoxKnob };
    case "select-control":
      return { strip: renderSelectControlStrip, knob: renderSelectControlKnob };
    case "adjust-control":
      return { strip: renderAdjustControlStrip, knob: renderAdjustControlKnob };
    default: {
      const unhandled: never = rotation;

      throw new Error(`Black Box Selector: no drawing for dial rotation "${String(unhandled)}"`);
    }
  }
}

/**
 * The hold-preview strip for a switch to `target` (#1120, #1585) — exhaustive
 * over the two rotations the switch reaches.
 */
function pendingStripFor(target: SwitchableRotation): BlackBoxDrawing {
  switch (target) {
    case "select-control":
      return renderSelectControlPendingStrip;
    case "adjust-control":
      return renderAdjustControlPendingStrip;
    default: {
      const unhandled: never = target;

      throw new Error(`Black Box Selector: no hold preview for dial rotation "${String(unhandled)}"`);
    }
  }
}

/**
 * Picks Black Box's own drawing for the dial's screen and the rotation, or the
 * hold preview of the switch to `pending` while one is showing — exhaustive
 * over the profile ids, like `renderDialBox`, so a new canvas cannot silently
 * get the strip drawing.
 */
export function renderBlackBoxFor(
  canvas: DialCanvasProfile,
  rotation: DialRotation,
  pending: SwitchableRotation | null,
  args: BlackBoxDrawingArgs,
): string {
  const drawings = drawingsFor(rotation);

  switch (canvas.id) {
    case "sd-plus-strip":
      return pending ? pendingStripFor(pending)(args) : drawings.strip(args);
    case "stream-dock-knob":
      // A knob never previews: its press never reports a release, so no hold
      // is armed (NOOP_HOLD_PREVIEW), and showPreview refuses any screen but
      // the strip. `pending` is null here in practice; were it not, the knob
      // would still show its own rotation, never a promise it cannot keep.
      return drawings.knob(args);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`Black Box Selector: no drawing for dial canvas "${String(unhandled)}"`);
    }
  }
}
