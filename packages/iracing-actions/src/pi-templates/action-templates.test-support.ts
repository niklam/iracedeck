import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * Test support: this package's Property Inspector templates, for the tests in
 * `src/pi-templates/` that hold every page to the `@iracedeck/pi-components`
 * partials it includes (#1375). Never imported by production code.
 *
 * Four test files had grown their own copy of the actions path and two of them
 * the whole directory walk, so a change to the `actions/` layout (a second
 * `.ejs` per action, another non-action page) had to be found in four places.
 */

/** `src/actions` — one directory per action, plus `data/` and the two non-action pages. */
export const ACTIONS_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../actions");

/** `src/actions/data` — the JSON the build hands to the partials (`profiles.json`, `getting-started.json`, …). */
export const ACTIONS_DATA_DIR = path.join(ACTIONS_DIR, "data");

/** The settings window's page, `settings-window/settings-window.ejs`, which includes most of the settings partials. */
export const SETTINGS_WINDOW_PAGE = path.join(ACTIONS_DIR, "settings-window", "settings-window.ejs");

/** `src/actions/data/<file>`, parsed. */
export function readActionsData<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(ACTIONS_DATA_DIR, file), "utf-8")) as T;
}

/**
 * The `.ejs` files under `actions/` that are NOT action Property Inspectors:
 * the settings window's own page, and the plugin-level fallback PI.
 */
export const NON_ACTION_TEMPLATES = ["settings-window.ejs", "settings.ejs"];

export interface ActionTemplate {
  /** File name, e.g. `fuel-service.ejs`. */
  name: string;
  /** Absolute path to the template. */
  file: string;
  /** The template source. */
  source: string;
}

/** Every `.ejs` under `actions/`, including the two non-action pages. */
export function actionTemplates(): ActionTemplate[] {
  return readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "data")
    .flatMap((dir) =>
      readdirSync(path.join(ACTIONS_DIR, dir.name))
        .filter((file) => file.endsWith(".ejs"))
        .map((file) => {
          const filePath = path.join(ACTIONS_DIR, dir.name, file);

          return { name: file, file: filePath, source: readFileSync(filePath, "utf-8") };
        }),
    );
}

/** Just the action Property Inspectors — `actionTemplates()` without the two pages that are not one. */
export function actionPropertyInspectors(): ActionTemplate[] {
  return actionTemplates().filter((template) => !NON_ACTION_TEMPLATES.includes(template.name));
}
