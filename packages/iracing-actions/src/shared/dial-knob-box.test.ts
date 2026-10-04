import { describe, expect, it, vi } from "vitest";

import { renderDialBox, resolveDialBoxColors } from "./dial-box.js";
import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH, renderKnobBox } from "./dial-knob-box.js";

vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

const KNOB = { id: "stream-dock-knob", width: 176, height: 112 } as const;
const colors = resolveDialBoxColors(undefined, "#e74c3c");

// Loaded at collection rather than inside the test: the real deck-core barrel is
// slow to import, and under a full-suite run it overran the 5 s per-test timeout.
const { STREAM_DOCK_KNOB_CANVAS } =
  await vi.importActual<typeof import("@iracedeck/deck-core")>("@iracedeck/deck-core");

describe("renderKnobBox (#1013)", () => {
  it("draws at the size of deck-core's stream-dock-knob profile", () => {
    expect({ width: KNOB_BOX_WIDTH, height: KNOB_BOX_HEIGHT }).toEqual({
      width: STREAM_DOCK_KNOB_CANVAS.width,
      height: STREAM_DOCK_KNOB_CANVAS.height,
    });
  });

  it("draws on the 176×112 knob canvas", () => {
    expect(renderKnobBox({ abbr: "MIX", value: "3", colors })).toContain(
      'viewBox="0 0 176 112" width="176" height="112"',
    );
  });

  it("is what the dispatcher picks for the knob profile", () => {
    const args = { abbr: "MIX", value: "3", colors };

    expect(renderDialBox(KNOB, args)).toBe(renderKnobBox(args));
  });

  it("draws a 16 px label line above a value capped at 50 px", () => {
    const svg = renderKnobBox({ abbr: "MIX", value: "3", colors });

    expect(svg).toMatch(/y="28"[^>]*font-size="16">MIX</);
    expect(svg).toMatch(/font-size="50">3</);
  });

  it("caps a wide short value so it clears the border (#1013 design gate)", () => {
    // "3 mm" fit to 138 / (4 × 0.6) = 57.5 before the gate; the cap now binds.
    expect(renderKnobBox({ abbr: "LR SPR", value: "3 mm", colors })).toMatch(/font-size="50">3 mm</);
  });

  it("fits a long value inside the panel", () => {
    const long = /font-size="(\d+)"[^>]*>1234\.5</.exec(renderKnobBox({ abbr: "BB", value: "1234.5", colors }));
    const short = /font-size="(\d+)"[^>]*>3</.exec(renderKnobBox({ abbr: "ABS", value: "3", colors }));

    expect(Number(long![1])).toBeLessThan(Number(short![1]));
  });

  it("centers the value, whatever its size, between the label and the panel's inner bottom edge", () => {
    // Label baseline 28; inner bottom edge 112 − 5 − 6/2 = 104 → centre 66. <text> y is the
    // baseline (resvg ignores dominant-baseline), so the visual centre is y − round(0.36 em).
    for (const value of ["3", "1234.5", "ABS OFF"]) {
      const m = /y="(\d+)"[^>]*font-size="(\d+)">([^<]*)</g;
      const texts = [...renderKnobBox({ abbr: "BB", value, colors }).matchAll(m)];
      const v = texts.find((t) => t[3] === value)!;

      expect(Number(v[1]) - Math.round(Number(v[2]) * 0.36)).toBe(66);
    }
  });

  it("centers an identity-only label by baseline and draws no value", () => {
    const svg = renderKnobBox({ abbr: "QUAL", value: "", colors });

    expect(svg.match(/<text/g)?.length).toBe(1);
    // h*0.5 + round(fontSize*0.36) with fontSize = round(112 * 0.24) = 27 → 56 + 10 = 66
    expect(svg).toMatch(/<text[^>]*y="66"[^>]*>QUAL<\/text>/);
  });

  it("honors identityLabelScale", () => {
    expect(renderKnobBox({ abbr: "BUMP", value: "", colors, identityLabelScale: 0.22 })).toMatch(
      /font-size="25"[^>]*>BUMP</,
    );
  });

  it("fills the panel inside the border and leaves the margin device-black", () => {
    const svg = renderKnobBox({ abbr: "MIX", value: "3", colors });

    expect(svg).toMatch(/<rect x="5" y="5" width="166" height="102"[^>]*fill="#0d0d0d"[^>]*stroke="#e74c3c"/);
    expect(svg).not.toMatch(/<rect x="0" y="0" width="176" height="112"/);
  });

  it("draws both side markers, dimming the inactive one", () => {
    const polys =
      renderKnobBox({ abbr: "LR SPR", value: "3 mm", colors, sideMarker: "left" }).match(/<polygon[^>]*>/g) ?? [];

    expect(polys).toHaveLength(2);
    expect(polys.filter((p) => p.includes("opacity"))[0]).toContain('data-side="right"');
  });

  it("shows the pending outcome with the shared bar, inside the panel", () => {
    const svg = renderKnobBox({ abbr: "SPR", value: "+3", colors, pending: { text: "RR", color: "#f39c12" } });
    const bar = /data-pending-bar="true" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(svg);

    expect(svg).toContain(">RR</text>");
    expect(svg).not.toContain(">+3</text>");
    expect(bar).not.toBeNull();
    expect(Number(bar![2]) + Number(bar![4])).toBeLessThanOrEqual(112 - 5 - 3);
  });

  it("dims under the #612 warning when a binding is missing", () => {
    expect(renderKnobBox({ abbr: "MIX", value: "3", colors, bindingMissing: true })).toContain("<binding-warning/>");
  });
});

