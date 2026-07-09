import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  DIAL_BOX_BACKGROUND,
  DIAL_GLOW_WIDTH_DEFAULT,
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

const NO_GLOW = { enabled: false, width: DIAL_GLOW_WIDTH_DEFAULT };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderDialBox", () => {
  it("draws the abbreviation, value, accent border, and dark background by default", () => {
    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: accentColors(),
      glow: NO_GLOW,
    });

    expect(svg).toContain(DIAL_BOX_BACKGROUND);
    expect(svg).toContain(`stroke="${ACCENT}"`);
    expect(svg).toContain(`fill="${ACCENT}"`);
    expect(svg).toContain(">BB<");
    expect(svg).toContain(">62.2<");
  });

  it("fills the background INSIDE the border and leaves the outer margin unfilled", () => {
    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: accentColors(),
      glow: NO_GLOW,
    });

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
      glow: NO_GLOW,
    });

    // Panel: background fill + border stroke.
    expect(svg).toMatch(/<rect x="5" y="5"[^>]*fill="#444444"[^>]*stroke="#111111"[^>]*\/>/);
    // Label text uses the label color.
    expect(svg).toMatch(/<text[^>]*fill="#222222"[^>]*>BB<\/text>/);
    // Value text uses the value color.
    expect(svg).toMatch(/<text[^>]*fill="#333333"[^>]*>62\.2<\/text>/);
  });

  it("adds a blurred glow in the border color when glow is enabled", () => {
    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: accentColors(),
      glow: { enabled: true, width: 12 },
    });

    expect(svg).toContain("feGaussianBlur");
    expect(svg).toContain('filter="url(#ird-dial-glow)"');
    // The glow rect strokes the border color at the requested width.
    expect(svg).toMatch(/<rect[^>]*stroke="#e74c3c"[^>]*stroke-width="12"[^>]*filter="url\(#ird-dial-glow\)"/);
  });

  it("omits the glow when the border-glow feature flag is off (Mirabox/Ulanzi)", () => {
    vi.stubGlobal("__FEATURE_BORDER_GLOW__", false);

    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: accentColors(),
      glow: { enabled: true, width: 12 },
    });

    expect(svg).not.toContain("feGaussianBlur");
  });

  it("omits the glow when glow is disabled", () => {
    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "BB",
      value: "62.2",
      colors: accentColors(),
      glow: NO_GLOW,
    });

    expect(svg).not.toContain("feGaussianBlur");
  });

  it("draws only the centered label for an identity-only (valueless) setting", () => {
    const svg = renderDialBox({
      width: 200,
      height: 100,
      abbr: "QUAL",
      value: "",
      colors: accentColors(),
      glow: NO_GLOW,
    });

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
      glow: NO_GLOW,
      identityLabelScale: 0.22,
    });

    expect(svg).toMatch(/font-size="22"[^>]*>BUMP</);
  });

  it("shrinks the value font so a longer value fits inside a smaller one", () => {
    const long = /font-size="(\d+)"[^>]*>1234\.5</.exec(
      renderDialBox({ width: 200, height: 100, abbr: "BB", value: "1234.5", colors: accentColors(), glow: NO_GLOW }),
    );
    const short = /font-size="(\d+)"[^>]*>3</.exec(
      renderDialBox({ width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors(), glow: NO_GLOW }),
    );

    expect(long).not.toBeNull();
    expect(short).not.toBeNull();
    expect(Number(long![1])).toBeLessThan(Number(short![1]));
  });

  it("draws the #612 warning overlay only when bindingMissing is set", () => {
    const base = { width: 200, height: 100, abbr: "ABS", value: "3", colors: accentColors(), glow: NO_GLOW } as const;

    expect(renderDialBox(base)).not.toContain("binding-warning");
    expect(renderDialBox({ ...base, bindingMissing: true })).toContain("binding-warning");
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
    expect(resolveDialBoxColors({ border: "", label: "", value: "", background: "" }, ACCENT)).toEqual(accentColors());
  });

  it("applies only the overridden slots", () => {
    expect(resolveDialBoxColors({ background: "#001122", value: "#00ff00" }, ACCENT)).toEqual({
      border: ACCENT,
      label: ACCENT,
      value: "#00ff00",
      background: "#001122",
    });
  });
});

describe("dialAppearanceFields", () => {
  const Schema = z.object({ ...dialAppearanceFields }).prefault({});

  it("defaults to empty color overrides, glow off, and the default glow width", () => {
    expect(Schema.parse({})).toEqual({
      colors: { border: "", label: "", value: "", background: "" },
      glow: false,
      glowWidth: DIAL_GLOW_WIDTH_DEFAULT,
    });
  });

  it("parses real overrides through", () => {
    const parsed = Schema.parse({
      colors: { border: "#111111", label: "#222222", value: "#333333", background: "#444444" },
      glow: true,
      glowWidth: 20,
    });

    expect(parsed.colors.background).toBe("#444444");
    expect(parsed.glow).toBe(true);
    expect(parsed.glowWidth).toBe(20);
  });

  it("coerces a string checkbox/glow-width value", () => {
    const parsed = Schema.parse({ glow: "true", glowWidth: "18" });

    expect(parsed.glow).toBe(true);
    expect(parsed.glowWidth).toBe(18);
  });

  it("degrades malformed values to defaults instead of throwing", () => {
    const parsed = Schema.parse({ colors: { border: 42 }, glow: { nope: 1 }, glowWidth: "abc" });

    expect(parsed.colors.border).toBe("");
    expect(parsed.glow).toBe(false);
    expect(parsed.glowWidth).toBe(DIAL_GLOW_WIDTH_DEFAULT);
  });
});
