import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

import { actionPropertyInspectors } from "./action-templates.js";

/**
 * `action-settings-footer.ejs` (#1024) — the way through to the iRaceDeck
 * Settings window, closing each action Property Inspector's OWN settings.
 *
 * Two things are guarded here, and the second is the reason this file exists:
 *
 * 1. The partial renders the button, its divider and its warning banner.
 * 2. Every one of the 35 action templates includes it at the right place. On
 *    the 16 dial-capable PIs the key-icon appearance block lives inside
 *    `<div id="keypad-appearance">`, which the PI hides on the dial surface —
 *    so a footer anchored inside that wrapper (the tempting one-line change:
 *    render it from `title-overrides.ejs`) would silently strip every dial user
 *    of the only route to the settings window.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

/** Wrappers a Property Inspector shows on one control surface and hides on the other. */
const SURFACE_WRAPPERS = ["keypad-appearance", "keypad-settings", "dial-settings"];

function render(template: string, data: Record<string, unknown> = {}): string {
  return ejs.render(template, data, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

/**
 * Character range of the `<div>` carrying `id="<id>"`, found by matching the
 * template's own literal `<div>`/`</div>` tags. Included partials are opaque
 * and internally balanced, so only this file's tags matter.
 */
function wrapperRange(source: string, id: string): { start: number; end: number } | null {
  const marker = source.indexOf(`id="${id}"`);

  if (marker < 0) return null;

  const start = source.lastIndexOf("<div", marker);
  const tags = /<div\b|<\/div>/g;
  let depth = 0;

  tags.lastIndex = start;

  for (let match = tags.exec(source); match !== null; match = tags.exec(source)) {
    depth += match[0] === "</div>" ? -1 : 1;

    if (depth === 0) return { start, end: match.index + match[0].length };
  }

  throw new Error(`unbalanced <div> tags around #${id}`);
}

const TEMPLATES = actionPropertyInspectors();

describe("action-settings-footer.ejs (#1024)", () => {
  describe("what it renders", () => {
    it("offers the way through to the settings window", () => {
      expect(render("<%- include('action-settings-footer') %>")).toContain("<ird-open-settings>");
    });

    it("closes the settings above it with a divider", () => {
      expect(render("<%- include('action-settings-footer') %>")).toContain("ird-section-footer");
    });

    it("brings the open-failure banner with it, so a dead press explains itself in place", () => {
      expect(render("<%- include('action-settings-footer') %>")).toContain('only="settings-window-open"');
    });
  });

  describe("every action Property Inspector", () => {
    it("finds them — 35 at the time of writing", () => {
      // A floor, not an equality: the per-template cases below are the real
      // coverage, and pinning the exact count would fail this framework-package
      // test every time an action is added to a different package.
      expect(TEMPLATES.length).toBeGreaterThanOrEqual(35);
    });

    it.each(TEMPLATES)("$name includes the footer exactly once", ({ source }) => {
      expect(source.match(/include\('action-settings-footer'\)/g)).toHaveLength(1);
    });

    it.each(TEMPLATES)("$name puts it above the key-icon appearance settings", ({ source }) => {
      // Everything below the footer is this one key's appearance; everything
      // behind the button is every key's.
      expect(source.indexOf("include('action-settings-footer')")).toBeLessThan(
        source.indexOf("include('title-overrides')"),
      );
    });

    it.each(TEMPLATES)("$name keeps it outside every surface-conditional wrapper", ({ source }) => {
      const footer = source.indexOf("include('action-settings-footer')");

      for (const id of SURFACE_WRAPPERS) {
        const wrapper = wrapperRange(source, id);

        if (!wrapper) continue;

        // Inside one of these, the button would disappear on the surface the PI
        // hides it for — the dial user's route to the settings window is not
        // shorter than anyone else's.
        expect({ id, inside: footer > wrapper.start && footer < wrapper.end }).toEqual({ id, inside: false });
      }
    });

    it.each(TEMPLATES)("$name reaches the button only through this partial", ({ source }) => {
      // One include site per PI keeps the placement rule enforceable; a direct
      // `open-settings` include would bypass both the divider and this test.
      expect(source).not.toContain("include('open-settings'");
    });
  });
});
