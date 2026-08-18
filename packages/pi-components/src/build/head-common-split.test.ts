import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #1003 split head-common.ejs in two.
 *
 * head-common.ejs is loaded by every Property Inspector AND by the settings
 * window. Once the plugin-global settings moved to the window (#992, #993), the
 * handlers driving those controls could no longer fire in a PI — the elements
 * they look up are not on the page — so they moved to
 * settings-window-scripts.ejs, which only the window includes.
 *
 * Both directions matter: the window must keep the behaviour, and head-common
 * must not quietly reacquire it (which would put dead script back into all 35
 * PIs).
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const actionsDir = path.resolve(partialsDir, "../../iracing-actions/src/actions");

const read = (file: string): string => readFileSync(file, "utf-8");

const headCommon = read(path.join(partialsDir, "head-common.ejs"));
const windowScripts = read(path.join(partialsDir, "settings-window-scripts.ejs"));
const settingsWindow = read(path.join(actionsDir, "settings-window/settings-window.ejs"));

/** Every action Property Inspector template, one entry per `.ejs` under `actions/`. */
function actionTemplates(): Array<{ name: string; file: string }> {
  return readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "data")
    .flatMap((dir) =>
      readdirSync(path.join(actionsDir, dir.name))
        .filter((file) => file.endsWith(".ejs"))
        .map((file) => ({ name: file, file: path.join(actionsDir, dir.name, file) })),
    );
}

/** Hooks that only ever exist on the settings window's page. */
const WINDOW_ONLY_HOOKS = [
  "ird-color-preset", // global colour preset buttons
  "global-title-position", // global title position select
  "global-title-fontSize-default", // global font-size gate
  "ird-title-global-reset", // title-defaults Reset
  "ird-setup-warning-reset", // setup-warning pattern Resets
  "global-border-enabled", // border-defaults visibility
];

/** Hooks the Property Inspectors still need. */
const SHARED_HOOKS = [
  "ird-override-preset", // per-action colour presets
  "title-custom-position-item", // per-action title position
  "ird-warnings", // the global warning banner
  "data-accordion-id", // accordion state persistence
];

describe("head-common / settings-window-scripts split (#1003)", () => {
  describe("settings-window-scripts.ejs", () => {
    it.each(WINDOW_ONLY_HOOKS)("owns the %s behaviour", (hook) => {
      expect(windowScripts).toContain(hook);
    });

    it("is included by the settings window", () => {
      expect(settingsWindow).toContain("include('settings-window-scripts')");
    });
  });

  describe("head-common.ejs", () => {
    it.each(WINDOW_ONLY_HOOKS)("no longer ships %s to every Property Inspector", (hook) => {
      expect(headCommon).not.toContain(hook);
    });

    it.each(SHARED_HOOKS)("still owns %s, which the PIs need", (hook) => {
      expect(headCommon).toContain(hook);
    });

    it("is still what loads the PI framework for both surfaces", () => {
      expect(headCommon).toContain("sdpi-components.js");
      expect(headCommon).toContain("pi-components.js");
    });
  });

  describe("no action Property Inspector includes the window-only scripts", () => {
    it("keeps the partial out of every action template", () => {
      const offenders = actionTemplates()
        .filter(({ name }) => name !== "settings-window.ejs")
        .filter(({ file }) => read(file).includes("settings-window-scripts"))
        .map(({ name }) => name);

      expect(offenders).toEqual([]);
    });

    it("keeps it out of head-common, which every PI loads", () => {
      expect(headCommon).not.toContain("settings-window-scripts");
    });
  });
});
