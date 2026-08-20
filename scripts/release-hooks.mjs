import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildChangelogData, CHANGELOG_DATA_PATH, serializeChangelogData } from "./lib/changelog-data.mjs";
import { formatLocalDate, stampChangelog } from "./lib/changelog-stamp.mjs";
import { allPluginManifestRelPaths, discoverVersionedFiles, pluginManifestRelPaths } from "./lib/version-discovery.mjs";

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
// so an unrelated `packages/<pkg>/<dir>/manifest.json` that happens to declare a
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

// Sanity floor (issue #701, defect 4): abort only when NO plugin folders exist
// on disk at all — the anchor matched nothing (every plugin folder renamed or
// removed, or PLUGIN_FOLDER_SUFFIXES out of date), so no candidates were
// generated and the per-candidate `required` check never fired. An empty
// `manifestFiles` while plugin folders DO exist means every plugin package was
// opted out via SKIPPED_PACKAGES — intentional, so it is not a failure.
if (manifestFiles.length === 0 && allPluginManifestRelPaths(root).length === 0) {
  throw new Error(
    "No plugin manifests found under packages/*/{*.sdPlugin,*.ulanziPlugin} — refusing to release with a potentially stale manifest set.",
  );
}

const numericVersion = version.replace(/[-+].*$/, "");
const buildNumber = execFileSync("git", ["rev-list", "--count", "HEAD"], {
  cwd: root,
  encoding: "utf-8",
}).trim();
const manifestVersion = `${numericVersion}.${buildNumber}`;

// Stamp the changelog's in-development `_Unreleased_` date line with today's
// release date on stable releases (issue #690). stampChangelog is a no-op (with
// a clear reason) for pre-releases and for a missing or already-dated section,
// so a release never fails just because the changelog wasn't pre-staged.
const changelogRel = "packages/website/src/content/docs/changelog.mdx";
const changelogPath = join(root, changelogRel);
const changelogStamp = existsSync(changelogPath)
  ? stampChangelog(readFileSync(changelogPath, "utf-8"), version, formatLocalDate(new Date()))
  : { content: "", stamped: false, reason: `No changelog at ${changelogRel} — skipping date stamp` };

// The plugin ships its OWN copy of these notes (issue #1011), generated from the
// very file we just stamped — so the stamp has to be regenerated into it in the
// same commit. Skipping it would ship a release whose What's New pane calls the
// version the user just installed "Unreleased", and leave the freshness test
// (`scripts/generate-changelog-data.test.mjs`) red on the release commit.
// Built here, before the preflight and before any write, so a malformed
// changelog aborts the release with a clean tree. Deliberately NOT conditional on
// the artifact already existing: if it has been deleted, recreating it is exactly
// what the release needs — guarding on existsSync would ship the release without
// the offline notes it is supposed to carry.
const changelogDataPath = join(root, CHANGELOG_DATA_PATH);
const changelogData = changelogStamp.stamped
  ? serializeChangelogData(buildChangelogData(changelogStamp.content))
  : null;

// Stage the changelog alongside the version files only when it was actually
// stamped, so the preflight and the real `git add` both see it.
const allPaths = [...packageJsonFiles, ...manifestFiles].map(({ rel }) => rel);
if (changelogStamp.stamped) allPaths.push(changelogRel);
if (changelogData !== null) allPaths.push(CHANGELOG_DATA_PATH);

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
  console.log(`  [dry-run] Changelog: ${changelogStamp.reason}`);
  console.log(
    changelogData !== null
      ? `  [dry-run] Would regenerate ${CHANGELOG_DATA_PATH} from the stamped changelog`
      : `  [dry-run] ${CHANGELOG_DATA_PATH} unchanged (changelog not stamped)`,
  );
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

if (changelogStamp.stamped) {
  writeFileSync(changelogPath, changelogStamp.content);
}
console.log(`  ${changelogStamp.reason}`);

if (changelogData !== null) {
  writeFileSync(changelogDataPath, changelogData, "utf-8");
  console.log(`  Regenerated ${CHANGELOG_DATA_PATH} from the stamped changelog`);
}

// Stage all modified files. Use argv form (no shell) so package directory
// names containing spaces or shell metacharacters can't break or inject into
// the git invocation.
execFileSync("git", ["add", "--", ...allPaths], { cwd: root, stdio: "inherit" });
