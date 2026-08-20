import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHANGELOG_DATA_PATH, CHANGELOG_SOURCE_PATH } from "./lib/changelog-data.mjs";

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

describe("release-hooks.mjs (dry run)", () => {
  it("discovers all three plugin manifests and stages nothing", () => {
    const before = git("status", "--porcelain");

    const stdout = execFileSync("node", ["scripts/release-hooks.mjs", "9.9.9"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, RELEASE_IT_DRY_RUN: "1" },
    });

    // The dry-run preflight + branch must not touch the tree or the index.
    expect(git("status", "--porcelain")).toBe(before);

    expect(stdout).toMatch(/Would bump \d+ manifest\.json files/);
    // The three live plugin manifests, including the Ulanzi one the old static
    // list silently skipped.
    expect(stdout).toContain("packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json");
    expect(stdout).toContain("packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json");
    expect(stdout).toContain("packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/manifest.json");
  });

  it("leaves the shipped changelog data alone when it does not stamp a date", () => {
    // 9.9.9 has no section, so nothing is stamped and the artifact is already in
    // step with the source — regenerating it would be pure churn in the commit.
    expect(runHook("9.9.9")).toContain(`${CHANGELOG_DATA_PATH} unchanged`);
  });

  it("regenerates the shipped changelog data whenever it stamps the date", () => {
    // The plugin ships its own copy of the notes (#1011), so a stamp that is not
    // regenerated into it releases a build whose What's New pane calls the
    // version the user just installed "Unreleased".
    const before = git("status", "--porcelain");
    const source = readFileSync(join(repoRoot, CHANGELOG_SOURCE_PATH), "utf-8");
    const topVersion = /^##[ \t]+(\d+\.\d+\.\d+)[ \t]*$/m.exec(source)?.[1];

    expect(topVersion, "changelog has no `## X.Y.Z` section").toBeTruthy();

    const stdout = runHook(topVersion);

    if (/Changelog: Stamped/.test(stdout)) {
      expect(stdout).toContain(`Would regenerate ${CHANGELOG_DATA_PATH}`);
    } else {
      // The top section is already dated — nothing to stamp, nothing to redo.
      expect(stdout).toContain(`${CHANGELOG_DATA_PATH} unchanged`);
    }

    expect(git("status", "--porcelain")).toBe(before);
  });
});
