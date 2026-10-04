import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DIAL_BOX_BACKGROUND, type DialBoxColors, renderDialBox, resolveDialBoxColors } from "./dial-box.js";
import { STRIP_BOX_FIXTURE_CASES } from "./dial-strip-box.fixture-cases.js";
import { renderStripBox } from "./dial-strip-box.js";

vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;
const FIXTURE = JSON.parse(
  readFileSync(new URL("./__fixtures__/dial-strip-box.json", import.meta.url), "utf-8"),
) as string[];
const ACCENT = "#e74c3c";

/** Default (no override) resolved colors for the given accent. */
function accentColors(accent = ACCENT): DialBoxColors {
  return { border: accent, label: accent, value: accent, background: DIAL_BOX_BACKGROUND };
}

describe("renderStripBox is byte-identical to the pre-#1013 renderDialBox", () => {
  it("has one fixture per case", () => {
    expect(FIXTURE).toHaveLength(STRIP_BOX_FIXTURE_CASES.length);
  });

  it.each(STRIP_BOX_FIXTURE_CASES.map((c, i) => [i, c] as const))("case %i", (i, c) => {
    expect(renderStripBox(c)).toBe(FIXTURE[i]);
  });

  it.each(
    STRIP_BOX_FIXTURE_CASES.map((c, i) => [i, c] as const).filter(([, c]) => c.width === 200 && c.height === 100),
  )("case %i through the dispatcher at the strip profile", (i, c) => {
    const { width: _w, height: _h, ...args } = c;

    expect(renderDialBox(STRIP, args)).toBe(FIXTURE[i]);
  });
});

describe("renderStripBox", () => {
  it("draws the abbreviation, value, accent border, and dark background by default", () => {
    const svg = renderStripBox({ width: 200, height: 100, abbr: "BB", value: "62.2", colors: accentColors() });

    expect(svg).toContain(DIAL_BOX_BACKGROUND);
    expect(svg).toContain(`stroke="${ACCENT}"`);
    expect(svg).toContain(`fill="${ACCENT}"`);
    expect(svg).toContain(">BB<");
    expect(svg).toContain(">62.2<");
  });

  it("fills the background INSIDE the border and leaves the outer margin unfilled", () => {
    const svg = renderStripBox({ width: 200, height: 100, abbr: "BB", value: "62.2", colors: accentColors() });

    // The background+border share one inset rect (x/y = 5 on a 200x100 cell),
    // so the panel floats on the device-black margin...
    expect(svg).toMatch(/<rect x="5" y="5"[^>]*fill="#0d0d0d"[^>]*stroke="#e74c3c"[^>]*\/>/);
    // ...and there is NO full-cell background rect painting the margin.
    expect(svg).not.toMatch(/<rect x="0" y="0" width="200" height="100"[^>]*fill=/);
  });

  it("colors the border, label, and value independently", () => {
    const svg = renderStripBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: { border: "#111111", label: "#222222", value: "#333333", background: "#444444" },
    });

    // Panel: background fill + border stroke.
    expect(svg).toMatch(/<rect x="5" y="5"[^>]*fill="#444444"[^>]*stroke="#111111"[^>]*\/>/);
    // Label text uses the label color.
    expect(svg).toMatch(/<text[^>]*fill="#222222"[^>]*>BB<\/text>/);
    // Value text uses the value color.
    expect(svg).toMatch(/<text[^>]*fill="#333333"[^>]*>62\.2<\/text>/);
  });

  it("draws only the centered label for an identity-only (valueless) setting", () => {
    const svg = renderStripBox({ width: 200, height: 100, abbr: "QUAL", value: "", colors: accentColors() });

    expect(svg).toContain(">QUAL<");
    // Identity-only label is bigger (0.24 * minSide = 24 on a 200x100 cell).
    expect(svg).toMatch(/font-size="24"[^>]*>QUAL</);
    // No value <text> element beyond the single label.
    expect(svg.match(/<text/g)?.length).toBe(1);
  });

  it("honors a per-action identity label scale", () => {
    const svg = renderStripBox({
      width: 200,
      height: 100,
      abbr: "BUMP",
      value: "",
      colors: accentColors(),
      identityLabelScale: 0.22,
    });

    expect(svg).toMatch(/font-size="22"[^>]*>BUMP</);
  });

  it("baseline-centers the identity-only label instead of anchoring it above center (#804)", () => {
    // <text> y is the baseline and resvg ignores dominant-baseline, so a truly
    // centered label must sit at h*0.5 + round(fontSize*0.36): 50 + round(24*0.36) = 59.
    const svg = renderStripBox({ width: 200, height: 100, abbr: "QUAL", value: "", colors: accentColors() });

    expect(svg).toMatch(/<text[^>]*y="59"[^>]*>QUAL<\/text>/);
  });

  it("shrinks the value font so a longer value fits inside a smaller one", () => {
    const long = /font-size="(\d+)"[^>]*>1234\.5</.exec(
      renderStripBox({ width: 200, height: 100, abbr: "BB", value: "1234.5", colors: accentColors() }),
    );
    const short = /font-size="(\d+)"[^>]*>3</.exec(
      renderStripBox({ width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors() }),
    );

    expect(long).not.toBeNull();
    expect(short).not.toBeNull();
    expect(Number(long![1])).toBeLessThan(Number(short![1]));
  });

  it("draws the #612 warning overlay only when bindingMissing is set", () => {
    const base = { width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors() } as const;

    expect(renderStripBox(base)).not.toContain("binding-warning");
    expect(renderStripBox({ ...base, bindingMissing: true })).toContain("binding-warning");
  });
});

