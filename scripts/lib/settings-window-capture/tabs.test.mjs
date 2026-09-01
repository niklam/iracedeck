import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseNavPanes, SETTINGS_WINDOW_TABS } from "./tabs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const builtPage = join(
  repoRoot,
  "packages",
  "iracing-plugin-stream-deck",
  "com.iracedeck.sd.core.sdPlugin",
  "ui",
  "settings-window.html",
);
const assetsDir = join(repoRoot, "packages", "website", "src", "assets", "settings-window");

describe("SETTINGS_WINDOW_TABS", () => {
  it("names a distinct screenshot file per tab", () => {
    const files = SETTINGS_WINDOW_TABS.map((tab) => tab.file);

    expect(new Set(files).size).toBe(files.length);
    expect(files.every((file) => file.endsWith(".png"))).toBe(true);
  });

  it("has a screenshot committed for every tab", () => {
    const missing = SETTINGS_WINDOW_TABS.filter((tab) => !existsSync(join(assetsDir, tab.file))).map(
      (tab) => tab.file,
    );

    expect(missing, `Run "pnpm capture:settings" to generate: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("parseNavPanes", () => {
  it("reads the pane ids out of nav markup", () => {
    const html = `
      <button class="sw-nav-item active" data-pane="general" type="button">General</button>
      <button class="sw-nav-item" data-pane="bindings" type="button">Key Bindings</button>
    `;

    expect(parseNavPanes(html)).toEqual(["general", "bindings"]);
  });

  it("ignores buttons that are not nav items", () => {
    const html = `<button class="sw-other" data-pane="nope">x</button>`;

    expect(parseNavPanes(html)).toEqual([]);
  });
});

// The freshness guard (#1010): screenshots cannot be diffed reliably across
// machines, so what CI can enforce is that the documented tab list still
// matches the page. Add or rename a tab and this fails, which is the prompt to
// recapture and write the new section.

describe("the first-run deep link's target", () => {
  it("still exists in the tab list", () => {
    // deck-core's GETTING_STARTED_PANE is this literal, and the page's own
    // handler is a fail-soft (`if (document.getElementById("pane-" + wanted))`),
    // so a rename would silently land the first-run window on General instead.
    // This list is already pinned against the built page, so failing here or
    // there catches a rename wherever it is made.
    expect(SETTINGS_WINDOW_TABS.map((tab) => tab.pane)).toContain("getting-started");
  });
});

describe("the built Settings window page", () => {
  it("has exactly the tabs the docs document, in the same order", () => {
    if (!existsSync(builtPage)) {
      // The plugin has not been built in this checkout; nothing to compare
      // against. The capture harness itself refuses to run in that state.
      return;
    }

    expect(parseNavPanes(readFileSync(builtPage, "utf-8"))).toEqual(
      SETTINGS_WINDOW_TABS.map((tab) => tab.pane),
    );
  });
});
