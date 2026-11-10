import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import semver from "semver";

import { CHANGELOG_SOURCE_PATH } from "./lib/changelog-data.mjs";
import { formatLocalDate, loadChangelogFold } from "./lib/changelog-fold.mjs";
import { CHANGELOG_FRAGMENTS_DIR } from "./lib/changelog-fragments.mjs";
import { manifestVersionFor } from "./lib/manifest-version.mjs";
import { loadPackRecordModule } from "./lib/pack-record-module.mjs";
import { allPluginManifestRelPaths, discoverVersionedFiles, pluginManifestRelPaths } from "./lib/version-discovery.mjs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node release-hooks.mjs <version>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

/** A path under `root` as git and the messages name it: relative, forward slashes. */
const relativeToRoot = (file) => path.relative(root, file).split(path.sep).join("/");

// Does releasing `version` publish the voice packs, so their records are
// sealed? Yes for every version without a `dev` prerelease identifier — a
// stable `3.9.0` or an `-rc.1`, the ones that are tagged and whose tag run
// publishes every pack (#1667). A `-dev.0` bump is committed untagged and
// publishes nothing, so sealing on it would freeze a version bumped on master
// but not yet published, and force a needless second bump on its next change.
// semver's own parse decides: `3.9.0-dev.0` has the identifiers `dev` and `0`,
// `3.9.0-rc.1` has `rc` and `1`, `3.9.0` has none. release-it hands over a
// valid version; anything else is refused rather than guessed about.
const parsedVersion = semver.parse(version);
if (parsedVersion === null) {
  throw new Error(`Refusing to release: "${version}" is not a semver version.`);
}
const sealsVoicePacks = !parsedVersion.prerelease.includes("dev");

// The voice-pack record module (#1667) reaches `@iracedeck/callout-script`
// through its `dist/`, which only `pnpm build` writes, so it is loaded here
// rather than imported statically: on an unbuilt or cleaned tree the release
// stops with a sentence naming the build instead of a raw module-not-found
// from inside the package. Nothing has been written at this point.
let formatPackRecordProblems;
let PACK_RECORDS_DIR;
let sealPackRecords;
try {
  ({ formatPackRecordProblems, PACK_RECORDS_DIR, sealPackRecords } = await loadPackRecordModule());
} catch (err) {
  throw new Error(`Refusing to release: ${err instanceof Error ? err.message : err}`);
}

/** `packages/audio-assets/pack-records`, as the restore command names it. */
const PACK_RECORDS_REL = relativeToRoot(PACK_RECORDS_DIR);

// Every voice pack is held to its record's four rules on every release — a
// stale record (the pack's clips, script or version changed with no re-pack,
// #1582) or a re-pack under a published version aborts the release here, with a
// clean tree, naming the pack and the command to run. Planned as a dry seal,
// so this also knows which records the real seal below will write and stage:
// `released` is set on every pack whose current version is not yet sealed, on a
// version that publishes. Nothing is written yet; `sealPackRecords` checks every
// pack before it would write any, and throws with the problems attached.
let voicePackSeal;
try {
  voicePackSeal = sealPackRecords({ dryRun: true });
} catch (err) {
  if (!Array.isArray(err?.problems)) throw err;
  throw new Error(
    `Refusing to release: a voice pack's committed record disagrees with the tree, so its catalog entry would not ` +
      `be what the release publishes. Nothing was written.\n${formatPackRecordProblems(err.problems)}`,
  );
}
const voicePackRecordPaths = sealsVoicePacks ? voicePackSeal.sealed.map(({ path: file }) => relativeToRoot(file)) : [];
// What is said when no record is written; when some are, each is named as it is sealed.
const voicePackSummary = !sealsVoicePacks
  ? "Voice packs: records checked; a -dev bump publishes no pack, so nothing is sealed"
  : voicePackSeal.sealed.length === 0
    ? "Voice packs: records checked; every pack is already sealed at its version"
    : null;

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

// The changelog edit and the sealed voice-pack records are staged with the
// version files, so the preflight and the real `git add` both see them. The
// fragments are not in this list: one `git rm` deletes and stages them all (see
// the fold below).
const allPaths = [...packageJsonFiles, ...manifestFiles].map(({ rel }) => rel);
if (changelogFold.fold) allPaths.push(CHANGELOG_SOURCE_PATH);
allPaths.push(...voicePackRecordPaths);

// A fragment git does not track would be folded and then fail the `git rm`
// below — git cannot remove a path it never knew — leaving a half-folded tree.
// release-it's clean-tree check does not see untracked files, so refuse one
// here, with a message that says what is wrong rather than git's pathspec error.
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
// The same preflight for the fragments: `git rm --dry-run` refuses everything the
// real one would (an untracked path, a fragment with staged or unstaged edits)
// without touching the tree or the index.
if (changelogFold.fold) {
  try {
    execFileSync("git", ["rm", "-q", "--dry-run", "--", ...changelogFold.fragmentPaths], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    throw new Error("Refusing to release: git would not remove a changelog fragment (see the git output above).");
  }
}

// The preview. release-it 21.1.1 does NOT run before:bump hooks in its own dry
// run — it logs `! node scripts/release-hooks.mjs <version>` and skips the
// command — so `scripts/release.mjs` runs this hook itself on `pnpm release:dry`,
// with the version release-it resolved and RELEASE_IT_DRY_RUN=1, which is what
// makes this branch print what the release would do and write nothing. The flag
// is also set for release-it's own dry run, so a release-it that ran hooks in a
// dry run again (older versions did) would still write nothing here.
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
  if (voicePackSummary !== null) console.log(`  [dry-run] ${voicePackSummary}`);
  if (voicePackRecordPaths.length > 0) {
    console.log(`  [dry-run] Would seal ${voicePackRecordPaths.length} voice-pack records as released:`);
    for (const { id, version: packVersion, sha256, path: file } of voicePackSeal.sealed) {
      console.log(`    - ${relativeToRoot(file)}: ${id} ${packVersion} (sha256 ${sha256})`);
    }
  }
  process.exit(0);
}

