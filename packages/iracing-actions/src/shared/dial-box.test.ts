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
