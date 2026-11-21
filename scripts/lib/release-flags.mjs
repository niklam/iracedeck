// What a release build carries (#1113): the platform feature flags each
// plugin's COMMITTED `platform-features.json` sets, never a developer's
// `feature-flags.local.json`, which only a local build reads. The pack-author
// reference reads them to withhold a catalog feature no plugin ships — the
// rejoin traffic warnings, behind `trafficRejoin` — so the website never
// describes a callout a user cannot have.
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

/** The committed flag files of the three plugins, repo-relative (`.claude/rules/platform-feature-flags.md`). */
export const PLUGIN_FLAG_FILES = Object.freeze(
  ["iracing-plugin-stream-deck", "iracing-plugin-mirabox", "iracing-plugin-ulanzi"].map(
    (pkg) => `packages/${pkg}/platform-features.json`,
  ),
);

/**
 * Each flag the committed files declare, `true` when at least one plugin ships
 * it on: a feature any release build carries is one a pack author can meet.
 *
 * @param {(relative: string) => unknown} [readJson] - Reads a repo-relative JSON file; a test passes its own.
 * @returns {Map<string, boolean>}
 */
export function readReleaseFlags(
  readJson = (relative) => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf-8")),
) {
  /** @type {Map<string, boolean>} */
  const released = new Map();

  for (const file of PLUGIN_FLAG_FILES) {
    const { features } = /** @type {{ features: Record<string, unknown> }} */ (readJson(file));

    for (const [flag, value] of Object.entries(features)) {
      released.set(flag, released.get(flag) === true || value === true);
    }
  }

  return released;
}

/**
 * The names the reference withholds: every development feature whose flag no
 * plugin ships on, merged. A feature naming a flag the files do not declare is
 * refused — a misspelt flag would otherwise withhold the feature forever, or,
 * once fixed the wrong way, publish it unnoticed.
 *
 * @param {readonly import("@iracedeck/audio-scenarios").DevelopmentFeature[]} features
 * @param {ReadonlyMap<string, boolean>} releaseFlags - {@link readReleaseFlags}'s answer.
 * @returns {import("@iracedeck/audio-scenarios").PackReferenceWithheld}
 */
export function withheldDevelopmentFeatures(features, releaseFlags) {
  const unknown = features.filter((feature) => !releaseFlags.has(feature.flag)).map((feature) => feature.flag);

  if (unknown.length > 0) {
    throw new Error(
      `A development feature names the platform flag ${unknown.map((flag) => `"${flag}"`).join(", ")}, ` +
        `which ${PLUGIN_FLAG_FILES.join(", ")} do not declare.`,
    );
  }

  const unreleased = features.filter((feature) => releaseFlags.get(feature.flag) !== true);

  return {
    contracts: unreleased.flatMap((feature) => feature.withheld.contracts),
    vars: unreleased.flatMap((feature) => feature.withheld.vars),
    conds: unreleased.flatMap((feature) => feature.withheld.conds),
    cases: unreleased.flatMap((feature) => feature.withheld.cases),
  };
}
