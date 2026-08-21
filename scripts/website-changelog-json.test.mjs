import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { CHANGELOG_DATA_PATH } from "./lib/changelog-data.mjs";

/**
 * The plugin's compiled-in artifact and the file the website publishes at
 * https://iracedeck.com/changelog.json must be the same bytes: the plugin's
 * update check (#1016) compares its own releases against that URL, and a
 * second producer that could drift is exactly the failure mode publishing an
 * artifact was meant to remove.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(repoRoot, "packages", "website");
const generator = path.join(websiteDir, "scripts", "generate-changelog-json.mjs");
const output = path.join(websiteDir, "public", "changelog.json");

describe("website changelog.json", () => {
  it("generates the same bytes the plugin ships", () => {
    rmSync(output, { force: true });
    execFileSync(process.execPath, [generator], { cwd: repoRoot });

    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe(readFileSync(path.join(repoRoot, CHANGELOG_DATA_PATH), "utf-8"));
  });

  it("is wired into the website's build and dev scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(websiteDir, "package.json"), "utf-8"));

    expect(pkg.scripts["generate:changelog-json"]).toBe("node scripts/generate-changelog-json.mjs");
    expect(pkg.scripts.build).toContain("generate:changelog-json");
    expect(pkg.scripts.dev).toContain("generate:changelog-json");
  });

  it("is gitignored, like every other generated public asset", () => {
    expect(readFileSync(path.join(websiteDir, ".gitignore"), "utf-8")).toContain("public/changelog.json");
  });
});
