import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/release-hooks.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
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
});
