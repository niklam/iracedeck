import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPackRecord,
  computePackInputs,
  readPackRecord,
  serializePackRecord,
  writePackRecord,
} from "../packages/audio-assets/src/build/pack-record.mjs";
import { VOICE_PACKS } from "../packages/audio-assets/src/build/voice-packs.mjs";
import { buildChangelogData, CHANGELOG_DATA_PATH, CHANGELOG_SOURCE_PATH } from "./lib/changelog-data.mjs";
import { formatLocalDate } from "./lib/changelog-fold.mjs";
import { composeChangelog, loadChangelogSources } from "./lib/changelog-fragments.mjs";
import { UNRELEASED_LABEL } from "./lib/changelog-parse.mjs";

// scripts/release-hooks.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
}

function runHook(version) {
  return execFileSync("node", ["scripts/release-hooks.mjs", version], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, RELEASE_IT_DRY_RUN: "1" },
  });
}

// Both cases here run a PRE-RELEASE on purpose. A stable dry run reads this
// checkout's changelog.d/ and refuses an uncommitted fragment, which is the
// normal state while one is being written and tested, so it would make
// `pnpm test` depend on the developer's working tree. The stable path, the fold
// and its dry run included, is exercised in the temporary repositories below.
// Each run of the hook here hashes this checkout's real voice tree (about
// 175 MB) for the voice-pack check (#1667), so the default 5 s is too tight on
// a loaded machine; the timeout matches the fixture suites below.
describe("release-hooks.mjs (dry run over this repository)", { timeout: 60_000 }, () => {
  it("discovers all three plugin manifests and stages nothing", () => {
    const before = git("status", "--porcelain");

    const stdout = runHook("9.9.9-rc.1");

    // The dry-run preflight + branch must not touch the tree or the index.
    expect(git("status", "--porcelain")).toBe(before);

    expect(stdout).toMatch(/Would bump \d+ manifest\.json files/);
    // The three live plugin manifests, including the Ulanzi one the old static
    // list silently skipped.
    expect(stdout).toContain("packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json");
    expect(stdout).toContain("packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json");
    expect(stdout).toContain("packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/manifest.json");
  });

  // The real tree's two pack records are held to the four rules on every
  // release (#1667); `pack-record.test.ts` is what keeps them fresh, so a red
  // here with a green there is the hook's own fault.
  it("checks the voice-pack records of this checkout and reports the seal it would write", () => {
    const stdout = runHook("9.9.9-rc.1");

    expect(stdout).toMatch(/\[dry-run\] (Voice packs: records checked|Would seal \d+ voice-pack records)/);
    expect(runHook("9.9.9-dev.0")).toContain(
      "[dry-run] Voice packs: records checked; a -dev bump publishes no pack, so nothing is sealed",
    );
  });

  it("stamps each ecosystem's manifest in its own format", () => {
    // Elgato's schema needs x.y.z.<build>; the Ulanzi marketplace refuses
    // anything but x.y.z (#1298). A pre-release proves the suffix is stripped.
    const stdout = runHook("9.9.9-rc.1");

    expect(stdout).toMatch(/stream-deck\/com\.iracedeck\.sd\.core\.sdPlugin\/manifest\.json → 9\.9\.9\.\d+$/m);
    expect(stdout).toMatch(/mirabox\/com\.iracedeck\.sd\.core\.sdPlugin\/manifest\.json → 9\.9\.9\.\d+$/m);
    expect(stdout).toMatch(/ulanzi\/com\.ulanzi\.iracedeck\.ulanziPlugin\/manifest\.json → 9\.9\.9$/m);
  });
});

// ---------------------------------------------------------------------------
// The fold (#1386), run for real in a temporary git repository. The hook and
// its lib/ are copied in, so the repository root it derives from its own path is
// the fixture: what runs is the shipped script, not a test double.
// ---------------------------------------------------------------------------

const MDX = `---
title: Changelog
---

Release notes.

## 0.9.0

_2026-06-25_

**Bug Fixes**

- An older fix.
`;

// Tracked in the fixture on purpose: a hook that wrote or staged it would show.
const CHANGELOG_DATA_SENTINEL = '{ "sentinel": true }\n';

const PLUGIN_MANIFEST = "packages/demo-plugin/com.example.demo.sdPlugin/manifest.json";

const VERSION_FILES = [
  "M\tpackages/demo-plugin/package.json",
  "M\tpackages/demo/package.json",
  `M\t${PLUGIN_MANIFEST}`,
];

// The voice packs (#1667). The fixture carries the REAL registry
// (`voice-packs.mjs`, copied in with the record module), a tiny clip tree and
// config per voice, a catalog entry per pack at `PACK_SHA`, and a record that
// agrees with all of it, so the hook runs the real checker and sealer against a
// tree the test controls.
const AUDIO_ASSETS = "packages/audio-assets";
const PACK_RECORDS = `${AUDIO_ASSETS}/pack-records`;
const PACK_SHA = "4a".repeat(32);
const RECORD_FILES = VOICE_PACKS.map((pack) => `M\t${PACK_RECORDS}/${pack.id}.json`);

/** @type {string[]} */
const fixtures = [];

/** Every junction a fixture made into this checkout, removed as a LINK before its fixture is removed. */
const junctions = [];

/**
 * Remove a directory junction (or, off Windows, a directory symlink) without
 * touching what it points at: `unlinkSync` removes a symlink on every platform
 * and a junction on Windows; `rmdirSync` is the fallback for a Windows build
 * that refuses to unlink a directory reparse point. Either way the target is
 * untouched, and the entry must be gone afterwards — a link that is still there
 * would be walked by the recursive remove that follows.
 *
 * @param {string} link
 */
function removeLink(link) {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;

  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }

  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`the junction ${link} is still there after unlink and rmdir; not removing its fixture`);
  }
}