// The fold goes first, ordered so that a failure part-way leaves the least to
// undo, and never a tree a second run would fold twice:
//
// 1. `changelog.mdx` gets its dated section. Fail here and nothing else has changed.
// 2. One `git rm` deletes and stages every fragment. On Windows an unlink can
//    fail (EBUSY, EPERM) while an editor or a scanner holds the file. git stops
//    with an error only when the FIRST unlink fails; once it has removed one file
//    it warns, carries on, stages every removal and exits 0, leaving the locked
//    fragment on disk. So success is checked on disk, not by the exit code: a
//    fragment still present stops the release the same way. A re-run refuses a
//    tree holding the folded changelog beside fragments rather than folding them
//    again: composing in fold mode refuses a `## <version>` section that already
//    exists while fragments remain, naming the half-folded tree. A preview (the
//    readers: the build's changelog data and the website) refuses that tree
//    too, naming the same remedy: its root version is not bumped yet, so it is
//    behind the section just written or a pre-release of it, never exactly it,
//    which is the window after a release that composes the fragments as
//    `## Unreleased` (#1398); and its fragments repeat the bullets just written,
//    which is refused on its own. The fragments are committed (checked above), so
//    `git restore` brings it all back. stdin is not a terminal, so Git for
//    Windows' "Unlink of file failed. Should I try again?" prompt never waits
//    on the release.
// 3. Only then are the version files bumped.
if (changelogFold.fold) {
  writeFileSync(changelogPath, changelogFold.content);
  const restore =
    `The version files are untouched. Restore the tree with \`git restore --staged --worktree -- ${CHANGELOG_SOURCE_PATH} ${CHANGELOG_FRAGMENTS_DIR}\`, ` +
    `then release again.`;
  try {
    execFileSync("git", ["rm", "-q", "--", ...changelogFold.fragmentPaths], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    throw new Error(
      `The changelog fold stopped part-way: ${CHANGELOG_SOURCE_PATH} is written but git could not remove every fragment (see the git output above). ${restore}`,
    );
  }
  const left = changelogFold.fragmentPaths.filter((rel) => existsSync(join(root, rel)));
  if (left.length > 0) {
    throw new Error(
      `The changelog fold stopped part-way: git staged every fragment's removal but could not delete ${left.join(", ")} from disk. ${restore}`,
    );
  }
  for (const rel of changelogFold.fragmentPaths) console.log(`  Deleted ${rel}`);
}
console.log(`  ${changelogFold.reason}`);

// The seal comes after the fold and before the version bumps, so the fold's
// own part-way messages above stay true (the version files AND the records are
// untouched when the fold stops), and a seal that fails leaves the least to
// undo: the fold's edits and whatever records were written, never a bumped
// version file. The records are staged by the `git add` at the end, with the
// version files. `sealPackRecords` re-checks every pack and writes only once
// every record is built, so a failure here is a write that did not land, and
// the message names everything the tree now holds.
if (sealsVoicePacks) {
  let sealed;
  try {
    ({ sealed } = sealPackRecords());
  } catch (err) {
    const foldState = changelogFold.fold
      ? `the changelog fold is done (${CHANGELOG_SOURCE_PATH} is written and the fragments are removed), `
      : "";
    throw new Error(
      `The release stopped part-way: ${foldState}but sealing the voice-pack records failed — ` +
        `${err instanceof Error ? err.message : err}\nThe version files are untouched. Restore the tree with ` +
        `\`git restore --staged --worktree -- ${CHANGELOG_SOURCE_PATH} ${CHANGELOG_FRAGMENTS_DIR} ${PACK_RECORDS_REL}\`, ` +
        `then release again.`,
    );
  }
  // The plan above decided what the preflight checked and what `git add` stages
  // below; the real seal must have written exactly that. The tree did not change
  // in between, so a difference is a bug here, and staging would miss a file.
  const planned = voicePackSeal.sealed.map(({ path: file }) => relativeToRoot(file));
  const written = sealed.map(({ path: file }) => relativeToRoot(file));
  if (planned.join("\n") !== written.join("\n")) {
    throw new Error(
      `The release stopped part-way: the voice-pack seal wrote ${written.join(", ") || "nothing"} but the preflight ` +
        `planned ${planned.join(", ") || "nothing"}. The version files are untouched. Restore the tree with ` +
        `\`git restore --staged --worktree -- ${CHANGELOG_SOURCE_PATH} ${CHANGELOG_FRAGMENTS_DIR} ${PACK_RECORDS_REL}\`, ` +
        `then release again.`,
    );
  }
  for (const { id, version: packVersion, path: file } of sealed) {
    console.log(`  Sealed ${relativeToRoot(file)}: ${id} ${packVersion} released`);
  }
}
if (voicePackSummary !== null) console.log(`  ${voicePackSummary}`);

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

// Stage all modified files; the fragment deletions are staged already. Use argv
// form (no shell) so package directory names containing spaces or shell
// metacharacters can't break or inject into the git invocation.
execFileSync("git", ["add", "--", ...allPaths], { cwd: root, stdio: "inherit" });
