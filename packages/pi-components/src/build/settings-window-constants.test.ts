import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS_WINDOW_HTML as RUNTIME_HTML, SETTINGS_WINDOW_OPEN_WARNING_ID } from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

import { SETTINGS_WINDOW_FLAG as COMPONENTS_FLAG } from "../components/settings-window-context.js";
import { SETTINGS_WINDOW_FLAG as BRIDGE_FLAG } from "../settings-window-bridge/index.js";
import { SETTINGS_WINDOW_HTML as BUILD_HTML } from "./index.mjs";

/**
 * The plugin serves `ui/<SETTINGS_WINDOW_HTML>` at runtime (deck-core) and the
 * build injects the bridge into that same file (pi-components/build). They are
 * declared in two packages because build-time modules must not be imported
 * into the runtime bundle — so this test is the single thing keeping them equal.
 */
describe("settings-window file name (#992)", () => {
  it("is the same string at build time and at runtime", () => {
    expect(BUILD_HTML).toBe(RUNTIME_HTML);
  });
});

/**
 * The bridge (its own browser bundle, own tsconfig rootDir) SETS the
 * `window.__irdSettingsWindow` flag; the shared components READ it through
 * `settings-window-context.ts`. A drift would silently put every window-mode
 * branch (SimHub proxy, Test buttons) back on the PI path — this pins them.
 */
describe("settings-window flag (#992)", () => {
  it("is the same window property in the bridge and in the shared components", () => {
    expect(BRIDGE_FLAG).toBe(COMPONENTS_FLAG);
  });
});

/**
 * The settings-window OPEN-failure banner is placed by two EJS partials:
 * rendered above the Open Settings button (`only`) and withheld from the
 * page-top strip (`except`). Both name the id as a literal, because these
 * partials are browser markup and cannot import deck-core. If the plugin's id
 * ever changed, the banner would silently render in NEITHER place — the top
 * strip would still exclude the old string while the button's instance filtered
 * for it. That is invisible until someone hits the very failure the banner
 * exists for, so it is pinned here. (The SERVER-failure id needs no pin: it is
 * named in no filter and shows in the top strip like any other warning.)
 */
describe("settings-window warning id (#1005)", () => {
  const partials = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "partials");
  const read = (name: string): string => readFileSync(join(partials, name), "utf8");

  it("is the id the button's banner filters for", () => {
    expect(read("open-settings.ejs")).toContain(`only="${SETTINGS_WINDOW_OPEN_WARNING_ID}"`);
  });

  it("is the id the auto-injected top strip excludes, so the banner never renders twice", () => {
    expect(read("head-common.ejs")).toContain(`'except', '${SETTINGS_WINDOW_OPEN_WARNING_ID}'`);
  });
});