describe("side markers (#953 spring arrows)", () => {
  const base = {
    width: 200,
    height: 100,
    abbr: "LR SPR",
    value: "3 mm",
    colors: { border: "#2ecc71", label: "#2ecc71", value: "#2ecc71", background: "#0d0d0d" },
  };

  it("draws no triangles without a side marker", () => {
    expect(renderStripBox(base)).not.toContain("<polygon");
  });

  it("draws both triangles with the active LEFT side lit and the right side dimmed", () => {
    const svg = renderStripBox({ ...base, sideMarker: "left" });
    const polygons = svg.match(/<polygon[^>]*>/g) ?? [];

    expect(polygons).toHaveLength(2);
    const dimmed = polygons.filter((poly) => poly.includes("opacity"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]).toContain('data-side="right"');
  });

  it("lights the RIGHT triangle for the right marker", () => {
    const svg = renderStripBox({ ...base, sideMarker: "right" });
    const polygons = svg.match(/<polygon[^>]*>/g) ?? [];

    expect(polygons).toHaveLength(2);
    const dimmed = polygons.filter((poly) => poly.includes("opacity"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]).toContain('data-side="left"');
  });

  it("keeps the label centered at the same x with and without markers", () => {
    const plain = renderStripBox(base);
    const marked = renderStripBox({ ...base, sideMarker: "left" });
    const labelX = (svg: string) => /<text x="([\d.]+)"/.exec(svg)?.[1];

    expect(labelX(marked)).toBe(labelX(plain));
  });
});

describe("renderStripBox — pending long-press preview (#1120)", () => {
  const colors = resolveDialBoxColors(undefined, ACCENT);
  const PENDING = { text: "RR", color: "#f39c12" };

  function box(overrides: Partial<Parameters<typeof renderStripBox>[0]> = {}): string {
    return renderStripBox({ width: 200, height: 100, abbr: "SPR", value: "+3", colors, ...overrides });
  }

  it("shows the pending outcome in place of the live value", () => {
    const svg = box({ pending: PENDING });

    expect(svg).toContain(">RR</text>");
    expect(svg).not.toContain(">+3</text>");
  });

  it("colors the pending text with the outcome's own color, not the box value color", () => {
    const svg = box({ pending: PENDING });

    expect(svg).toMatch(/fill="#f39c12"[^>]*>RR<\/text>/);
  });

  it("underlines the pending outcome with the shared pending bar", () => {
    expect(box({ pending: PENDING })).toContain('data-pending-bar="true"');
  });

  it("draws no bar when nothing is pending", () => {
    expect(box()).not.toContain("data-pending-bar");
    expect(box({ pending: null })).not.toContain("data-pending-bar");
  });

  it("keeps the label, so the driver still knows which dial is previewing", () => {
    expect(box({ pending: PENDING })).toContain(">SPR</text>");
  });

  it("lends the value slot to a pending outcome on an identity-only box", () => {
    const svg = box({ value: "", pending: { text: "LR", color: ACCENT } });

    expect(svg).toContain(">LR</text>");
    expect(svg).toContain('data-pending-bar="true"');
    // The label drops back to its label-above-value baseline rather than staying
    // centered, so the borrowed value slot has somewhere to sit.
    expect(svg).toContain(`y="${Math.round(100 * 0.28)}"`);
  });

  it("keeps the pending bar inside the panel at both the strip and a small box size", () => {
    for (const height of [100, 60]) {
      const svg = renderStripBox({ width: 200, height, abbr: "SPR", value: "+3", colors, pending: PENDING });
      const bar = /data-pending-bar="true" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(svg);

      expect(bar).not.toBeNull();

      const [y, barHeight] = [Number(bar?.[2]), Number(bar?.[4])];
      const inset = Math.max(5, Math.round(Math.min(200, height) * 0.045));
      const strokeWidth = Math.max(5, Math.round(Math.min(200, height) * 0.05));

      // Below the panel's inner edge (the border strokes ON the inset rect, so
      // half of it eats into the panel).
      expect(y + barHeight).toBeLessThanOrEqual(height - inset - strokeWidth / 2);
    }
  });

  it("still dims under the #612 warning when the rotation binding is missing", () => {
    const svg = box({ pending: PENDING, bindingMissing: true });

    expect(svg).toContain("<binding-warning/>");
    expect(svg).toContain(">RR</text>");
  });
});