afterEach(() => {
  // The fixture's `node_modules`, `packages/audio-assets/node_modules` and
  // `packages/callout-script` are junctions into this checkout. Each is removed
  // as a link first, so the recursive remove of the fixture never depends on
  // rmSync declining to follow one into the checkout's dependencies or sources.
  for (const link of junctions.splice(0)) removeLink(link);
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fragmentText(category, weight, body) {
  return `---\ncategory: ${category}\nweight: ${weight}\n---\n\n${body}\n`;
}

function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function read(dir, rel) {
  return readFileSync(join(dir, rel), "utf8");
}

function fixtureGit(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitAll(dir, message) {
  fixtureGit(dir, "add", "-A");
  fixtureGit(dir, "commit", "-q", "-m", message);
}

function writeJson(dir, rel, value) {
  write(dir, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy every non-test `.mjs` of `rel` from this checkout into the fixture. */
function copyModules(dir, rel) {
  mkdirSync(join(dir, rel), { recursive: true });
  for (const name of readdirSync(join(repoRoot, rel))) {
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      copyFileSync(join(repoRoot, rel, name), join(dir, rel, name));
  }
}

/**
 * The fixture's voice-pack roots: the record module copied into the fixture
 * derives `packages/audio-assets` from its own location, so these are the
 * directories the hook's checker and sealer read.
 */
function packRoots(dir) {
  const audioAssets = join(dir, AUDIO_ASSETS);
  return {
    srcRoot: join(audioAssets, "voice"),
    configsDir: join(audioAssets, "configs"),
    catalogDir: join(audioAssets, "catalog"),
    recordsDir: join(audioAssets, "pack-records"),
  };
}

/**
 * Seed every pack of the real registry: two clips and a script per voice, the
 * voice's config, a catalog entry at `PACK_SHA`, and a record agreeing with
 * all of it — sealed at the pack's version unless asked otherwise, the state a
 * tree is in after a release that shipped the pack.
 */
function seedVoicePacks(dir, { sealed }) {
  const roots = packRoots(dir);
  for (const pack of VOICE_PACKS) {
    for (const voiceId of pack.voices) {
      write(dir, `${AUDIO_ASSETS}/voice/${voiceId}/numbers/1.mp3`, `${voiceId} one`);
      write(dir, `${AUDIO_ASSETS}/voice/${voiceId}/seconds/1.mp3`, `${voiceId} one second`);
      write(dir, `${AUDIO_ASSETS}/voice/${voiceId}/${CALLOUT_SCRIPT_FILE}`, `{"voice":"${voiceId}"}\n`);
      writeJson(dir, `${AUDIO_ASSETS}/configs/${voiceId}.voice.json`, { label: `Voice ${voiceId}` });
    }
    writeJson(dir, `${AUDIO_ASSETS}/catalog/${pack.id}.json`, {
      id: pack.id,
      version: pack.version,
      bytes: 3,
      sha256: PACK_SHA,
    });
    writePackRecord(
      buildPackRecord(pack, {
        sha256: PACK_SHA,
        inputs: computePackInputs(pack, roots),
        released: sealed ? { version: pack.version, sha256: PACK_SHA } : undefined,
      }),
      roots.recordsDir,
    );
  }
}

/** The record the sealer writes for `pack` over a fixture record: the same, plus `released`. */
function sealedRecordBytes(dir, pack) {
  const record = readPackRecord(pack.id, packRoots(dir).recordsDir);
  return serializePackRecord(
    buildPackRecord(pack, {
      sha256: record.sha256,
      inputs: record.inputs,
      released: { version: pack.version, sha256: record.sha256 },
    }),
  );
}

/**
 * A minimal repository the hook can release: two packages, one plugin manifest,
 * the changelog, its tracked data artifact and the fragments, and the voice
 * packs with their records, all committed on `master`.
 *
 * The hook imports the record module by its path in the tree, so the module and
 * its siblings are copied in beside it, and the fixture's two `node_modules`
 * and `packages/callout-script` are junctions into this checkout's: the copies
 * resolve `semver`, `zod`, `fflate`, `ffmpeg-static` and
 * `@iracedeck/callout-script` exactly as the originals do, so the pipeline and
 * archive-format identities hash the same. Windows resolves a relative symlink
 * against the path as traversed, not the link's real location, which is why
 * pnpm's `@iracedeck/callout-script -> ../../../callout-script` needs that
 * workspace package at the same place in the fixture, and `zod ->
 * ../../../node_modules/.pnpm/…` the root `node_modules`. The junctions are
 * gitignored, so `git add -A` and the fixture's status never see them, and
 * `snapshot` skips them.
 *
 * @param {Record<string, string>} fragments - file name → fragment text
 * @param {{ unsealedPacks?: boolean; unbuilt?: boolean }} [options] - `unsealedPacks`: the records
 *   carry no `released`, the state before the first release that ships them; `unbuilt`:
 *   `@iracedeck/callout-script` is a stub with its package.json and no dist/, so the record
 *   module's import of it fails as it does on a fresh clone or after `pnpm clean`
 */
function makeRepo(fragments, { unsealedPacks = false, unbuilt = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "iracedeck-release-hooks-"));
  fixtures.push(dir);

  copyModules(dir, join("scripts", "lib"));
  copyFileSync(join(repoRoot, "scripts", "release-hooks.mjs"), join(dir, "scripts", "release-hooks.mjs"));
  copyModules(dir, join(AUDIO_ASSETS, "src", "build"));
  copyModules(dir, join(AUDIO_ASSETS, "src"));
  const link = (rel) => {
    const at = join(dir, rel);
    symlinkSync(join(repoRoot, rel), at, "junction");
    junctions.push(at);
  };
  link("node_modules");
  if (unbuilt) {
    // The package's own node_modules is rebuilt entry by entry, with
    // `@iracedeck/callout-script` a stub: its real package.json and no dist/.
    // Dropping only the `packages/callout-script` junction is not enough: on
    // Linux the junctioned `@iracedeck/callout-script` link resolves against
    // its real location and finds this checkout's built package.
    const modules = `${AUDIO_ASSETS}/node_modules`;
    const scope = `${modules}/@iracedeck`;
    mkdirSync(join(dir, scope), { recursive: true });
    for (const name of readdirSync(join(repoRoot, modules))) if (name !== "@iracedeck") link(`${modules}/${name}`);
    for (const name of readdirSync(join(repoRoot, scope))) if (name !== "callout-script") link(`${scope}/${name}`);
    mkdirSync(join(dir, scope, "callout-script"));
    copyFileSync(
      join(repoRoot, "packages", "callout-script", "package.json"),
      join(dir, scope, "callout-script", "package.json"),
    );
  } else {
    link(`${AUDIO_ASSETS}/node_modules`);
    link("packages/callout-script");
  }
  write(dir, ".gitignore", "node_modules/\n/packages/callout-script/\n");
  seedVoicePacks(dir, { sealed: !unsealedPacks });

  writeJson(dir, "package.json", { name: "fixture", version: "1.0.0-dev.0" });
  writeJson(dir, "packages/demo/package.json", { name: "demo", version: "1.0.0-dev.0" });
  writeJson(dir, "packages/demo-plugin/package.json", { name: "demo-plugin", version: "1.0.0-dev.0" });
  writeJson(dir, PLUGIN_MANIFEST, { Name: "Demo", Version: "0.9.0.0" });
  write(dir, CHANGELOG_SOURCE_PATH, MDX);
  write(dir, CHANGELOG_DATA_PATH, CHANGELOG_DATA_SENTINEL);
  write(dir, "changelog.d/README.md", "# Changelog fragments\n");
  for (const [name, text] of Object.entries(fragments)) write(dir, `changelog.d/${name}`, text);

  fixtureGit(dir, "init", "-q", "-b", "master");
  fixtureGit(dir, "config", "user.name", "Fixture");
  fixtureGit(dir, "config", "user.email", "fixture@example.invalid");
  fixtureGit(dir, "config", "core.autocrlf", "false");
  fixtureGit(dir, "config", "commit.gpgsign", "false");
  fixtureGit(dir, "config", "core.hooksPath", join(dir, ".no-hooks"));
  commitAll(dir, "initial");
  return dir;
}

/** Run the copied hook; returns its exit status and output instead of throwing. */
function runFixtureHook(dir, version, { dryRun = false, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.RELEASE_IT_DRY_RUN;
  if (dryRun) env.RELEASE_IT_DRY_RUN = "1";
  const result = spawnSync("node", ["scripts/release-hooks.mjs", version], { cwd: dir, encoding: "utf-8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every file's bytes plus git's view of the tree and index, so "untouched" means exactly that. */
function snapshot(dir) {
  const files = {};
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else files[child] = read(dir, child);
    }
  };
  walk("");
  return { files, status: fixtureGit(dir, "status", "--porcelain") };
}

function staged(dir) {
  return fixtureGit(dir, "diff", "--cached", "--name-status").trim().split("\n").filter(Boolean).sort();
}

const TWO_FRAGMENTS = {
  "11-a-feature.md": fragmentText("Features", 50, "A shiny new thing."),
  "12-a-fix.md": fragmentText("Bug Fixes", 50, "A new fix."),
};

/**
 * Release `version` as release-it does: the hook bumps the packages and the
 * manifest, folds the changelog on a stable version and stages it all, then
 * release-it bumps the root package.json itself and commits everything as
 * `chore(release): v<version>`.
 */
function releaseAsReleaseIt(dir, version) {
  const result = runFixtureHook(dir, version);
  expect(result.status, result.stderr).toBe(0);
  writeJson(dir, "package.json", { name: "fixture", version });
  fixtureGit(dir, "add", "--", "package.json");
  fixtureGit(dir, "commit", "-q", "-m", `chore(release): v${version}`);
  expect(fixtureGit(dir, "status", "--porcelain")).toBe("");
  return result;
}

/**
 * What every reader composes from the tree on disk (a preview, as
 * `changelog-composed.mjs` and the website plugin run it): the composed text,
 * and each release of the parsed data as `[version, null | "dated"]`.
 */
function composeTree(dir) {
  const sources = loadChangelogSources(dir);
  const text = composeChangelog(sources.mdx, sources.fragments, sources.version, { mode: "preview" });
  const releases = buildChangelogData(text).releases.map(({ version, date }) => [
    version,
    date === null ? null : "dated",
  ]);
  return { text, releases };
}

/**
 * Back-merge `branch` into the checked-out branch with a regular merge, as
 * build-and-commit.md prescribes: each conflict is resolved in the checked-out
 * side's favour by stripping the markers in place, keeping that side's hunk and
 * everything git merged around it, never by taking the whole file. Returns the
 * paths that conflicted, sorted.
 */
function backMerge(dir, branch) {
  // The fixture inherits the developer's git config; the resolution below reads
  // the two-sided marker style, so a global diff3 / zdiff3 must not apply here.
  fixtureGit(dir, "config", "merge.conflictStyle", "merge");
  const merge = spawnSync("git", ["merge", "-q", "--no-ff", "--no-edit", branch], { cwd: dir, encoding: "utf-8" });
  const conflicted = fixtureGit(dir, "diff", "--name-only", "--diff-filter=U")
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  if (conflicted.length === 0) {
    expect(merge.status, `${merge.stdout}${merge.stderr}`).toBe(0);
    return conflicted;
  }
  for (const rel of conflicted) {
    const resolved = read(dir, rel).replace(/^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n[\s\S]*?^>>>>>>> [^\n]*\n/gm, "$1");
    expect(resolved, rel).not.toMatch(/^(<{7}|={7}|>{7})/m);
    write(dir, rel, resolved);
  }
  fixtureGit(dir, "add", "--", ...conflicted);
  fixtureGit(dir, "commit", "-q", "--no-edit");
  expect(fixtureGit(dir, "status", "--porcelain")).toBe("");
  return conflicted;
}

describe("release-hooks.mjs fold (in a temporary git repository)", { timeout: 60_000 }, () => {
  it("folds the fragments into a dated section on a stable release and stages the edit and the deletions", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    const dayBefore = formatLocalDate(new Date());

    const result = runFixtureHook(dir, "1.0.0");

    const dayAfter = formatLocalDate(new Date());
    expect(result.status, result.stderr).toBe(0);
    const mdx = read(dir, CHANGELOG_SOURCE_PATH);
    const date = mdx.includes(`_${dayBefore}_`) ? dayBefore : dayAfter;
    expect(mdx).toBe(
      MDX.replace(
        "## 0.9.0",
        `## 1.0.0\n\n_${date}_\n\n**Features**\n\n- A shiny new thing.\n\n**Bug Fixes**\n\n- A new fix.\n\n## 0.9.0`,
      ),
    );

    expect(existsSync(join(dir, "changelog.d/11-a-feature.md"))).toBe(false);
    expect(existsSync(join(dir, "changelog.d/12-a-fix.md"))).toBe(false);
    expect(existsSync(join(dir, "changelog.d/README.md"))).toBe(true);

    // The changelog edit and the deletions ride in the bump commit with the
    // version files; changelog.json is neither written nor staged.
    expect(staged(dir)).toEqual(
      [
        ...VERSION_FILES,
        "D\tchangelog.d/11-a-feature.md",
        "D\tchangelog.d/12-a-fix.md",
        `M\t${CHANGELOG_SOURCE_PATH}`,
      ].sort(),
    );
    expect(read(dir, CHANGELOG_DATA_PATH)).toBe(CHANGELOG_DATA_SENTINEL);
    // Nothing is left unstaged.
    expect(fixtureGit(dir, "diff", "--name-only")).toBe("");
    expect(result.stdout).toContain('Folded 2 fragments into "## 1.0.0"');
  });

  it("removes and stages every fragment with one git rm, and stages nothing else of changelog.d/", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    const traceDir = mkdtempSync(join(tmpdir(), "iracedeck-release-hooks-trace-"));
    fixtures.push(traceDir);

    const result = runFixtureHook(dir, "1.0.0", { extraEnv: { GIT_TRACE: join(traceDir, "trace.txt") } });

    expect(result.status, result.stderr).toBe(0);
    const commands = read(traceDir, "trace.txt")
      .split("\n")
      .map((line) => /trace: built-in: (git .*)$/.exec(line)?.[1])
      .filter(Boolean);
    // The preflight's dry run, then the one real removal naming both fragments.
    expect(commands.filter((command) => command.startsWith("git rm "))).toEqual([
      "git rm -q --dry-run -- changelog.d/11-a-feature.md changelog.d/12-a-fix.md",
      "git rm -q -- changelog.d/11-a-feature.md changelog.d/12-a-fix.md",
    ]);
    // No `git add` names a fragment: the deletions were staged by `git rm` alone.
    expect(commands.filter((command) => command.startsWith("git add ") && command.includes("changelog.d/"))).toEqual(
      [],
    );
    expect(staged(dir)).toContain("D\tchangelog.d/11-a-feature.md");
    expect(staged(dir)).toContain("D\tchangelog.d/12-a-fix.md");
  });

  it("refuses a half-folded tree on a re-run rather than folding the fragments twice", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    // The state a `git rm` that failed part-way leaves: changelog.mdx already
    // carries the dated section, the fragments are still there, and the version
    // files are untouched.
    expect(runFixtureHook(dir, "1.0.0").status).toBe(0);
    const folded = read(dir, CHANGELOG_SOURCE_PATH);
    fixtureGit(dir, "reset", "-q", "--hard");
    write(dir, CHANGELOG_SOURCE_PATH, folded);
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/"## 1\.0\.0" section already exists/);
    expect(snapshot(dir)).toEqual(before);
    expect(read(dir, CHANGELOG_SOURCE_PATH).match(/^## 1\.0\.0$/gm)).toHaveLength(1);
  });

  it("aborts before writing anything when git would not remove a fragment", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    // Committed, but edited since: the real `git rm` would refuse it part-way
    // through the fold, so its dry run refuses it first.
    write(dir, "changelog.d/12-a-fix.md", fragmentText("Bug Fixes", 50, "A new fix, edited."));
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git would not remove a changelog fragment");
    expect(snapshot(dir)).toEqual(before);
  });

  it("skips the fold on a pre-release", () => {
    const dir = makeRepo(TWO_FRAGMENTS);

    const result = runFixtureHook(dir, "1.0.0-rc.1");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Pre-release 1.0.0-rc.1");
    expect(read(dir, CHANGELOG_SOURCE_PATH)).toBe(MDX);
    expect(existsSync(join(dir, "changelog.d/11-a-feature.md"))).toBe(true);
    expect(staged(dir)).toEqual([...VERSION_FILES].sort());
  });

  it("is a logged no-op with no fragments", () => {
    const dir = makeRepo({});

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No fragments in changelog.d/");
    expect(read(dir, CHANGELOG_SOURCE_PATH)).toBe(MDX);
    expect(staged(dir)).toEqual([...VERSION_FILES].sort());
  });

  it("aborts on an invalid fragment before writing anything", () => {
    const dir = makeRepo({ ...TWO_FRAGMENTS, "13-bad-weight.md": fragmentText("Bug Fixes", 0, "A bad one.") });
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("changelog.d/13-bad-weight.md line 3");
    expect(snapshot(dir)).toEqual(before);
  });

  it("aborts on a changelog the What's New parser refuses before writing anything", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    // A newer dated section below the fold point: only the parser sees the order.
    write(dir, CHANGELOG_SOURCE_PATH, MDX.replace("## 0.9.0", "## 1.5.0"));
    commitAll(dir, "out of order");
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/1\.5\.0/);
    expect(snapshot(dir)).toEqual(before);
  });

  it("aborts on an uncommitted fragment before writing anything", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    write(dir, "changelog.d/13-untracked.md", fragmentText("Bug Fixes", 40, "Never committed."));
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("a changelog fragment is not committed");
    expect(snapshot(dir)).toEqual(before);
  });

  it("prints the section and the fragments in a dry run, and writes nothing", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0", { dryRun: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Would write this section into .*changelog\.mdx:/);
    expect(result.stdout).toContain("    | ## 1.0.0");
    expect(result.stdout).toContain("    | - A shiny new thing.");
    expect(result.stdout).toContain("Would delete 2 fragments:");
    expect(result.stdout).toContain("    - changelog.d/11-a-feature.md");
    expect(result.stdout).toContain("    - changelog.d/12-a-fix.md");
    expect(snapshot(dir)).toEqual(before);
  });

  it("rehearses a back-merge: the release folds, master keeps its own fragments", () => {
    // master at the branch point holds one fragment the release inherits.
    const dir = makeRepo({ "10-inherited.md": fragmentText("Features", 50, "Inherited from master.") });
    fixtureGit(dir, "checkout", "-q", "-b", "release/1.0");

    // A fix PR into the release branch, then its stable bump, committed as release-it would.
    write(dir, "changelog.d/20-release-fix.md", fragmentText("Bug Fixes", 50, "Fixed on the release branch."));
    commitAll(dir, "fix: on the release branch");
    const fold = runFixtureHook(dir, "1.0.0");
    expect(fold.status, fold.stderr).toBe(0);
    fixtureGit(dir, "commit", "-q", "-m", "chore(release): v1.0.0");

    // Meanwhile master moves to the next dev version and gains its own fragment.
    fixtureGit(dir, "checkout", "-q", "master");
    writeJson(dir, "package.json", { name: "fixture", version: "1.1.0-dev.0" });
    write(dir, "changelog.d/30-next.md", fragmentText("Features", 50, "Next on master."));
    commitAll(dir, "feat: next on master");

    // The back-merge is a regular merge and lands cleanly (execFileSync throws on a conflict).
    fixtureGit(dir, "merge", "-q", "--no-ff", "--no-edit", "release/1.0");
    expect(fixtureGit(dir, "status", "--porcelain")).toBe("");

    // The inherited and release fragments shipped in 1.0.0 and are gone;
    // master's own survives as its next version's notes.
    expect(readdirSync(join(dir, "changelog.d")).sort()).toEqual(["30-next.md", "README.md"]);
    const mdx = read(dir, CHANGELOG_SOURCE_PATH);
    expect(mdx).toMatch(/^## 1\.0\.0\n\n_\d{4}-\d{2}-\d{2}_\n/m);
    expect(mdx).toContain("- Inherited from master.");
    expect(mdx).toContain("- Fixed on the release branch.");
    expect(mdx).not.toContain("Next on master.");

    // And the merged tree composes: 1.1.0 Unreleased on top of the dated 1.0.0.
    const sources = loadChangelogSources(dir);
    expect(sources.version).toBe("1.1.0-dev.0");
    const data = buildChangelogData(
      composeChangelog(sources.mdx, sources.fragments, sources.version, { mode: "preview" }),
    );
    expect(data.releases.map(({ version, date }) => [version, date === null ? null : "dated"])).toEqual([
      ["1.1.0", null],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);
  });

  // #1398: between a stable release and the next version bump the root version
  // names a release whose section is already dated. A fragment merged in that
  // window composes as an undated "## Unreleased" section, which the next
  // stable fold takes into its own dated section; the label is never written.
  it("composes a fragment merged after master's own release as Unreleased, and folds it into the next release", () => {
    const dir = makeRepo({ "10-shipped.md": fragmentText("Features", 50, "Shipped in 1.0.0.") });
    releaseAsReleaseIt(dir, "1.0.0");

    // The window: the version still names the release just made, and a fix lands.
    write(dir, "changelog.d/20-after.md", fragmentText("Bug Fixes", 50, "Merged after 1.0.0."));
    commitAll(dir, "fix: merged after the release");
    expect(loadChangelogSources(dir).version).toBe("1.0.0");

    const window = composeTree(dir);
    expect(window.releases).toEqual([
      [UNRELEASED_LABEL, null],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);
    expect(window.text).toContain(`## ${UNRELEASED_LABEL}\n\n**Bug Fixes**\n\n- Merged after 1.0.0.\n\n## 1.0.0\n`);
    // The window section exists only in composed text.
    expect(read(dir, CHANGELOG_SOURCE_PATH)).not.toContain(UNRELEASED_LABEL);

    const patch = releaseAsReleaseIt(dir, "1.0.1");

    expect(patch.stdout).toContain('Folded 1 fragment into "## 1.0.1"');
    const mdx = read(dir, CHANGELOG_SOURCE_PATH);
    expect(mdx).toMatch(
      /^## 1\.0\.1\n\n_\d{4}-\d{2}-\d{2}_\n\n\*\*Bug Fixes\*\*\n\n- Merged after 1\.0\.0\.\n\n## 1\.0\.0\n/m,
    );
    expect(mdx).not.toContain(UNRELEASED_LABEL);
    expect(mdx.match(/^- Merged after 1\.0\.0\.$/gm)).toHaveLength(1);
    expect(readdirSync(join(dir, "changelog.d"))).toEqual(["README.md"]);
    expect(composeTree(dir).releases).toEqual([
      ["1.0.1", "dated"],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);
  });

  it("carries a hotfix's window on a release branch through its patch release and the back-merge into master", () => {
    const dir = makeRepo({ "10-inherited.md": fragmentText("Features", 50, "Inherited from master.") });
    fixtureGit(dir, "checkout", "-q", "-b", "release/1.0");
    releaseAsReleaseIt(dir, "1.0.0");

    // A hotfix PR into the release branch after its stable release: the window there.
    write(dir, "changelog.d/20-hotfix.md", fragmentText("Bug Fixes", 50, "Hotfixed on the release branch."));
    commitAll(dir, "fix: hotfix on the release branch");
    expect(composeTree(dir).releases).toEqual([
      [UNRELEASED_LABEL, null],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);

    releaseAsReleaseIt(dir, "1.0.1");
    const releaseMdx = read(dir, CHANGELOG_SOURCE_PATH);
    expect(releaseMdx).toMatch(
      /^## 1\.0\.1\n\n_\d{4}-\d{2}-\d{2}_\n\n\*\*Bug Fixes\*\*\n\n- Hotfixed on the release branch\.\n/m,
    );
    expect(releaseMdx).not.toContain(UNRELEASED_LABEL);

    // Meanwhile master takes its -dev bump and gains a fragment of its own.
    fixtureGit(dir, "checkout", "-q", "master");
    releaseAsReleaseIt(dir, "1.1.0-dev.0");
    write(dir, "changelog.d/30-next.md", fragmentText("Features", 50, "Next on master."));
    commitAll(dir, "feat: next on master");
    const masterVersionFiles = Object.fromEntries(
      ["package.json", ...VERSION_FILES.map((line) => line.slice(2))].map((rel) => [rel, read(dir, rel)]),
    );

    const conflicted = backMerge(dir, "release/1.0");

    // Both sides moved every version file, and those are the only conflicts;
    // each resolves to master's own bytes.
    expect(conflicted).toEqual(Object.keys(masterVersionFiles).sort());
    for (const [rel, text] of Object.entries(masterVersionFiles)) expect(read(dir, rel), rel).toBe(text);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("1.1.0-dev.0");

    // The release's fragments shipped and are gone; master's own survives.
    expect(readdirSync(join(dir, "changelog.d")).sort()).toEqual(["30-next.md", "README.md"]);
    expect(read(dir, CHANGELOG_SOURCE_PATH)).toBe(releaseMdx);

    const merged = composeTree(dir);
    expect(merged.releases).toEqual([
      ["1.1.0", null],
      ["1.0.1", "dated"],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);
    expect(merged.text).toContain("## 1.1.0\n\n_Unreleased_\n\n**Features**\n\n- Next on master.\n\n## 1.0.1\n");
  });

  it("puts master in the window through a back-merge of its release branch's fold, until its next release", () => {
    const dir = makeRepo({ "10-inherited.md": fragmentText("Features", 50, "Inherited from master.") });
    releaseAsReleaseIt(dir, "1.1.0-dev.0");
    fixtureGit(dir, "checkout", "-q", "-b", "release/1.1");
    releaseAsReleaseIt(dir, "1.1.0");

    // master gains a fragment after the branch point.
    fixtureGit(dir, "checkout", "-q", "master");
    write(dir, "changelog.d/30-after-branch.md", fragmentText("Features", 50, "After the branch point."));
    commitAll(dir, "feat: after the branch point");

    const conflicted = backMerge(dir, "release/1.1");

    // master has not moved a version file since the branch point, so git takes
    // the release's 1.1.0 without a conflict.
    expect(conflicted).toEqual([]);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("1.1.0");
    expect(readdirSync(join(dir, "changelog.d")).sort()).toEqual(["30-after-branch.md", "README.md"]);

    const expectedWindow = [
      [UNRELEASED_LABEL, null],
      ["1.1.0", "dated"],
      ["0.9.0", "dated"],
    ];
    const window = composeTree(dir);
    expect(window.releases).toEqual(expectedWindow);
    expect(window.text).toContain(`## ${UNRELEASED_LABEL}\n\n**Features**\n\n- After the branch point.\n\n## 1.1.0\n`);
    expect(read(dir, CHANGELOG_SOURCE_PATH)).not.toContain(UNRELEASED_LABEL);

    // The window is the root version being exactly 1.1.0. A master that kept a
    // pre-release of it, 1.1.0-dev.0, is behind the dated 1.1.0 and is refused
    // rather than composed as the window: composed green, it would surface only at
    // its next patch release, 1.1.0, whose fold meets "## 1.1.0" and calls the
    // tree half-folded, which it is not. The merger bumps it to the next -dev
    // before pushing. (A master
    // already bumped past the branch point would resolve the version conflict to
    // its own 1.2.0-dev.0 and compose the normal `## 1.2.0` / `_Unreleased_`.)
    writeJson(dir, "package.json", { name: "fixture", version: "1.1.0-dev.0" });
    expect(() => composeTree(dir)).toThrow(
      /1\.1\.0-dev\.0 \(package\.json\) is a pre-release of "## 1\.1\.0".*bump the version to the next -dev/,
    );
    fixtureGit(dir, "restore", "--", "package.json");
    expect(fixtureGit(dir, "status", "--porcelain")).toBe("");

    // master's next stable release folds the fragment into its own dated section.
    const patch = releaseAsReleaseIt(dir, "1.1.1");

    expect(patch.stdout).toContain('Folded 1 fragment into "## 1.1.1"');
    const mdx = read(dir, CHANGELOG_SOURCE_PATH);
    expect(mdx).toMatch(
      /^## 1\.1\.1\n\n_\d{4}-\d{2}-\d{2}_\n\n\*\*Features\*\*\n\n- After the branch point\.\n\n## 1\.1\.0\n/m,
    );
    expect(mdx).not.toContain(UNRELEASED_LABEL);
    expect(readdirSync(join(dir, "changelog.d"))).toEqual(["README.md"]);
    expect(composeTree(dir).releases).toEqual([
      ["1.1.1", "dated"],
      ["1.1.0", "dated"],
      ["0.9.0", "dated"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The voice-pack records (#1667), run for real against the fixture's packs: the
// hook holds every record to the four rules before it writes anything, and on
// a version that publishes (stable or -rc) seals each pack's current version as
// released and stages the records in the bump commit.
// ---------------------------------------------------------------------------

const recordPath = (pack) => `${PACK_RECORDS}/${pack.id}.json`;

/** Every git command of a traced run, as git logs them. */
function tracedGit(dir, version, options = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), "iracedeck-release-hooks-trace-"));
  fixtures.push(traceDir);
  const result = runFixtureHook(dir, version, { ...options, extraEnv: { GIT_TRACE: join(traceDir, "trace.txt") } });
  const commands = read(traceDir, "trace.txt")
    .split("\n")
    .map((line) => /trace: built-in: (git .*)$/.exec(line)?.[1])
    .filter(Boolean);
  return { result, commands };
}

describe("release-hooks.mjs voice-pack records (in a temporary git repository)", { timeout: 60_000 }, () => {
  it("seals every unsealed pack on a stable release and stages the records with the version files and the fold", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });
    const expected = Object.fromEntries(VOICE_PACKS.map((pack) => [pack.id, sealedRecordBytes(dir, pack)]));

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    for (const pack of VOICE_PACKS) {
      // Byte for byte what the sealer writes: the record as it was, plus `released`
      // at the pack's version and the record's own sha256.
      expect(read(dir, recordPath(pack))).toBe(expected[pack.id]);
      expect(readPackRecord(pack.id, packRoots(dir).recordsDir).released).toEqual({
        version: pack.version,
        sha256: PACK_SHA,
      });
      expect(result.stdout).toContain(`  Sealed ${recordPath(pack)}: ${pack.id} ${pack.version} released`);
    }
    expect(staged(dir)).toEqual(
      [
        ...VERSION_FILES,
        ...RECORD_FILES,
        "D\tchangelog.d/11-a-feature.md",
        "D\tchangelog.d/12-a-fix.md",
        `M\t${CHANGELOG_SOURCE_PATH}`,
      ].sort(),
    );
    expect(fixtureGit(dir, "diff", "--name-only")).toBe("");
  });

  it("seals on an -rc too, which is tagged and publishes the packs, while the fold stays skipped", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });

    const result = runFixtureHook(dir, "1.0.0-rc.1");

    expect(result.status, result.stderr).toBe(0);
    for (const pack of VOICE_PACKS) {
      expect(readPackRecord(pack.id, packRoots(dir).recordsDir).released).toEqual({
        version: pack.version,
        sha256: PACK_SHA,
      });
    }
    expect(read(dir, CHANGELOG_SOURCE_PATH)).toBe(MDX);
    expect(staged(dir)).toEqual([...VERSION_FILES, ...RECORD_FILES].sort());
  });

  it("names the record paths in the git add preflight, before anything is written, and in the real git add", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });

    const { result, commands } = tracedGit(dir, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    const adds = commands.filter((command) => command.startsWith("git add "));
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatch(/^git add --dry-run -- /);
    expect(adds[1]).toMatch(/^git add -- /);
    for (const add of adds) for (const pack of VOICE_PACKS) expect(add).toContain(` ${recordPath(pack)}`);
    // The preflight is the last git command before the fold's `git rm`: every
    // write of the hook comes after it.
    expect(commands.indexOf(adds[0])).toBeLessThan(commands.findIndex((command) => /^git rm -q -- /.test(command)));
  });

  it("leaves a pack already sealed at its version alone, and says so", () => {
    const dir = makeRepo({});
    const before = Object.fromEntries(VOICE_PACKS.map((pack) => [pack.id, read(dir, recordPath(pack))]));

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    for (const pack of VOICE_PACKS) expect(read(dir, recordPath(pack))).toBe(before[pack.id]);
    expect(result.stdout).toContain("Voice packs: records checked; every pack is already sealed at its version");
    expect(result.stdout).not.toContain("Sealed ");
    expect(staged(dir)).toEqual([...VERSION_FILES].sort());
  });

  it("seals only the packs not yet sealed at their version", () => {
    const dir = makeRepo({}, { unsealedPacks: true });
    const [first, ...rest] = VOICE_PACKS;
    // The first pack sealed by hand, as the seal command would before a
    // between-releases publish; the rest wait for the release.
    write(dir, recordPath(first), sealedRecordBytes(dir, first));
    commitAll(dir, "seal the first pack");

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(`Sealed ${recordPath(first)}`);
    for (const pack of rest) expect(result.stdout).toContain(`Sealed ${recordPath(pack)}`);
    expect(staged(dir)).toEqual([...VERSION_FILES, ...rest.map((pack) => `M\t${recordPath(pack)}`)].sort());
  });

  it("checks the records on a -dev bump and seals nothing", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });
    const before = snapshot(dir);

    // Past the fixture's own 1.0.0-dev.0, so the version files show as staged.
    const result = runFixtureHook(dir, "1.1.0-dev.0");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Voice packs: records checked; a -dev bump publishes no pack, so nothing is sealed",
    );
    for (const pack of VOICE_PACKS) {
      expect(read(dir, recordPath(pack))).toBe(before.files[recordPath(pack)]);
      expect(readPackRecord(pack.id, packRoots(dir).recordsDir).released).toBeUndefined();
    }
    expect(staged(dir)).toEqual([...VERSION_FILES].sort());
  });

  // "No -dev identifier" is semver's own reading of the prerelease: `dev` as
  // one of its dot-separated identifiers, wherever it sits.
  it.each([
    ["1.0.0", true],
    ["1.0.0-rc.1", true],
    ["1.0.0-beta.2", true],
    ["1.0.0-dev.0", false],
    ["1.0.0-dev", false],
    ["1.0.0-rc.dev.1", false],
  ])("decides whether %s seals by semver's prerelease identifiers (%s)", (version, seals) => {
    const dir = makeRepo({}, { unsealedPacks: true });

    const result = runFixtureHook(dir, version);

    expect(result.status, result.stderr).toBe(0);
    const [pack] = VOICE_PACKS;
    expect(readPackRecord(pack.id, packRoots(dir).recordsDir).released !== undefined).toBe(seals);
  });

  // On a fresh clone or after `pnpm clean` the record module's import of
  // `@iracedeck/callout-script` finds no dist/. The hook loads the module
  // through lib/pack-record-module.mjs, so that is one sentence naming
  // `pnpm build` rather than a raw ERR_MODULE_NOT_FOUND, and nothing is written.
  it("stops with a sentence naming pnpm build when the record module cannot be loaded, writing nothing", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true, unbuilt: true });
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to release: The voice-pack record module could not be loaded: ");
    // Node names the missing entry by its file path, with the platform's separators.
    expect(result.stderr).toMatch(/callout-script[\\/]dist[\\/]index\.js/);
    expect(result.stderr).toContain("Run `pnpm build`, then run this again. Nothing was written.");
    expect(result.stderr).not.toMatch(/^Error \[ERR_MODULE_NOT_FOUND\]/m);
    expect(snapshot(dir)).toEqual(before);
  });

  it("refuses a version that is not semver before anything else", () => {
    const dir = makeRepo({}, { unsealedPacks: true });
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to release: "1.0" is not a semver version.');
    expect(snapshot(dir)).toEqual(before);
  });

  it.each(["1.0.0", "1.0.0-rc.1", "1.0.0-dev.0"])(
    "aborts %s with a clean tree when a pack's clips changed since it was packed, naming the pack and the fix",
    (version) => {
      const dir = makeRepo(TWO_FRAGMENTS);
      const [pack] = VOICE_PACKS;
      const [voiceId] = pack.voices;
      // #1582's shape: an input changed and nobody re-ran pack:voice. Committed,
      // so release-it's own clean-tree check would have let it through.
      write(dir, `${AUDIO_ASSETS}/voice/${voiceId}/numbers/1.mp3`, "different bytes");
      commitAll(dir, "re-record a clip without re-packing");
      const before = snapshot(dir);

      const result = runFixtureHook(dir, version);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing to release: a voice pack's committed record disagrees with the tree");
      expect(result.stderr).toContain("Nothing was written.");
      expect(result.stderr).toContain(
        `  ${pack.id}: the clips under voice/${voiceId} changed (2 clips as recorded, with different bytes or paths)`,
      );
      // The fixture's records are sealed, so the fix is the released one: bump first.
      expect(result.stderr).toContain(
        `  fix: version ${pack.version} is released: bump \`version\` in src/build/voice-packs.mjs, ` +
          `run \`pnpm --filter @iracedeck/audio-assets pack:voice ${pack.id}\`, and commit catalog/${pack.id}.json and pack-records/${pack.id}.json`,
      );
      expect(snapshot(dir)).toEqual(before);
    },
  );

  it("aborts with a clean tree on a re-pack under a released version (rule 4)", () => {
    const dir = makeRepo(TWO_FRAGMENTS);
    const [pack] = VOICE_PACKS;
    const other = "b7".repeat(32);
    // What a `pack:voice` that was forced through would leave: entry and record
    // agree on new bytes, but the version is the one already published.
    const record = JSON.parse(read(dir, recordPath(pack)));
    record.sha256 = other;
    write(dir, recordPath(pack), `${JSON.stringify(record, null, 2)}\n`);
    const entry = JSON.parse(read(dir, `${AUDIO_ASSETS}/catalog/${pack.id}.json`));
    entry.sha256 = other;
    write(dir, `${AUDIO_ASSETS}/catalog/${pack.id}.json`, `${JSON.stringify(entry, null, 2)}\n`);
    commitAll(dir, "re-pack under the released version");
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `${pack.id}: version ${pack.version} is released with sha256 ${PACK_SHA}, but pack-records/${pack.id}.json now carries ${other}`,
    );
    expect(result.stderr).toContain("a published archive never changes under its version");
    expect(snapshot(dir)).toEqual(before);
  });

  it("prints what it would seal in a dry run, and writes nothing", () => {
    const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });
    const before = snapshot(dir);

    const result = runFixtureHook(dir, "1.0.0", { dryRun: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`[dry-run] Would seal ${VOICE_PACKS.length} voice-pack records as released:`);
    for (const pack of VOICE_PACKS) {
      expect(result.stdout).toContain(`    - ${recordPath(pack)}: ${pack.id} ${pack.version} (sha256 ${PACK_SHA})`);
    }
    expect(result.stdout).not.toContain("Sealed ");
    expect(snapshot(dir)).toEqual(before);

    // And the two cases with nothing to seal say so, in the dry run too.
    const dev = runFixtureHook(dir, "1.0.0-dev.0", { dryRun: true });
    expect(dev.status, dev.stderr).toBe(0);
    expect(dev.stdout).toContain(
      "[dry-run] Voice packs: records checked; a -dev bump publishes no pack, so nothing is sealed",
    );
    expect(dev.stdout).not.toContain("Would seal");
    expect(snapshot(dir)).toEqual(before);

    const sealedDir = makeRepo(TWO_FRAGMENTS);
    const sealedBefore = snapshot(sealedDir);
    const already = runFixtureHook(sealedDir, "1.0.0", { dryRun: true });
    expect(already.status, already.stderr).toBe(0);
    expect(already.stdout).toContain(
      "[dry-run] Voice packs: records checked; every pack is already sealed at its version",
    );
    expect(already.stdout).not.toContain("Would seal");
    expect(snapshot(sealedDir)).toEqual(sealedBefore);
  });

  // A read-only mode does not stop root on POSIX, so the write this case needs
  // to fail would succeed there; `pack-voice.test.ts` guards its permission case
  // the same way.
  it.skipIf(process.getuid?.() === 0)(
    "stops before the version bumps when a record cannot be written, and names a restore that works",
    () => {
      const dir = makeRepo(TWO_FRAGMENTS, { unsealedPacks: true });
      const versionFiles = Object.fromEntries(
        VERSION_FILES.map((line) => line.slice(2)).map((rel) => [rel, read(dir, rel)]),
      );
      const before = snapshot(dir);
      // The LAST pack's record is read-only: the checks read it fine, the sealer
      // writes the first and fails on this one — the worst half-way state.
      const last = VOICE_PACKS.at(-1);
      const lockedFile = join(dir, recordPath(last));
      chmodSync(lockedFile, 0o444);

      try {
        const result = runFixtureHook(dir, "1.0.0");

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `The release stopped part-way: the changelog fold is done (${CHANGELOG_SOURCE_PATH} is written and the fragments are removed), but sealing the voice-pack records failed`,
        );
        expect(result.stderr).toContain("The version files are untouched.");
        const restore = `git restore --staged --worktree -- ${CHANGELOG_SOURCE_PATH} changelog.d ${PACK_RECORDS}`;
        expect(result.stderr).toContain(restore);
        // The fold is done, the first record is sealed, the last is not, and no
        // version file moved.
        expect(read(dir, CHANGELOG_SOURCE_PATH)).toContain("## 1.0.0");
        expect(existsSync(join(dir, "changelog.d/11-a-feature.md"))).toBe(false);
        expect(readPackRecord(VOICE_PACKS[0].id, packRoots(dir).recordsDir).released).toBeDefined();
        expect(readPackRecord(last.id, packRoots(dir).recordsDir).released).toBeUndefined();
        for (const [rel, text] of Object.entries(versionFiles)) expect(read(dir, rel)).toBe(text);

        // The restore the message names puts the tree back exactly.
        chmodSync(lockedFile, 0o644);
        fixtureGit(dir, ...restore.split(" ").slice(1));
        expect(snapshot(dir)).toEqual(before);
      } finally {
        chmodSync(lockedFile, 0o644);
      }
    },
  );
});
