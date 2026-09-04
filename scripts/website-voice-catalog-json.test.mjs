import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import { buildVoiceCatalogData, serializeVoiceCatalogData, VOICE_CATALOG_ENTRIES_DIR } from "./lib/voice-catalog-data.mjs";

/**
 * The website publishes https://iracedeck.com/voice-catalog.json from the SAME
 * builder any other reader of packages/audio-assets/catalog/ would use
 * (voice-catalog-data.mjs). This is the drift check: run the generator as a
 * real subprocess (the way a build actually invokes it) and confirm its output
 * is byte-identical to calling the shared builder in-process — a second
 * assembly path that could disagree is exactly the failure publishing a single
 * artifact is meant to remove.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(repoRoot, "packages", "website");
const generator = path.join(websiteDir, "scripts", "generate-voice-catalog-json.mjs");
const output = path.join(websiteDir, "public", "voice-catalog.json");

/**
 * The generator imports voice-pack-catalog.ts (for the validating schema)
 * straight from deck-core's TypeScript source, so it must run under `tsx` —
 * plain `node` resolves that file's own syntax fine but not the `.js`-suffixed
 * relative imports it makes to siblings with no compiled .js on disk in this
 * checkout (see voice-catalog-data.mjs). `import.meta.resolve` finds tsx's CLI
 * entry point without depending on a shell or the node_modules/.bin shims,
 * which keeps this test Windows-safe.
 */
function runGenerator() {
  const tsxCli = url.fileURLToPath(import.meta.resolve("tsx/cli"));

  execFileSync(process.execPath, [tsxCli, generator], { cwd: repoRoot });
}

describe("website voice-catalog.json", () => {
  it("generates the same bytes the shared builder produces in-process", () => {
    rmSync(output, { force: true });
    runGenerator();

    expect(existsSync(output)).toBe(true);

    const expected = serializeVoiceCatalogData(buildVoiceCatalogData(path.join(repoRoot, VOICE_CATALOG_ENTRIES_DIR)));

    expect(readFileSync(output, "utf-8")).toBe(expected);
  });

  it("is wired into the website's build and dev scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(websiteDir, "package.json"), "utf-8"));

    expect(pkg.scripts["generate:voice-catalog-json"]).toBe("tsx scripts/generate-voice-catalog-json.mjs");
    expect(pkg.scripts.build).toContain("generate:voice-catalog-json");
    expect(pkg.scripts.dev).toContain("generate:voice-catalog-json");
  });

  it("is gitignored, like every other generated public asset", () => {
    expect(readFileSync(path.join(websiteDir, ".gitignore"), "utf-8")).toContain("public/voice-catalog.json");
  });
});
