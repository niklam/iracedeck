import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

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
 * copy step that puts it beside the page is one entry in a list per plugin, and
 * a `<link>` whose href resolves to nothing renders exactly like no link at
 * all. Nothing in a build, a test run or a screenshot capture would say so —
 * the failure is a globe nobody is looking at on a machine nobody is running.
 * So each hop is pinned here.
 */
const packageRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const windowPage = path.join(
  repoRoot,
  "packages/iracing-actions/src/actions/settings-window/settings-window.ejs",
);

/**
 * The plugin configs that copy this package's browser assets, discovered rather
 * than listed, so a fourth deck ecosystem is covered the day its package
 * appears — the shape `third-party-licenses.test.mjs` uses.
 *
 * `copyList` is the array the config's copy loop iterates, NOT the whole file:
 * the import line names the constant too, so a whole-file search is satisfied
 * by a config that imports the icon and copies everything except it — which
 * emits no `ui/iracedeck-icon.png` and puts the globe back. Nothing else would
 * catch that: `pnpm lint` globs each package's `src` tree, never a plugin's
 * `rollup.config.mjs`, so the orphaned import is not even an unused-import
 * error.
 */
function pluginConfigs(): { pkg: string; copyList: string }[] {
  const packagesDir = path.join(repoRoot, "packages");

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ pkg: entry.name, config: path.join(packagesDir, entry.name, "rollup.config.mjs") }))
    .filter(({ config }) => existsSync(config))
    .map(({ pkg, config }) => ({ pkg, source: readFileSync(config, "utf-8") }))
    .filter(({ source }) => source.includes("browserDir"))
    .map(({ pkg, source }) => ({ pkg, copyList: browserAssetCopyList(source) }));
}

/**
 * The `for (const … of [ … ])` list the browser-assets copy step walks,
 * identified by the one asset every plugin has always copied. Empty when no
 * such loop is found, which fails the assertion rather than passing it — a
 * config whose copy step was restructured must be re-read, not waved through.
 */
function browserAssetCopyList(source: string): string {
  for (const [, list] of source.matchAll(/for \(const \w+ of \[([^\]]*)\]\)/g)) {
    if (list.includes("sdpi-components.js")) return list;
  }

  return "";
}

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

  it("is linked by the window page, by that same name", () => {
    const page = readFileSync(windowPage, "utf-8");
    const link = /<link[^>]*rel="icon"[^>]*>/.exec(page)?.[0] ?? "";

    expect(link).toContain(`href="${SETTINGS_WINDOW_ICON}"`);
  });

  it("is copied into every plugin's ui/ beside the page that links it", () => {
    const configs = pluginConfigs();

    expect(configs.length).toBeGreaterThan(0);

    for (const { pkg, copyList } of configs) {
      expect(copyList.includes("SETTINGS_WINDOW_ICON"), `${pkg}'s browser-asset copy list omits the icon`).toBe(true);
    }
  });
});
