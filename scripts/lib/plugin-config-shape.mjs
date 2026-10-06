// @ts-check
/**
 * The shape every deck plugin's `rollup.config.mjs` keeps since #1349, read the
 * same way by the five guards that rest on it: `rollup-logs.test.mjs`,
 * `runtime-deps-guard.test.mjs`, `third-party-licenses.test.mjs`,
 * `dev-voice-root-guard.test.mjs` and pi-components' `settings-window-icon.test.ts`.
 *
 * Each guard checks a property the shared factory (`@iracedeck/plugin-build`)
 * owns, so each needs the same three facts about every plugin before its own
 * check means anything: the config imports the factory, its default export is
 * the factory's call, and the package declares `@iracedeck/plugin-build` (which
 * orders its build after the factory's and re-hashes it when the factory
 * changes). Two guards also need the config's literal `extraExternals`, parsed
 * strictly. Both live here once, so the five cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { allPluginManifestRelPaths } from "./version-discovery.mjs";

/** The build-only package whose factory every plugin config calls. */
export const PLUGIN_BUILD_PACKAGE = "@iracedeck/plugin-build";

/** The import line every plugin config carries, verbatim. */
export const FACTORY_IMPORT = 'import { createPluginRollupConfig } from "@iracedeck/plugin-build";';

/** The opening of the one statement a plugin config's default export is, verbatim. */
export const FACTORY_CALL = "export default createPluginRollupConfig({";

/**
 * Every deck plugin, discovered from the committed plugin manifests (the same
 * source the release bump uses), so a fourth deck ecosystem is covered the day
 * its package appears — and a package that merely has a `rollup.config.mjs` is
 * never mistaken for a plugin.
 *
 * @param {string} root absolute repository root
 * @returns {{ pkg: string, folder: string }[]} the package directory under `packages/` and its plugin folder
 */
export function discoverPlugins(root) {
  return allPluginManifestRelPaths(root).map((relPath) => {
    const [, pkg, folder] = relPath.split("/");
    return { pkg, folder };
  });
}

/**
 * A plugin package's `rollup.config.mjs` source and parsed `package.json`.
 *
 * @param {string} root absolute repository root
 * @param {string} pkg the package directory under `packages/`
 * @returns {{ configSource: string, packageJson: Record<string, any> }}
 */
export function readPluginPackage(root, pkg) {
  const dir = join(root, "packages", pkg);
  return {
    configSource: readFileSync(join(dir, "rollup.config.mjs"), "utf-8"),
    packageJson: JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")),
  };
}

/**
 * What keeps a plugin config from building through the shared factory: one
 * message per missing fact, so `expect(problems).toEqual([])` names each.
 *
 * @param {string} configSource the plugin's `rollup.config.mjs`
 * @param {{ devDependencies?: Record<string, string> }} packageJson the plugin's parsed `package.json`
 * @returns {string[]}
 */
export function pluginConfigShapeProblems(configSource, packageJson) {
  const problems = [];
  if (!configSource.includes(FACTORY_IMPORT))
    problems.push(`rollup.config.mjs does not import the factory: ${FACTORY_IMPORT}`);
  if (!configSource.includes(FACTORY_CALL)) {
    problems.push(`rollup.config.mjs does not default-export the factory's config: ${FACTORY_CALL}`);
  }
  if (packageJson.devDependencies?.[PLUGIN_BUILD_PACKAGE] !== "workspace:*") {
    problems.push(`package.json does not declare "${PLUGIN_BUILD_PACKAGE}": "workspace:*" in devDependencies`);
  }
  return problems;
}

/**
 * The literal `extraExternals: [...]` a plugin config passes the factory, or `[]`
 * when it passes none. Anything but a list of double-quoted string literals
 * throws: an identifier, a spread or a computed entry would hide externals from
 * every guard that reads this list.
 *
 * @param {string} configSource the plugin's `rollup.config.mjs`
 * @returns {string[]}
 */
export function parseExtraExternals(configSource) {
  if (!/\bextraExternals\b/.test(configSource)) return [];
  const match = configSource.match(/extraExternals:\s*\[([^\]]*)\]/);
  if (!match) throw new Error("extraExternals must be a literal array");
  const entries = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (!/^"[^"]+"$/.test(entry)) throw new Error(`extraExternals entries must be string literals, got ${entry}`);
  }
  return entries.map((entry) => entry.slice(1, -1));
}
