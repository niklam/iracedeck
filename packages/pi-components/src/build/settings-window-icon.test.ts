import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { browserDir, SETTINGS_WINDOW_ICON } from "./index.mjs";

/**
 * The settings window is the only page we serve that a browser gives window
 * chrome to, so it is the only one that needs a favicon (#1156) — and the only
 * one where a missing icon is visible, as the browser's placeholder globe in
 * the title bar and in alt-tab.
 *
 * Every part of shipping it is silent when it breaks: the asset is a committed
 * binary under a `browser/*` .gitignore that has to name it to keep it, the
 * copy step that puts it beside the page is one entry in a list in the shared
 * plugin factory (`@iracedeck/plugin-build`, #1349), and
 * a `<link>` whose href resolves to nothing renders exactly like no link at
 * all. Nothing in a build, a test run or a screenshot capture would say so —
 * the failure is a globe nobody is looking at on a machine nobody is running.
 * So each hop is pinned where it lives: the asset here; the copy in
 * plugin-build's `src/plugin-rollup.test.ts`, which runs the factory's copy step
 * and checks every file name it writes into `ui/`, and in the root
 * `scripts/lib/plugin-config-shape.test.mjs`, which holds every plugin config to
 * leaving that copy to the factory; and the page's `<link>` beside the page, in
 * `iracing-actions`' `src/pi-templates/settings-window-page.test.ts` (#1375).
 */
describe("settings-window favicon (#1156)", () => {
  it("ships the committed icon the export names", () => {
    expect(existsSync(path.join(browserDir, SETTINGS_WINDOW_ICON))).toBe(true);
  });

  it("is an opaque square with no alpha channel, large enough for the taskbar", () => {
    // Chromium hands Windows the window icon with premultiplied pixels, which
    // Windows draws as straight alpha: every partially transparent pixel comes
    // out darker than it should. Read back from a live window, every soft
    // corner pixel of a rounded tile was affected, and in the taskbar they
    // showed as grey brackets. So the icon has no transparency at all, and the
    // PNG header proves it: colour type 2 is RGB, with no alpha channel to be
    // partial. The size bound refuses the website's 96 px favicon, whose mark
    // also read as too small.
    const png = readFileSync(path.join(browserDir, SETTINGS_WINDOW_ICON));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const colorType = png[25];

    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(256);
    expect(colorType).toBe(2);
  });
});
