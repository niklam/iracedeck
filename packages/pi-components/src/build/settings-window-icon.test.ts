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
 */
function pluginConfigs(): { pkg: string; source: string }[] {
  const packagesDir = path.join(repoRoot, "packages");

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ pkg: entry.name, config: path.join(packagesDir, entry.name, "rollup.config.mjs") }))
    .filter(({ config }) => existsSync(config))
    .map(({ pkg, config }) => ({ pkg, source: readFileSync(config, "utf-8") }))
    .filter(({ source }) => source.includes("browserDir"));
}

describe("settings-window favicon (#1156)", () => {
  it("ships the committed icon the export names", () => {
    expect(existsSync(path.join(browserDir, SETTINGS_WINDOW_ICON))).toBe(true);
  });

  it("is linked by the window page, by that same name", () => {
    const page = readFileSync(windowPage, "utf-8");
    const link = /<link[^>]*rel="icon"[^>]*>/.exec(page)?.[0] ?? "";

    expect(link).toContain(`href="${SETTINGS_WINDOW_ICON}"`);
  });

  it("is copied into every plugin's ui/ beside the page that links it", () => {
    const configs = pluginConfigs();

    expect(configs.length).toBeGreaterThan(0);

    for (const { pkg, source } of configs) {
      expect(source.includes("SETTINGS_WINDOW_ICON"), `${pkg} copies browser assets but not the icon`).toBe(true);
    }
  });
});
