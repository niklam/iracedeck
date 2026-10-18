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
// with a recognizable marker (same convention as the dial-surface tests). The
// drawing cases live beside each renderer: `dial-strip-box.test.ts` and
// `dial-knob-box.test.ts` (#1013).
vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

const ACCENT = "#e74c3c";

/** Default (no override) resolved colors for the given accent. */
function accentColors(accent = ACCENT): DialBoxColors {
  return { border: accent, label: accent, value: accent, background: DIAL_BOX_BACKGROUND };
}

describe("renderDialBox", () => {
  it("routes the strip profile to renderStripBox and the knob profile to renderKnobBox (#1013)", () => {
    const args = { abbr: "BB", value: "62.2", colors: accentColors() };

    expect(renderDialBox({ id: "sd-plus-strip", width: 200, height: 100 }, args)).toContain('viewBox="0 0 200 100"');
    expect(renderDialBox({ id: "stream-dock-knob", width: 176, height: 112 }, args)).toContain('viewBox="0 0 176 112"');
  });

  it("refuses a canvas id it has no renderer for instead of drawing the strip", () => {
    const args = { abbr: "BB", value: "62.2", colors: accentColors() };
    const unknown = { id: "future-dial", width: 100, height: 100 } as unknown as Parameters<typeof renderDialBox>[0];

    expect(() => renderDialBox(unknown, args)).toThrow('no renderer for dial canvas "future-dial"');
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

describe("renderDialBox — a reserved caption line and the value's neighbours (#801)", () => {
  const CANVASES = [
    { id: "sd-plus-strip", width: 200, height: 100 },
    { id: "stream-dock-knob", width: 176, height: 112 },
  ] as const;
  const base = { abbr: "TRK ORD", value: "#12", colors: accentColors(), sideMarker: { left: true, right: true } };
  const withoutCaptionText = (svg: string): string => svg.replace(/<text data-caption[^>]*>[^<]*<\/text>/, "");

  describe.each(CANVASES)("on $id", (canvas) => {
    it("lays the value out as a caption would, and draws no caption text", () => {
      const reserved = renderDialBox(canvas, { ...base, reserveCaptionLine: true });
      const blank = renderDialBox(canvas, { ...base, caption: "\u00a0" });

      expect(reserved).not.toContain("data-caption");
      expect(reserved).toBe(withoutCaptionText(blank));
      expect(reserved).not.toBe(renderDialBox(canvas, base));
    });

    it("places an identity label as a caption would, too", () => {
      const identity = { ...base, value: "" };

      expect(renderDialBox(canvas, { ...identity, reserveCaptionLine: true })).toBe(
        withoutCaptionText(renderDialBox(canvas, { ...identity, caption: "\u00a0" })),
      );
    });

    it("still draws a caption that is set", () => {
      expect(renderDialBox(canvas, { ...base, caption: "+3", reserveCaptionLine: true })).toBe(
        renderDialBox(canvas, { ...base, caption: "+3" }),
      );
    });

    it("draws neither with the flag false and the neighbours null", () => {
      expect(renderDialBox(canvas, { ...base, reserveCaptionLine: false, neighbours: null })).toBe(
        renderDialBox(canvas, base),
      );
    });

    it("flanks the value with its neighbours, smaller and on its baseline, adding nothing else", () => {
      const args = { ...base, reserveCaptionLine: true };
      const svg = renderDialBox(canvas, { ...args, neighbours: { left: "#5", right: "#42" } });
      const value = /<text x="[^"]+" y="(\d+)"[^>]*font-size="(\d+)"[^>]*>#12<\/text>/.exec(svg);
      const flanks = [
        ...svg.matchAll(/<text data-neighbour="(\w+)"[^>]*y="(\d+)"[^>]*font-size="(\d+)"[^>]*>([^<]*)</g),
      ];

      expect(flanks.map((m) => [m[1], m[4]])).toEqual([
        ["left", "#5"],
        ["right", "#42"],
      ]);

      for (const m of flanks) {
        expect(m[2]).toBe(value?.[1]);
        expect(Number(m[3])).toBeLessThan(Number(value?.[2]));
      }

      expect(svg.replace(/<text data-neighbour[^>]*>[^<]*<\/text>/g, "")).toBe(renderDialBox(canvas, args));
    });

    it("draws the neighbours beside a pending preview, and none beside an identity-only box", () => {
      const neighbours = { left: "#5", right: "#42" };

      expect(renderDialBox(canvas, { ...base, neighbours, pending: { text: "1x", color: "#f39c12" } })).toContain(
        "data-neighbour",
      );
      expect(renderDialBox(canvas, { ...base, value: "", neighbours })).not.toContain("data-neighbour");
    });
  });
});

describe("renderDialBox with a caption mark (#1437)", () => {
  const CANVASES = [
    { id: "sd-plus-strip", width: 200, height: 100 },
    { id: "stream-dock-knob", width: 176, height: 112 },
  ] as const;
  const WORKING = { kind: "working", position: 1 } as const;

  /** Everything in the box but its caption line: the panel, the label and the value. */
  function aboveCaption(svg: string): string {
    return svg.replace(/<text data-caption="true"[^>]*>[^<]*<\/text>/, "").replace(/<g data-caption-mark=.*?<\/g>/, "");
  }

  for (const canvas of CANVASES) {
    describe(canvas.id, () => {
      it("draws a pending count and the mark together, the count clear of the mark", () => {
        const svg = renderDialBox(canvas, {
          abbr: "MARKERS",
          value: "3 / 12",
          colors: accentColors(),
          caption: "+3",
          captionMark: WORKING,
        });

        expect(svg).toMatch(/<text data-caption="true"[^>]*>\+3<\/text>/);
        expect(svg).toContain('<g data-caption-mark="working">');

        const textX = Number(/<text data-caption="true" x="([\d.]+)"/.exec(svg)![1]);
        const markRight = Math.max(
          ...[...svg.matchAll(/<circle cx="([\d.]+)"[^>]*r="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2])),
        );

        expect(textX - "+3".length * 0.6 * 14).toBeGreaterThan(markRight);
      });

      it("draws the mark in the label colour, at the caption's height", () => {
        const svg = renderDialBox(canvas, {
          abbr: "MARKERS",
          value: "3",
          colors: { ...accentColors(), label: "#00ff00" },
          caption: "+3",
          captionMark: { kind: "waiting" },
        });
        const captionY = Number(/<text data-caption="true"[^>]*y="(\d+)"/.exec(svg)![1]);
        const cys = [...svg.matchAll(/<circle [^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));

        expect(svg.match(/<circle [^>]*fill="#00ff00"/g)).toHaveLength(3);
        expect(cys.every((cy) => cy < captionY && cy > captionY - 10)).toBe(true);
      });

      it("leaves the label and the value where the caption's text puts them", () => {
        const base = { abbr: "MARKERS", value: "12", colors: accentColors() };

        for (const caption of ["", "ADD −5 s"]) {
          const plain = renderDialBox(canvas, { ...base, caption });

          for (const captionMark of [WORKING, { kind: "waiting" } as const, { kind: "not-done" } as const]) {
            expect(aboveCaption(renderDialBox(canvas, { ...base, caption, captionMark }))).toBe(aboveCaption(plain));
          }
        }
      });

      it("draws the mark on the caption line with no caption text", () => {
        const svg = renderDialBox(canvas, {
          abbr: "MARKERS",
          value: "12",
          colors: accentColors(),
          captionMark: WORKING,
        });

        expect(svg).not.toContain("data-caption=");
        expect(svg.match(/<circle /g)).toHaveLength(3);
      });

      it("keeps the caption's layout but not its text when the mark replaces it", () => {
        const base = { abbr: "SPEED", value: "PAUSED", colors: accentColors(), caption: "▶ 1x" };
        const svg = renderDialBox(canvas, { ...base, captionMark: { ...WORKING, replacesCaption: true } });

        expect(svg).not.toContain("▶ 1x");
        expect(svg).toContain('<g data-caption-mark="working">');
        expect(aboveCaption(svg)).toBe(aboveCaption(renderDialBox(canvas, base)));
      });

      it("dims the mark with the rest of a dimmed box", () => {
        const svg = renderDialBox(canvas, {
          abbr: "SPEED",
          value: "",
          colors: accentColors(),
          dimmed: true,
          captionMark: { kind: "not-done" },
        });

        expect(svg).toMatch(/<g data-dimmed="true"[^>]*>.*<g data-caption-mark="not-done">.*<\/g><\/svg>$/);
      });
    });
  }
});
