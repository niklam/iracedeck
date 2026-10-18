import type { DialBoxArgs, DialBoxColors } from "./dial-box.js";

/**
 * Representative `renderDialBox` inputs, one per shape the dash-box surfaces
 * hand it today, each drawn on both canvases. `__fixtures__/dial-box-baseline.json`
 * holds the exact markup the renderers produced for each BEFORE the box grew
 * its `neighbours` slot and its `reserveCaptionLine` flag (#801), and
 * `dial-box-baseline.test.ts` asserts that a box passing neither still draws
 * those bytes. The caption mark's shapes (#1437) are a list of their own below,
 * in the same fixture. Add a case only together with a re-capture from a
 * renderer known to be right, and say why in the commit.
 */
const ACCENT: DialBoxColors = { border: "#e74c3c", label: "#e74c3c", value: "#e74c3c", background: "#0d0d0d" };
const CUSTOM: DialBoxColors = { border: "#111111", label: "#222222", value: "#333333", background: "#444444" };
const AMBER = { text: "RR", color: "#f39c12" };

/** One shape: its name, and the arguments every canvas draws it with. */
export interface DialBoxBaselineShape {
  readonly name: string;
  readonly args: DialBoxArgs;
}

export const DIAL_BOX_BASELINE_SHAPES: readonly DialBoxBaselineShape[] = [
  // The Setup dials, Cockpit Misc, Force Feedback, View Adjustment, Splits & Reference.
  { name: "value", args: { abbr: "BB", value: "62.2", colors: ACCENT } },
  { name: "short value", args: { abbr: "ABS", value: "3", colors: ACCENT } },
  { name: "long value", args: { abbr: "BB", value: "1234.5", colors: ACCENT } },
  { name: "wide value", args: { abbr: "SPR", value: "3 mm", colors: ACCENT } },
  { name: "custom colors", args: { abbr: "BB", value: "62.2", colors: CUSTOM } },
  { name: "identity", args: { abbr: "QUAL", value: "", colors: ACCENT } },
  { name: "identity 0.24", args: { abbr: "MIX", value: "", colors: ACCENT, identityLabelScale: 0.24 } },
  { name: "identity 0.22", args: { abbr: "BUMP", value: "", colors: ACCENT, identityLabelScale: 0.22 } },
  { name: "identity 0.18", args: { abbr: "FOCUS", value: "", colors: ACCENT, identityLabelScale: 0.18 } },
  { name: "binding missing", args: { abbr: "ABS", value: "3", colors: ACCENT, bindingMissing: true } },
  // Setup Chassis' spring dials (#953).
  { name: "side left", args: { abbr: "LR SPR", value: "3 mm", colors: ACCENT, sideMarker: "left" } },
  { name: "side right", args: { abbr: "RR SPR", value: "3 mm", colors: ACCENT, sideMarker: "right" } },
  // Replay Markers and Replay Control (#1230, #801).
  { name: "sides both", args: { abbr: "SPEED", value: "1x", colors: ACCENT, sideMarker: { left: true, right: true } } },
  { name: "sides none", args: { abbr: "MARK", value: "3", colors: ACCENT, sideMarker: { left: false, right: false } } },
  { name: "sides one", args: { abbr: "MARK", value: "3", colors: ACCENT, sideMarker: { left: true, right: false } } },
  {
    name: "caption",
    args: {
      abbr: "LAP",
      value: "12/25",
      colors: ACCENT,
      sideMarker: { left: true, right: false },
      caption: "60:05",
      dimmed: false,
      pending: null,
    },
  },
  {
    name: "caption play state",
    args: { abbr: "SPEED", value: "0x", colors: ACCENT, sideMarker: { left: true, right: true }, caption: "► 1x" },
  },
  {
    name: "caption long value",
    args: {
      abbr: "SESSION",
      value: "QUALIFY",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      caption: "3/8",
    },
  },
  {
    name: "blank caption",
    args: { abbr: "INCIDENT", value: "60:05", colors: ACCENT, sideMarker: { left: true, right: true }, caption: " " },
  },
  {
    name: "blank caption car",
    args: { abbr: "TRACK ORDER", value: "#12", colors: ACCENT, sideMarker: { left: true, right: true }, caption: " " },
  },
  {
    name: "blank caption identity",
    args: { abbr: "TRACK ORDER", value: "", colors: ACCENT, sideMarker: { left: true, right: true }, caption: " " },
  },
  { name: "caption identity", args: { abbr: "MARK", value: "", colors: ACCENT, caption: "ADD -10s" } },
  {
    name: "caption binding missing",
    args: {
      abbr: "TRACK ORDER",
      value: "#12",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      caption: "#5 #42",
      bindingMissing: true,
    },
  },
  {
    name: "caption pending",
    args: { abbr: "LAP", value: "12/25", colors: ACCENT, caption: "+3", pending: AMBER },
  },
  {
    name: "caption pending identity",
    args: { abbr: "MARK", value: "", colors: ACCENT, caption: "+3", pending: AMBER },
  },
  // Out of a replay, no store, no telemetry (#1230).
  {
    name: "dimmed identity",
    args: { abbr: "SPEED", value: "", colors: ACCENT, caption: "", dimmed: true, pending: null },
  },
  {
    name: "dimmed value",
    args: { abbr: "MARK", value: "3", colors: ACCENT, sideMarker: { left: false, right: false }, dimmed: true },
  },
  { name: "dimmed caption", args: { abbr: "MARK", value: "", colors: ACCENT, caption: "ADD -10s", dimmed: true } },
  // The hold preview (#1120).
  { name: "pending", args: { abbr: "SPR", value: "+3", colors: ACCENT, pending: AMBER } },
  {
    name: "pending identity",
    args: { abbr: "SPR", value: "", colors: ACCENT, pending: { text: "LR", color: "#e74c3c" } },
  },
  {
    name: "pending binding missing",
    args: { abbr: "SPR", value: "+3", colors: ACCENT, pending: AMBER, bindingMissing: true },
  },
  {
    name: "pending sides",
    args: { abbr: "SPEED", value: "1x", colors: ACCENT, sideMarker: { left: true, right: true }, pending: AMBER },
  },
];

