import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/key-bindings-section.ejs` (not a fixture).
 *
 * Since #1003 this partial is the ENTIRE bottom section of all 35 action PIs:
 * the plugin-global settings moved to the dedicated settings window (#992,
 * #993), leaving only the action's own key bindings plus the link out. It owns
 * the section header, the bindings accordion, and the empty-state line, so the
 * 25 PIs that have bindings and the 10 that do not stay consistent by
 * construction rather than by 35 copies of the same markup.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(template: string, data: Record<string, unknown> = {}): string {
  return ejs.render(template, data, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

const BINDINGS = [{ id: "lapTiming", label: "Lap Timing", default: "F1", setting: "blackBoxLapTiming" }];

describe("key-bindings-section.ejs", () => {
  describe("section header", () => {
    it("titles the section 'Key Bindings', not the retired 'Global Settings'", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain("Key Bindings");
      expect(html).not.toContain("Global Settings");
    });

    it("always offers the way out to the settings window", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain("<ird-open-settings>");
    });

    it("offers the settings-window link even when the action has no bindings", () => {
      const html = render("<%- include('key-bindings-section') %>");

      expect(html).toContain("<ird-open-settings>");
    });
  });

  describe("with bindings", () => {
    it("renders a row per binding", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain('<ird-key-binding setting="blackBoxLapTiming" default="F1" global>');
      expect(html).toContain("Lap Timing");
    });

    it("keeps the accordion id EXACTLY 'Related Key Bindings' — ird-binding-status hardcodes it", () => {
      // binding-status.ts pins KEY_BINDINGS_ACCORDION_ID to this literal to open
      // and scroll the accordion from its "set it here" link, and accordion.ejs
      // derives data-accordion-id from the title. Retitling silently breaks both
      // that link and the _accordionState persistence key.
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain('data-accordion-id="Related Key Bindings"');
    });

    it("does not render the empty-state line", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).not.toContain("no key bindings");
    });
  });

  describe("without bindings", () => {
    it("states the absence rather than leaving the section blank", () => {
      const html = render("<%- include('key-bindings-section') %>");

      expect(html).toContain("This action has no key bindings.");
      expect(html).toContain("ird-supporting-text");
    });

    it("treats an empty array the same as no argument", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: [] }) %>");

      expect(html).toContain("This action has no key bindings.");
    });

    it("renders no bindings accordion", () => {
      const html = render("<%- include('key-bindings-section') %>");

      expect(html).not.toContain("Related Key Bindings");
      expect(html).not.toContain("<ird-key-binding");
    });
  });

  describe("conditional visibility wrapper", () => {
    it("wraps the bindings in #key-bindings-section so a PI can toggle them per mode", () => {
      // Fuel Service and its dial surface show the bindings only for the modes
      // that use them, by id. The id lives here so there is one definition.
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain('id="key-bindings-section"');
    });

    it("is visible by default", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS }) %>", { BINDINGS });

      expect(html).toContain('<div id="key-bindings-section">');
    });

    it("starts hidden when the caller asks, leaving the header visible", () => {
      const html = render("<%- include('key-bindings-section', { keyBindings: BINDINGS, hidden: true }) %>", {
        BINDINGS,
      });

      expect(html).toContain('<div id="key-bindings-section" class="hidden">');
      // The header must NOT be inside the hidden wrapper — it stays on screen.
      expect(html.indexOf("Key Bindings")).toBeLessThan(html.indexOf('id="key-bindings-section"'));
    });
  });

  describe("row options", () => {
    it("forwards a row's class so a PI can mark dial-only bindings", () => {
      // Audio Controls hides the bindings it borrows from AI Spotter Controls
      // unless the instance is a dial.
      const rows = [{ ...BINDINGS[0], class: "dial-only-binding hidden" }];
      const html = render("<%- include('key-bindings-section', { keyBindings: rows }) %>", { rows });

      expect(html).toContain('class="dial-only-binding hidden"');
    });
  });
});
