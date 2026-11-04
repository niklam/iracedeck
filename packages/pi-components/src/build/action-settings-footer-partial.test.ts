import ejs from "ejs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `action-settings-footer.ejs` (#1024) — the way through to the iRaceDeck
 * Settings window, closing each action Property Inspector's OWN settings.
 *
 * This holds what the partial renders: the button, its divider and its warning
 * banner. Where every action template includes it — once, above the key-icon
 * appearance settings and outside every surface-conditional wrapper — is held
 * by `iracing-actions`' `src/pi-templates/action-settings-footer.test.ts`,
 * beside the templates (#1375).
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(template: string, data: Record<string, unknown> = {}): string {
  return ejs.render(template, data, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

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
});
