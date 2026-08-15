import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DIAL_BOX_BACKGROUND,
  dialAppearanceFields,
  type DialBoxColors,
  renderDialBox,
  resolveDialBoxColors,
} from "./dial-box.js";

// The dash box's only deck-core dependency is the #612 warning overlay; stub it
// with a recognizable marker (same convention as the dial-surface tests).
vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

const ACCENT = "#e74c3c";

/** Default (no override) resolved colors for the given accent. */
function accentColors(accent = ACCENT): DialBoxColors {
  return { border: accent, label: accent, value: accent, background: DIAL_BOX_BACKGROUND };
}

describe("renderDialBox", () => {
  it("draws the abbreviation, value, accent border, and dark background by default", () => {
    const svg = renderDialBox({ width: 200, height: 100, abbr: "BB", value: "62.2", colors: accentColors() });

    expect(svg).toContain(DIAL_BOX_BACKGROUND);
    expect(svg).toContain(`stroke="${ACCENT}"`);
    expect(svg).toContain(`fill="${ACCENT}"`);
    expect(svg).toContain(">BB<");
    expect(svg).toContain(">62.2<");
  });

  it("fills the background INSIDE the border and leaves the outer margin unfilled", () => {
    const svg = renderDialBox({ width: 200, height: 100, abbr: "BB", value: "62.2", colors: accentColors() });

    // The background+border share one inset rect (x/y = 5 on a 200x100 cell),
    // so the panel floats on the device-black margin...
    expect(svg).toMatch(/<rect x="5" y="5"[^>]*fill="#0d0d0d"[^>]*stroke="#e74c3c"[^>]*\/>/);
    // ...and there is NO full-cell background rect painting the margin.
    expect(svg).not.toMatch(/<rect x="0" y="0" width="200" height="100"[^>]*fill=/);
  });

  it("colors the border, label, and value independently", () => {
    const svg = renderDialBox({
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
    const svg = renderDialBox({ width: 200, height: 100, abbr: "QUAL", value: "", colors: accentColors() });

    expect(svg).toContain(">QUAL<");
    // Identity-only label is bigger (0.24 * minSide = 24 on a 200x100 cell).
    expect(svg).toMatch(/font-size="24"[^>]*>QUAL</);
    // No value <text> element beyond the single label.
    expect(svg.match(/<text/g)?.length).toBe(1);
  });

  it("honors a per-action identity label scale", () => {
    const svg = renderDialBox({
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
    const svg = renderDialBox({ width: 200, height: 100, abbr: "QUAL", value: "", colors: accentColors() });

    expect(svg).toMatch(/<text[^>]*y="59"[^>]*>QUAL<\/text>/);
  });

  it("shrinks the value font so a longer value fits inside a smaller one", () => {
    const long = /font-size="(\d+)"[^>]*>1234\.5</.exec(
      renderDialBox({ width: 200, height: 100, abbr: "BB", value: "1234.5", colors: accentColors() }),
    );
    const short = /font-size="(\d+)"[^>]*>3</.exec(
      renderDialBox({ width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors() }),
    );

    expect(long).not.toBeNull();
    expect(short).not.toBeNull();
    expect(Number(long![1])).toBeLessThan(Number(short![1]));
  });

  it("draws the #612 warning overlay only when bindingMissing is set", () => {
    const base = { width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors() } as const;

    expect(renderDialBox(base)).not.toContain("binding-warning");
    expect(renderDialBox({ ...base, bindingMissing: true })).toContain("binding-warning");
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
    expect(renderDialBox(base)).not.toContain("<polygon");
  });

  it("draws both triangles with the active LEFT side lit and the right side dimmed", () => {
    const svg = renderDialBox({ ...base, sideMarker: "left" });
    const polygons = svg.match(/<polygon[^>]*>/g) ?? [];

    expect(polygons).toHaveLength(2);
    const dimmed = polygons.filter((poly) => poly.includes("opacity"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]).toContain('data-side="right"');
  });

  it("lights the RIGHT triangle for the right marker", () => {
    const svg = renderDialBox({ ...base, sideMarker: "right" });
    const polygons = svg.match(/<polygon[^>]*>/g) ?? [];

    expect(polygons).toHaveLength(2);
    const dimmed = polygons.filter((poly) => poly.includes("opacity"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]).toContain('data-side="left"');
  });

  it("keeps the label centered at the same x with and without markers", () => {
    const plain = renderDialBox(base);
    const marked = renderDialBox({ ...base, sideMarker: "left" });
    const labelX = (svg: string) => /<text x="([\d.]+)"/.exec(svg)?.[1];

    expect(labelX(marked)).toBe(labelX(plain));
  });
});

describe("resolveDialBoxColors", () => {
  it("falls back to the accent for border/label/value and the dark default for background", () => {
    expect(resolveDialBoxColors(undefined, ACCENT)).toEqual({
      border: ACCENT,
      label: ACCENT,
      value: ACCENT,
      background: DIAL_BOX_BACKGROUND,
    });
  });

  it("treats empty-string overrides as unset", () => {
    expect(
      resolveDialBoxColors({ borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" }, ACCENT),
    ).toEqual(accentColors());
  });

  it("applies only the overridden slots", () => {
    expect(resolveDialBoxColors({ backgroundColor: "#001122", valueColor: "#00ff00" }, ACCENT)).toEqual({
      border: ACCENT,
      label: ACCENT,
      value: "#00ff00",
      background: "#001122",
    });
  });
});

describe("dialAppearanceFields", () => {
  const Schema = z.object({ ...dialAppearanceFields }).prefault({});

  it("defaults to empty color overrides", () => {
    expect(Schema.parse({})).toEqual({
      colors: { borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" },
    });
  });

  it("parses real overrides through", () => {
    const parsed = Schema.parse({
      colors: { borderColor: "#111111", labelColor: "#222222", valueColor: "#333333", backgroundColor: "#444444" },
    });

    expect(parsed.colors.backgroundColor).toBe("#444444");
    expect(parsed.colors.valueColor).toBe("#333333");
  });

  it("degrades malformed values to defaults instead of throwing", () => {
    const parsed = Schema.parse({ colors: { borderColor: 42 } });

    expect(parsed.colors.borderColor).toBe("");
  });

  it("degrades a non-object colors container to empty overrides", () => {
    const empty = { borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" };

    for (const bad of ["garbage", null, 42]) {
      expect(Schema.parse({ colors: bad }).colors).toEqual(empty);
    }
  });
});
