import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { discoverVersionedFiles, pluginManifestRelPaths } from "./lib/version-discovery.mjs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node release-hooks.mjs <version>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// Packages that intentionally track their own versions and must NOT be bumped
// by the release process. Empty today — add the package name here if a
// package ever decouples from the monorepo's shared version. A skipped package
// opts BOTH its package.json and its plugin manifest out of the bump.
const SKIPPED_PACKAGES = new Set();

// Discover the files to bump. `package.json` (`version`) and plugin
// `manifest.json` (`Version`) share discoverVersionedFiles() so the parse-error
// handling, SKIPPED_PACKAGES opt-out, and sort stay identical for both file
// types (issue #702 — the two hand-rolled pipelines had drifted: the manifest
// one swallowed parse errors and ignored SKIPPED_PACKAGES, issue #701).
//
// The previous hardcoded lists silently skipped new entries — eight packages
// drifted multiple minors behind (issue #435) and the Ulanzi manifest stayed at
// 1.22.0.0 while the others advanced — which is why both are auto-discovered.
const packageJsonFiles = discoverVersionedFiles(root, {
  candidatesFor: (pkgName) => [`packages/${pkgName}/package.json`],
  versionField: "version",
  skip: SKIPPED_PACKAGES,
});

// Manifests are anchored to real plugin folders (`*.sdPlugin` / `*.ulanziPlugin`)
// so an unrelated `packages/*​/<dir>/manifest.json` that happens to declare a
// string `Version` is never clobbered (issue #701, defect 3). `required: true`
// makes a plugin folder whose manifest is missing or malformed abort the
// release rather than ship it stale (defect 4).
//
// Elgato's manifest schema requires a strict 4-part numeric format
// `{major}.{minor}.{patch}.{build}` (^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$), so
// semver pre-release / build metadata suffixes must be stripped. The build slot
// is populated from `git rev-list --count HEAD` so each release (pre or final
// alike) gets a unique 4-part version; the final naturally outranks its
// preceding pre-releases because release-it commits the version bump between
// runs, which advances the commit count.
const manifestFiles = discoverVersionedFiles(root, {
  candidatesFor: (pkgName) => pluginManifestRelPaths(root, pkgName),
  versionField: "Version",
  skip: SKIPPED_PACKAGES,
  required: true,
});

// Sanity floor (issue #701, defect 4): if the plugin-folder anchor matched
// nothing — every plugin folder renamed/removed, or PLUGIN_FOLDER_SUFFIXES out
// of date — no candidates are generated and the per-candidate `required` check
// never fires; only an explicit floor catches that. (All plugins landing in
// SKIPPED_PACKAGES would also trip this, which is review-worthy, not silent.)
if (manifestFiles.length === 0) {
  throw new Error("No plugin manifests discovered — refusing to release with a potentially stale manifest set.");
}

const numericVersion = version.replace(/[-+].*$/, "");
const buildNumber = execFileSync("git", ["rev-list", "--count", "HEAD"], {
  cwd: root,
  encoding: "utf-8",
}).trim();
const manifestVersion = `${numericVersion}.${buildNumber}`;

const allPaths = [...packageJsonFiles, ...manifestFiles].map(({ rel }) => rel);

// Preflight (issue #701, defect 5): confirm every file we're about to bump can
// be staged BEFORE writing anything. `git add --dry-run` mirrors the real
// `git add` exactly (a gitignored path makes it exit non-zero and name the
// offender) but touches neither the working tree nor the index — so a stray
// ignored path aborts here with a clean tree instead of throwing mid-write and
// leaving a half-bumped tree behind. Runs before the dry-run branch so
// `release:dry` is a true preflight. The real `git add` below deliberately
// stays without `-f`: force-adding a gitignored build artifact into a release
// commit is the wrong fix.
try {
  execFileSync("git", ["add", "--dry-run", "--", ...allPaths], { cwd: root, stdio: "inherit" });
} catch {
  throw new Error("Refusing to release: a file slated for a version bump is gitignored (see the git output above).");
}

// release-it runs before:bump hooks even in dry-run mode, which would otherwise
// modify real package.json / manifest.json files and stage them with `git add`.
// `scripts/release.mjs` sets RELEASE_IT_DRY_RUN=1 when --dry-run is passed.
if (process.env.RELEASE_IT_DRY_RUN === "1") {
  console.log(`  [dry-run] Would bump ${packageJsonFiles.length} package.json files to version ${version}:`);
  for (const { rel } of packageJsonFiles) console.log(`    - ${rel}`);
  console.log(`  [dry-run] Would bump ${manifestFiles.length} manifest.json files to version ${manifestVersion}:`);
  for (const { rel } of manifestFiles) console.log(`    - ${rel}`);
  process.exit(0);
}

// Reuse the objects captured during discovery — no second read+parse (#702).
for (const { rel, filePath, data } of packageJsonFiles) {
  data.version = version;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${version}`);
}

for (const { rel, filePath, data } of manifestFiles) {
  data.Version = manifestVersion;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${manifestVersion}`);
}

// Stage all modified files. Use argv form (no shell) so package directory
// names containing spaces or shell metacharacters can't break or inject into
// the git invocation.
execFileSync("git", ["add", "--", ...allPaths], { cwd: root, stdio: "inherit" });
