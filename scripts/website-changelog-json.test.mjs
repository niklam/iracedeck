import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildComposedChangelogData } from "./lib/changelog-composed.mjs";
import { serializeChangelogData } from "./lib/changelog-data.mjs";

/**
 * The plugin's compiled-in artifact and the file the website publishes at
 * https://iracedeck.com/changelog.json must be the same bytes: the plugin's
 * update check (#1016) compares its own releases against that URL, and a
 * second producer that could drift is exactly the failure mode publishing an
 * artifact was meant to remove.
 *
 * Since #1386 the plugin's copy is a gitignored build artifact, so both
 * generators are run here — the plugin's into a scratch file through `--out` —
 * rather than comparing against a committed file a fresh clone does not have.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(repoRoot, "packages", "website");
const generator = path.join(websiteDir, "scripts", "generate-changelog-json.mjs");
const pluginGenerator = path.join(repoRoot, "scripts", "generate-changelog-data.mjs");
const output = path.join(websiteDir, "public", "changelog.json");

describe("website changelog.json", () => {
  let scratch;

  beforeAll(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "website-changelog-json-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("generates the same bytes the plugin ships", () => {
    const pluginOutput = path.join(scratch, "changelog.json");
    rmSync(output, { force: true });
    execFileSync(process.execPath, [generator], { cwd: repoRoot });
    execFileSync(process.execPath, [pluginGenerator, "--out", pluginOutput], { cwd: repoRoot });

    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe(readFileSync(pluginOutput, "utf-8"));
  });

  it("publishes the changelog with the in-development fragments composed in", () => {
    execFileSync(process.execPath, [generator], { cwd: repoRoot });

    expect(readFileSync(output, "utf-8")).toBe(serializeChangelogData(buildComposedChangelogData(repoRoot)));
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
