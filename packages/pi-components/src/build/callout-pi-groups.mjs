/**
 * The Race Engineer Callouts sections, headings and rows (#1350, #1700) for
 * `race-engineer-callouts.ejs`, read from the built
 * `@iracedeck/callout-settings` registry.
 *
 * The registry is read in a fresh Node process on every call. An in-process
 * `import()` would be cached for the life of the Rollup process, so in watch
 * mode a family edit (registry rebuilt) would reach the plugin's JS but never
 * the settings window's rows. A cache-busting query on the entry does not
 * help either: it re-evaluates `index.js` only, and the files it imports
 * (`pi-groups.js`, `families/*.js`) resolve without the query and come back
 * from the cache.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const THIS_FILE = url.fileURLToPath(import.meta.url);

/**
 * @typedef {{ setting: string, label: string, description: string | null, on: boolean, feature: string | null }} CalloutPiRow
 * @typedef {{ id: string, title: string, description: string, rows: CalloutPiRow[] }} CalloutPiHeadingData
 * @typedef {{ id: string, title: string, groups: CalloutPiHeadingData[] }} CalloutPiSectionData
 */

/**
 * Flatten a registry module into the partial's render data (#1700): one entry
 * per section of the settings window's Callouts card, in registry order, each
 * holding its headings in order. A heading carries its title and its one-line
 * description; its rows are its families' entries in registry order, with the
 * entry's optional description (`null` when it has none), `on` the schema
 * default, and `feature` the platform flag the row needs (the entry's
 * `requiresFeature`, #1113) or `null`. The partial drops a row whose flag is
 * not on in the build's `platform`.
 *
 * @param {Pick<typeof import("@iracedeck/callout-settings"), "CALLOUT_PI_SECTIONS" | "calloutDefault">} registry
 * @returns {CalloutPiSectionData[]}
 */
export function buildCalloutPiSections({ CALLOUT_PI_SECTIONS, calloutDefault }) {
  return CALLOUT_PI_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    groups: section.groups.map((group) => ({
      id: group.id,
      title: group.title,
      description: group.description,
      rows: group.families.flatMap((family) =>
        Object.values(family.callouts).map((entry) => ({
          setting: entry.key,
          label: entry.label,
          description: entry.description ?? null,
          on: calloutDefault(entry.key),
          feature: entry.requiresFeature ?? null,
        })),
      ),
    })),
  }));
}

function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return listJsFiles(full);

    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/**
 * The sections as the registry's build has them now, plus what a watcher must
 * watch for them to change: every compiled file of the registry. The one
 * function both the build and the tests that render the partial call.
 *
 * @returns {{ entryPath: string, watchFiles: string[], sections: CalloutPiSectionData[] }}
 */
export function loadCalloutPiSections() {
  let out;

  try {
    out = execFileSync(process.execPath, [THIS_FILE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);

    throw new Error(
      `Could not read the @iracedeck/callout-settings registry (is it built?): ${stderr.trim().split("\n")[0]}`,
      { cause: error },
    );
  }

  return JSON.parse(out);
}

// Run as a script: the child side of loadCalloutPiSections.
if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  const entryUrl = import.meta.resolve("@iracedeck/callout-settings");
  const entryPath = url.fileURLToPath(entryUrl);
  const registry = await import(entryUrl);

  process.stdout.write(
    JSON.stringify({
      entryPath,
      watchFiles: listJsFiles(path.dirname(entryPath)),
      sections: buildCalloutPiSections(registry),
    }),
  );
}
