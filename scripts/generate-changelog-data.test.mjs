import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { buildComposedChangelogData } from "./lib/changelog-composed.mjs";
import { CHANGELOG_DATA_PATH, CHANGELOG_SOURCE_PATH, serializeChangelogData } from "./lib/changelog-data.mjs";
import { CHANGELOG_FRAGMENTS_DIR } from "./lib/changelog-fragments.mjs";

/**
 * Since #1386 `changelog.json` is a build artifact, not a committed file: turbo's
 * root task `//#generate:changelog-data` composes it before every plugin build. A
 * freshness test has nothing to compare any more; what can still go wrong is the
 * file creeping back into the index (every changelog edit conflicting again) or
 * the wiring that makes it exist before a plugin build reads it.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const turbo = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf-8"));

const ROOT_TASK = "//#generate:changelog-data";
const PLUGIN_BUILDS = [
  "@iracedeck/iracing-plugin-stream-deck#build",
  "@iracedeck/iracing-plugin-mirabox#build",
  "@iracedeck/iracing-plugin-ulanzi#build",
];

const git = (...args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });

describe("changelog.json is a build artifact", () => {
  it("is gitignored", () => {
    const result = git("check-ignore", "--no-index", "--quiet", CHANGELOG_DATA_PATH);

    expect(result.status, `${CHANGELOG_DATA_PATH} must be gitignored`).toBe(0);
  });

  it("is not tracked", () => {
    const result = git("ls-files", "--", CHANGELOG_DATA_PATH);

    expect(result.status).toBe(0);
    expect(result.stdout, `${CHANGELOG_DATA_PATH} is in the index — \`git rm --cached\` it`).toBe("");
  });
});

describe("turbo wiring", () => {
  const task = turbo.tasks[ROOT_TASK];

  it("declares the root task the plugin builds depend on, running the root script", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

    expect(task).toBeDefined();
    expect(pkg.scripts["generate:changelog-data"]).toBe("node scripts/generate-changelog-data.mjs");
  });

  it("hashes every source the artifact is composed from", () => {
    expect(task.inputs).toEqual(
      expect.arrayContaining([
        CHANGELOG_SOURCE_PATH,
        `${CHANGELOG_FRAGMENTS_DIR}/**`,
        "scripts/lib/changelog-*.mjs",
        "scripts/generate-changelog-data.mjs",
        "package.json",
      ]),
    );
  });

  it("caches the artifact as its output", () => {
    expect(task.outputs).toEqual([CHANGELOG_DATA_PATH]);
  });

  it.each(PLUGIN_BUILDS)("%s depends on it", (build) => {
    expect(turbo.tasks[build]?.dependsOn).toContain(ROOT_TASK);
  });

  it("rebuilds the website when a fragment or the version changes", () => {
    expect(turbo.tasks["@iracedeck/website#build"].inputs).toEqual(
      expect.arrayContaining([
        "$TURBO_ROOT$/scripts/lib/changelog-*.mjs",
        `$TURBO_ROOT$/${CHANGELOG_FRAGMENTS_DIR}/**`,
        "$TURBO_ROOT$/package.json",
      ]),
    );
  });
});

describe("generate-changelog-data.mjs", () => {
  it("writes the composed changelog data", () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "generate-changelog-data-"));
    try {
      const out = path.join(scratch, "changelog.json");
      execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate-changelog-data.mjs"), "--out", out], {
        cwd: repoRoot,
      });

      expect(readFileSync(out, "utf-8")).toBe(serializeChangelogData(buildComposedChangelogData(repoRoot)));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
