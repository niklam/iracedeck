import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { actionPropertyInspectors, ACTIONS_DIR } from "./action-templates.js";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

/**
 * The knob-shaped Property Inspector (#1013). On Mirabox a dial has exactly two
 * gestures, rotate and press, so with `dialExtendedGestures` off the compiled
 * PI must bind NO control to the slots a knob cannot reach — a hidden control
 * that still existed in the DOM would let sdpi write a value the user never
 * saw, and stored values in those slots must stay untouched — while the Press
 * slot and the Dash Box Appearance colours stay. With the flag on, every slot
 * is offered.
 *
 * The templates are compiled through `piTemplatePlugin` itself, the way each
 * plugin's rollup build does, so the assertions read the HTML a host would load.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

const DIAL_TEMPLATES = new Set([
  "audio-controls",
  "black-box-selector",
  "camera-focus",
  "camera-editor-adjustments",
  "cockpit-misc",
  "force-feedback",
  "fuel-service",
  "setup-aero",
  "setup-brakes",
  "setup-chassis",
  "setup-engine",
  "setup-fuel",
  "setup-hybrid",
  "setup-traction",
  "splits-delta-cycle",
  "view-adjustment",
]);

/** The dial slots a knob cannot reach: long-press, push+turn, and the two touch-strip gestures. */
const EXTENDED_SLOTS = ["dial.longPressAction", "dial.tapAction", "dial.longTouchAction", "dial.pushTurnAction"];

/** Wording that names a gesture or a surface a knob does not have (`touch` covers the strip, the "touch display" and Long Touch). */
const EXTENDED_WORDING = /push \+ turn|push\+turn|press and turn|long[- ]press|\btouch|Tap Display/i;

type AnyFunction = (...args: any[]) => any;

/** Compile every action template with the given flag value; returns `name → html` for the dial ones. */
async function compileDialPIs(outputDir: string, dialExtendedGestures: boolean): Promise<Map<string, string>> {
  const plugin = piTemplatePlugin({
    templatesDir: ACTIONS_DIR,
    outputDir,
    partialsDir,
    version: "0.0.0-test",
    platformFeatures: { features: { dialExtendedGestures } },
  });
  const context = {
    addWatchFile: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  };

  await (plugin.generateBundle as AnyFunction).call(context);

  return new Map(
    [...DIAL_TEMPLATES].map((name) => [name, readFileSync(path.join(outputDir, `${name}.html`), "utf-8")]),
  );
}

/**
 * The compiled `<div id="dial-settings">…</div>` only — the keypad section
 * legitimately mentions long-press (the dual-press partial) and the hidden
 * `#keypad-appearance` block is not the knob's concern. Balanced-tag walk, as
 * `action-settings-footer-partial.test.ts` does on the template source.
 */
function dialSettingsSlice(html: string): string {
  const marker = html.indexOf('id="dial-settings"');

  expect(marker).toBeGreaterThan(-1);

  const start = html.lastIndexOf("<div", marker);
  const tags = /<div\b|<\/div>/g;
  let depth = 0;

  tags.lastIndex = start;

  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;

    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }

  throw new Error("unbalanced <div> tags around #dial-settings");
}

const templates = actionPropertyInspectors().filter((t) => DIAL_TEMPLATES.has(path.basename(t.name, ".ejs")));
const dialNames = templates.map((t) => path.basename(t.name, ".ejs")).sort();
const withAppearance = templates
  .filter((t) => t.source.includes("include('dial-appearance')"))
  .map((t) => path.basename(t.name, ".ejs"));

describe("dial Property Inspectors on a knob (#1013)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "iracedeck-dial-pi-"));
  let knob: Map<string, string>;
  let strip: Map<string, string>;

  beforeAll(async () => {
    knob = await compileDialPIs(path.join(tmp, "knob"), false);
    strip = await compileDialPIs(path.join(tmp, "strip"), true);
  }, 60_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds all sixteen dial templates", () => {
    expect(dialNames).toEqual([...DIAL_TEMPLATES].sort());
  });

  describe("with dialExtendedGestures off (a Mirabox knob)", () => {
    it.each(dialNames)("%s: binds no control to a slot a knob cannot reach", (name) => {
      const html = knob.get(name) ?? "";

      // The whole page, not just the dial section: a control anywhere would let
      // sdpi write the slot. An attribute (`setting=` / `mode-setting=`), not a
      // CSS selector string in the page script (`sdpi-select[setting=…]`), which
      // binds nothing and simply matches no element.
      for (const slot of EXTENDED_SLOTS)
        expect(html, slot).not.toMatch(new RegExp(`[\\s-]setting="${slot.replace(".", "\\.")}"`));
    });

    it.each(dialNames)("%s: keeps the rotation settings or the Press slot", (name) => {
      expect(dialSettingsSlice(knob.get(name) ?? "")).toMatch(/setting="dial\.(pressAction|category|setting|mode)"/);
    });

    it.each(dialNames)("%s: names no gesture or surface a knob lacks", (name) => {
      expect(dialSettingsSlice(knob.get(name) ?? "")).not.toMatch(EXTENDED_WORDING);
    });

    it.each(withAppearance)("%s: keeps the Dash Box Appearance colours", (name) => {
      expect(dialSettingsSlice(knob.get(name) ?? "")).toContain('setting="dial.colors.borderColor"');
    });

    it("offers no Push to Talk on Audio Controls' Press Action: a knob never sends the release that ends it", () => {
      const dial = dialSettingsSlice(knob.get("audio-controls") ?? "");

      expect(dial).toContain('setting="dial.pressAction"');
      expect(dial).not.toContain('value="push-to-talk"');
    });
  });

  describe("with dialExtendedGestures on (a Stream Deck+ dial)", () => {
    const withLongPress = templates.filter((t) => t.source.includes('setting="dial.longPressAction"'));

    it("has a Long Press slot on every template that offered one before #1013", () => {
      expect(withLongPress.length).toBeGreaterThanOrEqual(12);
    });

    it.each(withLongPress.map((t) => path.basename(t.name, ".ejs")))("%s: offers Long Press", (name) => {
      expect(strip.get(name)).toContain('setting="dial.longPressAction"');
    });

    it.each(withAppearance)("%s: offers the Dash Box Appearance colours", (name) => {
      expect(dialSettingsSlice(strip.get(name) ?? "")).toContain('setting="dial.colors.borderColor"');
    });

    it("offers Fuel Service's Push + Turn", () => {
      expect(strip.get("fuel-service")).toContain('setting="dial.pushTurnAction"');
    });

    it("offers Push to Talk on Audio Controls' Press Action", () => {
      expect(dialSettingsSlice(strip.get("audio-controls") ?? "")).toContain('value="push-to-talk"');
    });
  });
});
