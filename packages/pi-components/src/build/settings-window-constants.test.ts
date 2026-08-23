import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PI_WARNINGS_KEY,
  SETTINGS_WINDOW_HTML as RUNTIME_HTML,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
} from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

import { SETTINGS_WINDOW_FLAG as COMPONENTS_FLAG } from "../components/settings-window-context.js";
import { WARNINGS_SETTING as COMPONENT_WARNINGS_KEY } from "../components/warnings-constants.js";
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
 * rendered above the iRaceDeck Settings button (`only`) and withheld from the
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

  /**
   * The top strip is injected only when the page has no `ird-warnings[data-auto]`
   * yet. `data-auto` is what makes that guard specific: `open-settings.ejs` now
   * puts a second, filtered `ird-warnings` in every PI body, and an unqualified
   * `querySelector('ird-warnings')` would match THAT one and skip injecting the
   * strip — losing every page-wide warning (elevation mismatch, setup names,
   * the settings-service error) on all 36 pages at once. Nothing else fails
   * loudly if the marker is dropped from either side.
   */
  it("marks the auto-injected strip so the button's banner cannot suppress it", () => {
    expect(read("head-common.ejs")).toContain("ird-warnings[data-auto]");
    expect(read("head-common.ejs")).toContain("'data-auto'");
    expect(read("open-settings.ejs")).not.toContain("data-auto");
  });
});

/**
 * The settings window is served BY the settings server, so a banner saying that
 * server never started is disproved by the page the user is reading it on, and
 * the OPEN-failure note is advice about a button that page does not have
 * (issue #1014). Since the page has no `open-settings.ejs` include, neither has
 * a home there — both are withheld.
 *
 * It suppresses them by placing its OWN top strip: `head-common.ejs` injects
 * one only when the body has no `ird-warnings[data-auto]` yet, so the marker is
 * what makes the page's element the strip rather than a second one below it.
 * Both halves are pinned — a page that dropped `data-auto` would render two
 * strips, the injected one unfiltered.
 */
describe("settings-window page withholds the settings-window banners (#1014)", () => {
  const actions = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "iracing-actions", "src", "actions");

  // Read lazily, like the `read()` helper the sibling describe uses: a page
  // that moves should fail ONE named test, not throw during collection and
  // take the unrelated constant pins in this file down with it.
  const strip = (): string => {
    const page = readFileSync(join(actions, "settings-window", "settings-window.ejs"), "utf8");

    return /<ird-warnings\s[^>]*>/.exec(page)?.[0] ?? "";
  };

  it("places its own top strip instead of taking the injected one", () => {
    expect(strip()).toContain("data-auto");
  });

  it("excludes both settings-window ids from it", () => {
    expect(strip()).toContain(`except="`);
    expect(strip()).toContain(SETTINGS_WINDOW_SERVER_WARNING_ID);
    expect(strip()).toContain(SETTINGS_WINDOW_OPEN_WARNING_ID);
  });

  /**
   * Suppressing the injection means the page inherits none of its filtering:
   * whatever `head-common.ejs` excludes because it has a dedicated home
   * elsewhere on the page must be excluded here too, or that banner starts
   * rendering twice (or in a place it does not belong) on this one page. Today
   * the injected list is a subset of the page's; this keeps it that way when
   * the next id is added to head-common and nobody thinks of this page.
   */
  it("excludes at least everything the injected strip excludes", () => {
    const partials = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "partials");
    const headCommon = readFileSync(join(partials, "head-common.ejs"), "utf8");
    const injected = /setAttribute\('except',\s*'([^']*)'\)/.exec(headCommon)?.[1] ?? "";
    const injectedIds = injected
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");

    expect(injectedIds.length).toBeGreaterThan(0);

    const placed = strip();

    for (const id of injectedIds) expect(placed).toContain(id);
  });
});

/**
 * The `_warnings` key is declared in deck-core (the plugin writes it) and
 * duplicated in the browser component (which cannot import deck-core). A
 * rename on one side alone fails SILENTLY — the component simply never hears
 * from its key and every banner on every page stops rendering — so the pair is
 * pinned here, like the file name and the window flag above.
 */
describe("PI warnings settings key (#610, #1014)", () => {
  it("is the same key in deck-core and in the browser component", () => {
    expect(COMPONENT_WARNINGS_KEY).toBe(PI_WARNINGS_KEY);
  });
});
