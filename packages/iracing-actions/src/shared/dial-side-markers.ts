/**
 * The dash box's side markers: two fixed triangles flanking the label, each
 * lit or dimmed. #953 lit exactly one (the LR/RR spring the dial adjusts);
 * #1230 lights any combination — the Replay Markers dial lights the sides a
 * turn would jump towards, so neither, either or both can be lit.
 *
 * One drawing for both canvases, so the strip and the knob cannot drift into
 * different triangles; each renderer passes its own label geometry.
 */

/** Which of the two side markers are lit. A dimmed marker is still drawn, at low opacity. */
export interface DialSideMarks {
  left: boolean;
  right: boolean;
}

/**
 * What a caller hands `renderDialBox`'s `sideMarker`: one lit side (`"left"` /
 * `"right"`, the other dimmed — the #953 form), or each side's state.
 */
export type DialSideMarker = "left" | "right" | DialSideMarks;

/** The lit state of each side for a `sideMarker` value. */
export function resolveSideMarks(sideMarker: DialSideMarker): DialSideMarks {
  if (sideMarker === "left") return { left: true, right: false };

  if (sideMarker === "right") return { left: false, right: true };

  return sideMarker;
}

const DIM = ' opacity="0.22"';

/**
 * Draws both side markers, vertically centred on the label: each triangle is
 * 0.9 em tall, 0.3 of the box width out from the centre, pointing outwards.
 */
export function renderSideMarkers(args: {
  width: number;
  labelY: number;
  labelFontSize: number;
  color: string;
  marks: DialSideMarks;
}): string {
  const { width: w, labelY, labelFontSize, color, marks } = args;
  const markerH = Math.round(labelFontSize * 0.9);
  const markerW = Math.round(markerH * 0.7);
  // The label's visual center (its baseline minus the ~0.36em bold-Arial offset).
  const cy = labelY - Math.round(labelFontSize * 0.36);
  const offset = Math.round(w * 0.3);
  const leftCx = w / 2 - offset;
  const rightCx = w / 2 + offset;
  const leftPoints = `${leftCx - markerW / 2},${cy} ${leftCx + markerW / 2},${cy - markerH / 2} ${leftCx + markerW / 2},${cy + markerH / 2}`;
  const rightPoints = `${rightCx + markerW / 2},${cy} ${rightCx - markerW / 2},${cy - markerH / 2} ${rightCx - markerW / 2},${cy + markerH / 2}`;

  return (
    `<polygon data-side="left" points="${leftPoints}" fill="${color}"${marks.left ? "" : DIM}/>` +
    `<polygon data-side="right" points="${rightPoints}" fill="${color}"${marks.right ? "" : DIM}/>`
  );
}
