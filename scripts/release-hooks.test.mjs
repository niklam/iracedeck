import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildChangelogData, CHANGELOG_DATA_PATH, CHANGELOG_SOURCE_PATH } from "./lib/changelog-data.mjs";
import { formatLocalDate } from "./lib/changelog-fold.mjs";
import { composeChangelog, loadChangelogSources, UNRELEASED_DATE_LINE } from "./lib/changelog-fragments.mjs";

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
describe("release-hooks.mjs (dry run over this repository)", () => {
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

/** @type {string[]} */
const fixtures = [];

afterEach(() => {
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

/**
 * A minimal repository the hook can release: two packages, one plugin manifest,
 * the changelog, its tracked data artifact and the fragments, all committed on
 * `master`.
 *
 * @param {Record<string, string>} fragments - file name → fragment text
 */
function makeRepo(fragments) {
  const dir = mkdtempSync(join(tmpdir(), "iracedeck-release-hooks-"));
  fixtures.push(dir);

  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "release-hooks.mjs"), join(dir, "scripts", "release-hooks.mjs"));
  for (const name of readdirSync(join(repoRoot, "scripts", "lib"))) {
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
      copyFileSync(join(repoRoot, "scripts", "lib", name), join(dir, "scripts", "lib", name));
    }
  }

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
      if (entry.name === ".git") continue;
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
    expect(sources.version).toBe("1.1.0");
    const data = buildChangelogData(
      composeChangelog(sources.mdx, sources.fragments, sources.version, UNRELEASED_DATE_LINE),
    );
    expect(data.releases.map(({ version, date }) => [version, date === null ? null : "dated"])).toEqual([
      ["1.1.0", null],
      ["1.0.0", "dated"],
      ["0.9.0", "dated"],
    ]);
  });
});
