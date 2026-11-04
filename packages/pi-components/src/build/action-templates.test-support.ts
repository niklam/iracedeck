import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * Test support: where `@iracedeck/iracing-actions` keeps the pages that include
 * this package's partials, for the build tests that assert things across them.
 * Never imported by the build.
 *
 * The action Property Inspector templates and the settings window's page live
 * in `iracing-actions`, and its `data/` folder holds the JSON several partials
 * render from. The tests here read them through the package, resolved by name
 * from this package's devDependency on it, never by a relative path into a
 * sibling's tree (#1375): the read is then a declared edge of the workspace
 * graph, ordered and hashed by turbo like any other, and a move of the package
 * fails here, by name, rather than as a missing file in some test.
 *
 * Four test files had grown their own copy of the actions path and two of them
 * the whole directory walk, so a change to the `actions/` layout (a second
 * `.ejs` per action, another non-action page) had to be found in four places.
 */

/**
 * The directory of the workspace package `name`, found from its entry as this
 * package resolves it: the nearest `package.json` above the entry that carries
 * that name. `import.meta.resolve` follows the package's `exports` (which offer
 * no `./package.json` subpath to resolve directly) and fails when this package
 * does not declare the dependency.
 */
function packageDir(name: string): string {
  const entry = url.fileURLToPath(import.meta.resolve(name));

  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: unknown };

      if (manifest.name === name) return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new Error(`no package.json named ${name} above its entry ${entry}`);
}

/** `@iracedeck/iracing-actions`' package directory. */
export const IRACING_ACTIONS_DIR = packageDir("@iracedeck/iracing-actions");

/** Its `src/actions` — one directory per action, plus `data/` and the two non-action pages. */
export const ACTIONS_DIR = path.join(IRACING_ACTIONS_DIR, "src", "actions");

/** Its `src/actions/data` — the JSON the build hands to the partials (`profiles.json`, `getting-started.json`, …). */
export const ACTIONS_DATA_DIR = path.join(ACTIONS_DIR, "data");

/** The settings window's page, `settings-window/settings-window.ejs`, which includes most of the settings partials. */
export const SETTINGS_WINDOW_PAGE = path.join(ACTIONS_DIR, "settings-window", "settings-window.ejs");

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
