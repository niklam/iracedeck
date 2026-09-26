import type { DialBoxColors } from "./dial-box.js";

/**
 * Representative `renderDialBox` inputs at the Stream Deck+ strip size, one per
 * shape the twelve dash-box surfaces draw. `__fixtures__/dial-strip-box.json`
 * holds the exact markup today's renderer produced for each, captured BEFORE
 * the strip/knob split (#1013); `dial-strip-box.test.ts` asserts the split
 * renderer still produces those bytes. Add a case here only together with a
 * re-capture, and say why in the commit.
 */
const ACCENT: DialBoxColors = { border: "#e74c3c", label: "#e74c3c", value: "#e74c3c", background: "#0d0d0d" };
const CUSTOM: DialBoxColors = { border: "#111111", label: "#222222", value: "#333333", background: "#444444" };

export const STRIP_BOX_FIXTURE_CASES = [
  { width: 200, height: 100, abbr: "BB", value: "62.2", colors: ACCENT },
  { width: 200, height: 100, abbr: "ABS", value: "3", colors: ACCENT },
  { width: 200, height: 100, abbr: "BB", value: "1234.5", colors: ACCENT },
  { width: 200, height: 100, abbr: "QUAL", value: "", colors: ACCENT },
  { width: 200, height: 100, abbr: "BUMP", value: "", colors: ACCENT, identityLabelScale: 0.22 },
  { width: 200, height: 100, abbr: "BB", value: "62.2", colors: CUSTOM },
  { width: 200, height: 100, abbr: "ABS", value: "3", colors: ACCENT, bindingMissing: true },
  { width: 200, height: 100, abbr: "LR SPR", value: "3 mm", colors: ACCENT, sideMarker: "left" as const },
  { width: 200, height: 100, abbr: "RR SPR", value: "3 mm", colors: ACCENT, sideMarker: "right" as const },
  { width: 200, height: 100, abbr: "SPR", value: "+3", colors: ACCENT, pending: { text: "RR", color: "#f39c12" } },
  { width: 200, height: 100, abbr: "SPR", value: "", colors: ACCENT, pending: { text: "LR", color: "#e74c3c" } },
  {
    width: 200,
    height: 100,
    abbr: "SPR",
    value: "+3",
    colors: ACCENT,
    pending: { text: "RR", color: "#f39c12" },
    bindingMissing: true,
  },
  { width: 200, height: 60, abbr: "SPR", value: "+3", colors: ACCENT, pending: { text: "RR", color: "#f39c12" } },
] as const;