describe("renderStripBox — per-side markers, caption and dim (#1230)", () => {
  const colors = resolveDialBoxColors(undefined, ACCENT);

  function box(overrides: Partial<Parameters<typeof renderStripBox>[0]> = {}): string {
    return renderStripBox({ width: 200, height: 100, abbr: "MARKERS", value: "2 / 5", colors, ...overrides });
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
    expect(box({ sideMarker: { left: true, right: true } }).match(/<polygon/g)).toHaveLength(2);
    expect(dimmedSides(box({ sideMarker: { left: true, right: true } }))).toEqual([]);
    expect(dimmedSides(box({ sideMarker: { left: false, right: false } }))).toEqual(["left", "right"]);
  });

  it("an empty caption draws exactly what no caption draws", () => {
    expect(box({ caption: "" })).toBe(box());
  });

  it("draws the caption along the bottom in the label color", () => {
    const svg = box({ caption: "ADD −5 s" });

    expect(svg).toMatch(
      /<text data-caption="true"[^>]*y="88"[^>]*fill="#e74c3c"[^>]*font-size="13"[^>]*>ADD −5 s<\/text>/,
    );
  });

  it("fits the value smaller and centres it between the label and the caption", () => {
    const plain = /y="(\d+)"[^>]*font-size="(\d+)"[^>]*>3<\/text>/.exec(box({ value: "3" }));
    const captioned = /y="(\d+)"[^>]*font-size="(\d+)"[^>]*>3<\/text>/.exec(box({ value: "3", caption: "ADD −5 s" }));

    expect(Number(captioned![2])).toBeLessThan(Number(plain![2]));
    expect(Number(captioned![2])).toBe(40);
    // Label baseline 28, caption top 88 − round(13 × 0.72) = 79 → centre 54; baseline = 54 + round(40 × 0.36).
    expect(Number(captioned![1])).toBe(54 + 14);
  });

  it("keeps the pending mark above the caption", () => {
    const svg = box({ value: "3", caption: "ADD −5 s", pending: { text: "DELETE", color: "#f39c12" } });
    const bar = /data-pending-bar="true" x="\d+" y="(\d+)" width="\d+" height="(\d+)"/.exec(svg);

    expect(Number(bar![1]) + Number(bar![2])).toBeLessThan(79);
  });

  it("centres an identity-only label above the caption", () => {
    const svg = box({ value: "", caption: "ADD −5 s" });

    // round((5 + 79) / 2) = 42, + round(24 × 0.36) = 9.
    expect(svg).toMatch(/<text x="100" y="51"[^>]*>MARKERS<\/text>/);
  });

  it("dims the whole box, panel included, only when asked", () => {
    expect(box()).not.toContain("data-dimmed");

    const svg = box({ dimmed: true });

    expect(svg).toMatch(/^<svg[^>]*><g data-dimmed="true" opacity="0\.35"><rect x="5" y="5"/);
    expect(svg).toMatch(/<\/g><\/svg>$/);
  });
});
