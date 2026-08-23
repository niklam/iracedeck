import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * Locating and reading the action Property Inspector templates, for the build
 * tests that assert things across all of them.
 *
 * Four test files had grown their own copy of this directory path and two of
 * them the whole directory walk, so a change to the `actions/` layout (a second
 * `.ejs` per action, another non-action page) had to be found in four places.
 */

/** `packages/iracing-actions/src/actions` — one directory per action. */
export const ACTIONS_DIR = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../../iracing-actions/src/actions",
);

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