describe("renderKnobBox — per-side markers, caption and dim (#1230)", () => {
  function box(overrides: Partial<Parameters<typeof renderKnobBox>[0]> = {}): string {
    return renderKnobBox({ abbr: "MARKERS", value: "2 / 5", colors, ...overrides });
  }

  const dimmedSides = (svg: string): string[] =>
    (svg.match(/<polygon[^>]*>/g) ?? [])
      .filter((p) => p.includes("opacity"))
      .map((p) => /data-side="(\w+)"/.exec(p)?.[1] ?? "");

  it("draws the one-sided forms exactly as the per-side form with one side lit", () => {
    expect(box({ sideMarker: "left" })).toBe(box({ sideMarker: { left: true, right: false } }));
    expect(box({ sideMarker: "right" })).toBe(box({ sideMarker: { left: false, right: true } }));
  });

  it("lights both sides, or neither", () => {
    expect(dimmedSides(box({ sideMarker: { left: true, right: true } }))).toEqual([]);
    expect(dimmedSides(box({ sideMarker: { left: false, right: false } }))).toEqual(["left", "right"]);
  });

  it("an empty caption draws exactly what no caption draws", () => {
    expect(box({ caption: "" })).toBe(box());
  });

  it("draws the caption inside the panel's bottom edge, with the value capped and centred above it", () => {
    const svg = box({ value: "3", caption: "ADD −5 s" });
    const value = /y="(\d+)"[^>]*font-size="(\d+)">3</.exec(svg);

    expect(svg).toMatch(/<text data-caption="true"[^>]*y="99"[^>]*font-size="14">ADD −5 s<\/text>/);
    expect(Number(value![2])).toBe(40);
    // Label baseline 28, caption top 99 − 10 = 89 → centre 59.
    expect(Number(value![1]) - Math.round(Number(value![2]) * 0.36)).toBe(59);
  });

  it("keeps the pending mark above the caption", () => {
    const svg = box({ value: "3", caption: "ADD −5 s", pending: { text: "DELETE", color: "#f39c12" } });
    const bar = /data-pending-bar="true" x="\d+" y="(\d+)" width="\d+" height="(\d+)"/.exec(svg);

    expect(Number(bar![1]) + Number(bar![2])).toBeLessThan(89);
  });

  it("dims the whole box, panel included, only when asked", () => {
    expect(box()).not.toContain("data-dimmed");
    expect(box({ dimmed: true })).toMatch(/^<svg[^>]*><g data-dimmed="true" opacity="0\.35"><rect x="5" y="5"/);
  });
});