/**
 * The replay busy look's caption mark (#1437), one entry per way the replay
 * dials pass it, each drawn on both canvases and held in the same fixture.
 * The first four (the mark alone, beside a caption, beside the pending count,
 * on a reserved line in place of the play state) are byte for byte what the
 * mark drew when the maintainer tested it, before #801's `reserveCaptionLine`
 * took over from the mark's own `replacesCaption`; the last two add #801's
 * neighbours and the dimmed box. A change to the mark's drawing re-captures
 * these entries and says why in the commit; the shapes above never take a mark.
 */
export const DIAL_BOX_MARK_BASELINE_SHAPES: readonly DialBoxBaselineShape[] = [
  // Replay Markers' detent jump with no caption, and Replay Control's Incident with no count.
  {
    name: "mark alone",
    args: {
      abbr: "MARKERS",
      value: "3 / 12",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      captionMark: { kind: "working", position: 1 },
    },
  },
  // Replay Markers' Add caption, from the car, keeps its place beside the mark.
  {
    name: "mark beside caption",
    args: {
      abbr: "MARKERS",
      value: "3 / 12",
      colors: ACCENT,
      sideMarker: { left: true, right: false },
      caption: "ADD -5 s",
      captionMark: { kind: "not-done" },
    },
  },
  // #801's pending count stays beside the mark.
  {
    name: "mark beside count",
    args: {
      abbr: "INCIDENT",
      value: "60:05",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      caption: "+3",
      reserveCaptionLine: true,
      captionMark: { kind: "working", position: 0 },
    },
  },
  // Speed Control's play state gives way to the mark, its line kept.
  {
    name: "mark on reserved line",
    args: {
      abbr: "SPEED",
      value: "0x",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      caption: "",
      reserveCaptionLine: true,
      dimmed: false,
      pending: null,
      captionMark: { kind: "waiting" },
    },
  },
  // Track Order's neighbours on the value line, the mark on the caption line.
  {
    name: "mark with neighbours",
    args: {
      abbr: "TRK ORD",
      value: "#12",
      colors: ACCENT,
      sideMarker: { left: true, right: true },
      caption: "",
      reserveCaptionLine: true,
      neighbours: { left: "#5", right: "#42" },
      captionMark: { kind: "working", position: 2 },
    },
  },
  // Out of the replay: the whole box dims, the mark with it.
  {
    name: "mark dimmed",
    args: {
      abbr: "SPEED",
      value: "",
      colors: ACCENT,
      caption: "",
      dimmed: true,
      pending: null,
      captionMark: { kind: "not-done" },
    },
  },
];

/** The canvases every shape is drawn on, as `renderDialBox` is handed them. */
export const DIAL_BOX_BASELINE_CANVASES = [
  { id: "sd-plus-strip", width: 200, height: 100 },
  { id: "stream-dock-knob", width: 176, height: 112 },
] as const;

/** The fixture key of one shape on one canvas. */
export function dialBoxBaselineKey(canvasId: string, shapeName: string): string {
  return `${canvasId} / ${shapeName}`;
}
