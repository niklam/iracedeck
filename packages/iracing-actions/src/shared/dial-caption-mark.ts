/**
 * The dash box's caption mark (#1437): the replay busy look as the dial box
 * shows it, at the left end of the caption line and at the caption's own
 * height — three small dots with the lit one stepping across for working,
 * three even still dots for waiting, a small red cross for not done.
 *
 * One drawing for both canvases, like the side markers, so the strip and the
 * knob cannot drift into different marks; each renderer passes its own caption
 * geometry and builds its own caption `<text>`, so a box with no mark keeps
 * the bytes it had before the mark existed.
 *
 * Built only from `circle`, `line` and opacity (no filter, mask, clipPath or
 * style), so the mark reads the same with the `pngRasterization` kill-switch
 * off. Spec: docs/superpowers/specs/2026-10-13-issue-1437-replay-key-busy-look.md.
 */
/**
 * What the mark shows. `position` is the lit dot of the working mark, left to
 * right: `replayBusyDialMark` (`replay-busy-mark.ts`) derives it from the indicator's
 * tick as `Math.floor(tick / 2) % 3`, so the mark steps on every second tick.
 */
export type DialCaptionMarkLook =
  | { readonly kind: "working"; readonly position: 0 | 1 | 2 }
  | { readonly kind: "waiting" }
  | { readonly kind: "not-done" };

/**
 * A caption mark. `replacesCaption` makes the mark stand in for the caption's
 * text: the text is not drawn, but the box keeps the layout the caption set, so
 * the value does not move while the mark shows (a play-state caption giving way
 * to the mark). Without it the caption's text is drawn beside the mark.
 */
export type DialCaptionMark = DialCaptionMarkLook & { readonly replacesCaption?: boolean };

/**
 * The not-done cross's red — deck-core's `BUSY_NOT_DONE_COLOR`, which a test
 * pins this to. A literal rather than an import: every dial-surface test mocks
 * `@iracedeck/deck-core` with only what it uses, and a read of a name the mock
 * lacks throws.
 *
 * @internal Exported for testing
 */
export const DIAL_NOT_DONE_COLOR = "#e74c3c";

/** Opacity of the two unlit working dots. */
const UNLIT_OPACITY = 0.3;

/** The caption line a renderer hands the mark. */
export interface CaptionLine {
  /** The box's width; the caption is centred on `width / 2`. */
  width: number;
  /** The caption's baseline. */
  baselineY: number;
  /** The caption's font size. */
  fontSize: number;
  /** The x the mark's left edge sits at; the caption's text keeps the same distance from the right edge. */
  left: number;
  /** The dots' colour: the caption's (the label colour). */
  color: string;
}

/** Where a caption's text goes on a line that carries a mark. */
export interface MarkedCaption {
  /** The mark's SVG fragment. */
  mark: string;
  /** The text's centre (`text-anchor="middle"`). */
  textX: number;
  /** The text's font size: the caption's own unless the text had to shrink to fit beside the mark. */
  textFontSize: number;
}

/** Two decimals, with no negative zero, so equal geometry is equal text. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;

  return rounded === 0 ? 0 : rounded;
}

/** The mark's geometry on a caption line: its dots, its width and its vertical centre. */
function markGeometry(line: CaptionLine): { r: number; spacing: number; width: number; cy: number } {
  const r = Math.max(1.5, Math.round(line.fontSize * 0.4) / 2);
  const spacing = Math.round(line.fontSize * 0.55);

  // The caption's visual centre: its baseline less half its cap height (~0.72 em for bold Arial).
  return { r, spacing, width: 2 * spacing + 2 * r, cy: line.baselineY - Math.round(line.fontSize * 0.36) };
}

function markSvg(look: DialCaptionMarkLook, line: CaptionLine): string {
  const { r, spacing, width, cy } = markGeometry(line);

  if (look.kind === "not-done") {
    const cx = line.left + width / 2;
    const half = Math.round(line.fontSize * 0.28);
    const stroke = `stroke="${DIAL_NOT_DONE_COLOR}" stroke-width="${Math.max(1.5, Math.round(line.fontSize * 0.15))}" stroke-linecap="round"`;
    const [x1, x2, y1, y2] = [cx - half, cx + half, cy - half, cy + half].map(round);

    return (
      `<g data-caption-mark="not-done">` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}/>` +
      `<line x1="${x1}" y1="${y2}" x2="${x2}" y2="${y1}" ${stroke}/>` +
      `</g>`
    );
  }

  const dots = [0, 1, 2].map((i) => {
    const cx = round(line.left + r + i * spacing);
    const dim = look.kind === "working" && look.position !== i ? ` opacity="${UNLIT_OPACITY}"` : "";

    return `<circle cx="${cx}" cy="${round(cy)}" r="${round(r)}" fill="${line.color}"${dim}/>`;
  });

  return `<g data-caption-mark="${look.kind}">${dots.join("")}</g>`;
}

/**
 * Draws the mark at the left end of the caption line and places the caption's
 * text beside it. The text stays centred on the box when it clears the mark;
 * otherwise it moves right just far enough, and shrinks only when it would then
 * cross the right edge (the same distance in from it as the mark is from the
 * left). Text width is the same ~0.6 em estimate the value fit uses.
 */
export function placeMarkedCaption(look: DialCaptionMarkLook, text: string, line: CaptionLine): MarkedCaption {
  const { width: markWidth } = markGeometry(line);
  const mark = markSvg(look, line);
  const centre = line.width / 2;
  const textLeft = line.left + markWidth + Math.round(line.fontSize * 0.4);
  const textRight = line.width - line.left;
  const textWidth = text.length * 0.6 * line.fontSize;

  if (centre - textWidth / 2 >= textLeft) return { mark, textX: centre, textFontSize: line.fontSize };

  if (textLeft + textWidth <= textRight) {
    return { mark, textX: round(textLeft + textWidth / 2), textFontSize: line.fontSize };
  }

  return {
    mark,
    textX: round((textLeft + textRight) / 2),
    // Rounded down, so the shrunk text never reaches past the room it was fitted to.
    textFontSize: Math.min(line.fontSize, Math.floor((textRight - textLeft) / (text.length * 0.6))),
  };
}
