import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/accordion.ejs` (not a fixture) — it wraps a
 * section in every one of the 35 action PIs, and since #992 it has a second,
 * flat "card" mode for the settings window. Both must keep working.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");

function render(template: string, data: Record<string, unknown> = {}): string {
  return ejs.render(template, data, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

describe("accordion.ejs", () => {
  it("renders a collapsible <details> by default (the PI mode)", () => {
    const html = render("<%- include('accordion', { title: 'Title Defaults', content: '<p>body</p>' }) %>");

    expect(html).toContain('<details class="ird-collapsible" data-accordion-id="Title Defaults"');
    expect(html).toContain("<p>body</p>");
  });

  it("renders a flat card, not a <details>, when settingsWindow is set (#992)", () => {
    const html = render(
      "<%- include('accordion', { title: 'Title Defaults', content: '<p>body</p>', settingsWindow: true }) %>",
    );

    expect(html).not.toContain("<details");
    expect(html).toContain('class="ird-sw-card"');
    expect(html).toContain("Title Defaults");
    expect(html).toContain("<p>body</p>");
  });

  it("inherits settingsWindow through a nesting partial (EJS include scope), so global-* partials need no changes", () => {
    // A partial that itself includes accordion WITHOUT forwarding the flag —
    // exactly what global-title-defaults.ejs & co. do. Written to a temp views
    // dir searched alongside the real partials dir.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ird-accordion-nest-"));

    try {
      writeFileSync(path.join(tmp, "nesting.ejs"), "<%- include('accordion', { title: 'Nested', content: 'x' }) %>");

      const html = ejs.render(
        "<%- include('nesting', { settingsWindow: true }) %>",
        {},
        { views: [tmp, partialsDir], filename: path.join(tmp, "_test.ejs") },
      );

      expect(html).toContain('class="ird-sw-card"');
      expect(html).not.toContain("<details");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
