import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  "replay-markers",
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

/** The shared controller-resolution partial every dial PI includes (#1329). */
const DIAL_CONTROLLER_INCLUDE = "<%- include('dial-controller') %>";

/** A template-local copy of what the partial owns, by name — a declaration, a call or a comment pointing at one. */
const LOCAL_CONTROLLER_SCRIPT = /\b(resolveController|applyDialView)\b/;

/** Where the partial defines the resolver, in the compiled page. */
const RESOLVER_DEFINITION = "window.irdResolveController = async function";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const allPIs = actionPropertyInspectors();
const templates = allPIs.filter((t) => DIAL_TEMPLATES.has(path.basename(t.name, ".ejs")));
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

  it("finds all seventeen dial templates", () => {
    expect(dialNames).toEqual([...DIAL_TEMPLATES].sort());
  });

  it("lists every template with a dial view, and no other", () => {
    // A dial view is the `#dial-settings` section the controller switch reveals.
    // Keyed on the markup rather than on the list, so a new dial-capable PI that
    // nobody added to DIAL_TEMPLATES fails here instead of escaping every check.
    const withDialView = allPIs
      .filter((t) => t.source.includes('id="dial-settings"'))
      .map((t) => path.basename(t.name, ".ejs"))
      .sort();

    expect(withDialView).toEqual([...DIAL_TEMPLATES].sort());
  });

  it("finds no dial view inside a partial, which the template scan above could not see", () => {
    const withDialView = readdirSync(partialsDir)
      .filter((file) => file.endsWith(".ejs"))
      .filter((file) => readFileSync(path.join(partialsDir, file), "utf-8").includes('id="dial-settings"'));

    expect(withDialView).toEqual([]);
  });

  describe("the shared resolver and view switch behave as each local copy did (#1329)", () => {
    type ControllerWindow = {
      SDPIComponents?: { streamDeckClient?: { getConnectionInfo: () => Promise<unknown> } };
      irdResolveController?: () => Promise<"Encoder" | "Keypad" | null>;
      irdApplyDialView?: () => void;
    };

    type StubDocument = { getElementById: (id: string) => unknown; hidden: Map<string, boolean> };

    /** The three sections the view switch toggles, each with a `hidden` flag the stub classList writes. */
    function stubDocument(): StubDocument {
      const hidden = new Map([
        ["keypad-settings", false],
        ["keypad-appearance", false],
        ["dial-settings", true],
      ]);

      return {
        hidden,
        getElementById: (id: string) =>
          hidden.has(id)
            ? {
                classList: {
                  add: (c: string) => c === "hidden" && hidden.set(id, true),
                  remove: (c: string) => c === "hidden" && hidden.set(id, false),
                },
              }
            : null,
      };
    }

    /** Runs the partial's own `<script>` against a stub page, the way a PI loads it. */
    function loadPartial(win: ControllerWindow, doc: StubDocument = stubDocument()): ControllerWindow {
      // Without the EJS comment, whose prose names `<script>` itself.
      const source = readFileSync(path.join(partialsDir, "dial-controller.ejs"), "utf-8").replace(/<%#[\s\S]*?%>/g, "");
      const script = /<script>([\s\S]*?)<\/script>/.exec(source)?.[1];

      expect(script).toBeDefined();
      new Function("window", "document", script ?? "")(win, doc);

      return win;
    }

    function withController(controller: unknown): ControllerWindow {
      return {
        SDPIComponents: {
          streamDeckClient: { getConnectionInfo: async () => ({ actionInfo: { payload: { controller } } }) },
        },
      };
    }

    it.each([
      ["Encoder", "Encoder"],
      ["Knob", "Encoder"],
      ["Keypad", "Keypad"],
      ["Information", "Keypad"],
      [undefined, "Keypad"],
    ])("resolves a reported controller of %s to %s", async (controller, expected) => {
      expect(await loadPartial(withController(controller)).irdResolveController?.()).toBe(expected);
    });

    it("resolves a keypad when there is no sdpi client", async () => {
      expect(await loadPartial({}).irdResolveController?.()).toBe("Keypad");
    });

    it('resolves null when the lookup throws, which every `=== "Encoder"` caller keeps as the keypad view', async () => {
      const win = loadPartial({
        SDPIComponents: {
          streamDeckClient: {
            getConnectionInfo: async () => {
              throw new Error("host gone");
            },
          },
        },
      });

      expect(await win.irdResolveController?.()).toBeNull();
    });

    it("applies the dial view: hides both keypad sections and shows the dial's", () => {
      const doc = stubDocument();

      loadPartial({}, doc).irdApplyDialView?.();

      expect(Object.fromEntries(doc.hidden)).toEqual({
        "keypad-settings": true,
        "keypad-appearance": true,
        "dial-settings": false,
      });
    });
  });

  describe("controller resolution comes from the shared partial (#1329)", () => {
    it.each(dialNames)("%s: includes dial-controller exactly once", (name) => {
      const source = templates.find((t) => path.basename(t.name, ".ejs") === name)?.source ?? "";

      expect(occurrences(source, DIAL_CONTROLLER_INCLUDE)).toBe(1);
    });

    it.each(dialNames)("%s: keeps no local resolveController or applyDialView", (name) => {
      const source = templates.find((t) => path.basename(t.name, ".ejs") === name)?.source ?? "";

      expect(source).not.toMatch(LOCAL_CONTROLLER_SCRIPT);
    });

    it("is included by no template without a dial view", () => {
      const others = allPIs
        .filter((t) => !DIAL_TEMPLATES.has(path.basename(t.name, ".ejs")))
        .filter((t) => t.source.includes("include('dial-controller')"))
        .map((t) => t.name);

      expect(others).toEqual([]);
    });

    it.each(dialNames)("%s: compiles the resolver once, ahead of the page's own call", (name) => {
      for (const html of [knob.get(name) ?? "", strip.get(name) ?? ""]) {
        expect(occurrences(html, RESOLVER_DEFINITION)).toBe(1);
        expect(occurrences(html, "window.irdApplyDialView = function")).toBe(1);

        const call = html.indexOf("await window.irdResolveController()");

        expect(call).toBeGreaterThan(-1);
        expect(html.indexOf(RESOLVER_DEFINITION)).toBeLessThan(call);
      }
    });
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
