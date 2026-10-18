import type { DialBoxArgs, DialBoxColors } from "./dial-box.js";

/**
 * Representative `renderDialBox` inputs, one per shape the dash-box surfaces
 * hand it today, each drawn on both canvases. `__fixtures__/dial-box-baseline.json`
 * holds the exact markup the renderers produced for each BEFORE the box grew
 * its `neighbours` slot and its `reserveCaptionLine` flag (#801), and
 * `dial-box-baseline.test.ts` asserts that a box passing neither still draws
 * those bytes. Add a case here only together with a re-capture from a renderer
 * known to be right, and say why in the commit.
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

/** The canvases every shape is drawn on, as `renderDialBox` is handed them. */
export const DIAL_BOX_BASELINE_CANVASES = [
  { id: "sd-plus-strip", width: 200, height: 100 },
  { id: "stream-dock-knob", width: 176, height: 112 },
] as const;

/** The fixture key of one shape on one canvas. */
export function dialBoxBaselineKey(canvasId: string, shapeName: string): string {
  return `${canvasId} / ${shapeName}`;
}
