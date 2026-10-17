import { createHash } from "node:crypto";
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

/**
 * A box with no caption mark is the box from before the mark existed (#1437), on both renderers.
 * The hashes were taken from the renderers as they stood before `captionMark` was added.
 */
describe("renderDialBox without a caption mark (#1437)", () => {
  const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;
  const KNOB = { id: "stream-dock-knob", width: 176, height: 112 } as const;
  const custom: DialBoxColors = { border: "#111111", label: "#222222", value: "#333333", background: "#444444" };
  const cases: Record<string, Parameters<typeof renderDialBox>[1]> = {
    value: { abbr: "BB", value: "62.2", colors: accentColors() },
    identity: { abbr: "QUAL", value: "", colors: accentColors() },
    "caption + value": { abbr: "MARKERS", value: "3 / 12", colors: accentColors(), caption: "ADD −5 s" },
    "caption + identity": { abbr: "SPEED", value: "", colors: accentColors(), caption: "▶ 1x" },
    "caption + pending": {
      abbr: "MARKERS",
      value: "3",
      colors: custom,
      caption: "ADD 0 s",
      pending: { text: "DELETE 1 / 3", color: "#f39c12" },
    },
    "caption + sides + dimmed": {
      abbr: "MARKERS",
      value: "12",
      colors: accentColors(),
      caption: "+3",
      sideMarker: { left: true, right: false },
      dimmed: true,
    },
    "caption + binding missing": {
      abbr: "JOG",
      value: "1x",
      colors: accentColors(),
      caption: "PAUSED",
      bindingMissing: true,
    },
    "pending only": { abbr: "SPR", value: "+3", colors: accentColors(), pending: { text: "RR", color: "#f39c12" } },
    "dimmed identity": { abbr: "SPEED", value: "", colors: custom, caption: "", dimmed: true, pending: null },
  };
  const hash = (svg: string): string => createHash("sha256").update(svg).digest("hex").slice(0, 16);
  const EXPECTED: Record<string, { strip: string; knob: string }> = {
    value: { strip: "6aebfc535ab4aa7b", knob: "0943975498e51965" },
    identity: { strip: "c0c6791ec7796c3c", knob: "590547e324f18991" },
    "caption + value": { strip: "46b596d438283921", knob: "997b90d985efba8b" },
    "caption + identity": { strip: "16bb74030361295e", knob: "8cfdbd9ce40dfcd8" },
    "caption + pending": { strip: "8ae75021f74e7d8c", knob: "2c69f5278803b78f" },
    "caption + sides + dimmed": { strip: "c01da90ba15ca130", knob: "7e902060d4d56e52" },
    "caption + binding missing": { strip: "6237b4782cb6a416", knob: "45db98e09f540d15" },
    "pending only": { strip: "b5826de28d07c07b", knob: "23059f07c530a958" },
    "dimmed identity": { strip: "1b8b5ed883edfa50", knob: "806c6ce862fedcdd" },
  };

  for (const [name, args] of Object.entries(cases)) {
    it(`draws "${name}" byte for byte as before`, () => {
      const actual = { strip: hash(renderDialBox(STRIP, args)), knob: hash(renderDialBox(KNOB, args)) };

      expect(actual).toEqual(EXPECTED[name]);
    });
  }
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
