import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plugin-folder suffixes whose `manifest.json` carries the Elgato-style
 * `Version` field the release bumps. Discovery is anchored to these suffixes
 * rather than "any `packages/*​/<dir>/manifest.json` that declares a string
 * `Version`", so an unrelated manifest (e.g. the audio-assets clip manifest)
 * can never be clobbered with the build number (issue #701, defect 3).
 *
 * NOTE: adding a new deck ecosystem whose plugin folder uses a different suffix
 * requires adding that suffix here — otherwise its manifest is silently never
 * bumped.
 */
export const PLUGIN_FOLDER_SUFFIXES = [".sdPlugin", ".ulanziPlugin"];

/**
 * Forward-slashed relative paths to the `manifest.json` of every plugin folder
 * (`*.sdPlugin` / `*.ulanziPlugin`) inside a single package directory.
 *
 * Paths are returned forward-slashed (git accepts them on Windows, and the
 * caller joins them onto `root` only for filesystem access).
 *
 * @param {string} root absolute repository root
 * @param {string} pkgName a directory name under `packages/`
 * @returns {string[]}
 */
export function pluginManifestRelPaths(root, pkgName) {
  const pkgDir = join(root, "packages", pkgName);
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((sub) => sub.isDirectory() && PLUGIN_FOLDER_SUFFIXES.some((suffix) => sub.name.endsWith(suffix)))
    .map((sub) => `packages/${pkgName}/${sub.name}/manifest.json`);
}

/**
 * Discover every versioned JSON file under `packages/*`.
 *
 * Walks `packages/*` once. For each package it resolves the owning
 * `package.json` (its `name` drives the `skip` opt-out, and it is reused so the
 * package.json candidate is not read twice), then keeps every candidate file
 * that carries a string `versionField`. The parsed object is captured on each
 * result so the caller can mutate and re-serialize without a second read+parse
 * (issue #702).
 *
 * `JSON.parse` is intentionally unguarded: a malformed file aborts the release
 * loudly instead of being silently dropped and shipped stale (issue #701,
 * defect 1).
 *
 * @param {string} root absolute repository root
 * @param {object} opts
 * @param {(pkgName: string) => string[]} opts.candidatesFor forward-slashed rel paths to consider for a package
 * @param {string} opts.versionField `"version"` (package.json) or `"Version"` (manifest.json)
 * @param {Set<string>|null} [opts.skip] package names (the `name` field) to opt out of the bump entirely
 * @param {boolean} [opts.required] when true, throw if a candidate path is missing or lacks a string `versionField`
 * @returns {{ rel: string, filePath: string, data: Record<string, unknown> }[]} sorted by `rel`
 */
export function discoverVersionedFiles(root, { candidatesFor, versionField, skip = null, required = false }) {
  const results = [];

  for (const pkgEntry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    // Skips files and (un-followed) symlinks at the packages/* level, as before.
    if (!pkgEntry.isDirectory()) continue;
    const pkgName = pkgEntry.name;

    // Resolve the owning package.json once: it supplies the `name` for `skip`,
    // and is reused below so the package.json candidate is not parsed twice.
    const pkgJsonRel = `packages/${pkgName}/package.json`;
    const pkgJsonPath = join(root, pkgJsonRel);
    const pkgData = existsSync(pkgJsonPath) ? JSON.parse(readFileSync(pkgJsonPath, "utf-8")) : undefined;

    // Opt a package out entirely — both its package.json AND its plugin
    // manifest — before any `required` check, so a skipped plugin's
    // intentionally un-bumped manifest never throws (issue #701, defect 2).
    if (skip && pkgData?.name && skip.has(pkgData.name)) {
      console.log(`  Skipping ${pkgData.name} (opted out via SKIPPED_PACKAGES)`);
      continue;
    }

    for (const rel of candidatesFor(pkgName)) {
      const filePath = join(root, rel);
      if (!existsSync(filePath)) {
        if (required) throw new Error(`Expected ${versionField} file is missing: ${rel}`);
        continue;
      }
      const data = rel === pkgJsonRel && pkgData ? pkgData : JSON.parse(readFileSync(filePath, "utf-8"));
      if (typeof data[versionField] !== "string") {
        if (required) throw new Error(`${rel} has no string "${versionField}" field`);
        continue;
      }
      results.push({ rel, filePath, data });
    }
  }

  // Default string sort (UTF-16 code units), matching the previous `.sort()`.
  return results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
