import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CHANGELOG_SOURCE_PATH } from "./lib/changelog-data.mjs";
import { formatLocalDate, loadChangelogFold } from "./lib/changelog-fold.mjs";
import { manifestVersionFor } from "./lib/manifest-version.mjs";
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
// The `Version` each manifest gets depends on its ecosystem — 4-part for
// `*.sdPlugin`, plain `x.y.z` for `*.ulanziPlugin` — see manifestVersionFor
// (issue #1298).
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

const buildNumber = execFileSync("git", ["rev-list", "--count", "HEAD"], {
  cwd: root,
  encoding: "utf-8",
}).trim();
// Resolved before the preflight so a plugin folder with no decided format
// aborts the release with a clean tree.
const manifestBumps = manifestFiles.map((manifest) => ({
  ...manifest,
  version: manifestVersionFor(manifest.rel, version, buildNumber),
}));

// Fold the changelog fragments in `changelog.d/` into the release's dated
// section on stable releases (issue #1386, `lib/changelog-fold.mjs`). Planned
// here, before the preflight and before any write: every fragment is parsed, the
// section composed with today's local date, and the result run through the What's
// New pane's own parser and renderer, so a malformed fragment aborts the release
// with a clean tree. A pre-release, or a release with no fragments, is a logged
// no-op.
//
// `changelog.json` is no longer written here: it is a gitignored build artifact
// that the release-pack build regenerates from the tag, and staging an ignored
// path would fail the preflight below.
const changelogFold = loadChangelogFold(root, version, formatLocalDate(new Date()));
const changelogPath = join(root, CHANGELOG_SOURCE_PATH);

// The edit and every fragment deletion are staged with the version files, so
// the preflight and the real `git add` both see them.
const allPaths = [...packageJsonFiles, ...manifestFiles].map(({ rel }) => rel);
if (changelogFold.fold) allPaths.push(CHANGELOG_SOURCE_PATH, ...changelogFold.fragmentPaths);

// A fragment git does not track would pass the `git add --dry-run` below, be
// folded and deleted, and then fail the final `git add` — git has nothing to
// stage for a path it never knew — leaving a half-bumped tree. release-it's
// clean-tree check does not see untracked files, so refuse one here.
if (changelogFold.fold) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", ...changelogFold.fragmentPaths], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    throw new Error("Refusing to release: a changelog fragment is not committed (see the git output above).");
  }
}

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
  console.log(`  [dry-run] Would bump ${manifestFiles.length} manifest.json files:`);
  for (const { rel, version: manifestVersion } of manifestBumps) console.log(`    - ${rel} → ${manifestVersion}`);
  console.log(`  [dry-run] Changelog: ${changelogFold.reason}`);
  if (changelogFold.fold) {
    console.log(`  [dry-run] Would write this section into ${CHANGELOG_SOURCE_PATH}:`);
    for (const line of changelogFold.section.trimEnd().split("\n")) console.log(`    |${line && ` ${line}`}`);
    console.log(`  [dry-run] Would delete ${changelogFold.fragmentPaths.length} fragments:`);
    for (const rel of changelogFold.fragmentPaths) console.log(`    - ${rel}`);
  }
  process.exit(0);
}

// Reuse the objects captured during discovery — no second read+parse (#702).
for (const { rel, filePath, data } of packageJsonFiles) {
  data.version = version;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${version}`);
}

for (const { rel, filePath, data, version: manifestVersion } of manifestBumps) {
  data.Version = manifestVersion;
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${manifestVersion}`);
}

if (changelogFold.fold) {
  writeFileSync(changelogPath, changelogFold.content);
  for (const rel of changelogFold.fragmentPaths) {
    unlinkSync(join(root, rel));
    console.log(`  Deleted ${rel}`);
  }
}
console.log(`  ${changelogFold.reason}`);

// Stage all modified files, the fragment deletions included (`git add` of a
// tracked path that no longer exists stages its removal). Use argv form (no
// shell) so package directory names containing spaces or shell metacharacters
// can't break or inject into the git invocation.
execFileSync("git", ["add", "--", ...allPaths], { cwd: root, stdio: "inherit" });
