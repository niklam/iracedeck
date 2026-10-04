import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import prettier from "prettier";
import { describe, expect, it } from "vitest";

// scripts/lint-format-ignores.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// What the prettier CLI reads by default; the API reads nothing unless told.
const PRETTIER_IGNORE_FILES = [join(repoRoot, ".gitignore"), join(repoRoot, ".prettierignore")];

// The `build/` ignores exist for node-gyp's output, and must stay narrow enough
// that source living in a directory named `build/` is still linted and
// formatted. A bare `**/build/**` hid packages/audio-assets/src/build/ and
// packages/pi-components/src/build/ from both gates (#1125) with nothing red.
// Every tracked file is source by definition — the native output is gitignored.
const trackedUnderBuild = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
  .split("\0")
  .filter((file) => /(^|\/)build\//.test(file));

// What `pnpm lint` and `pnpm format` actually match by extension.
const LINTED = /\.(ts|mjs|js)$/;
const FORMATTED = /\.(ts|json)$/;

// Paths node-gyp writes, which must stay ignored. They need not exist.
const NATIVE_OUTPUT = [
  "packages/iracing-native/build/Release/iracing_native.node",
  "packages/audio-native/build/Release/obj/audio_native.ts",
  "build/Release/config.json",
];

describe("lint and format ignores", () => {
  // A discovery that finds nothing would pass every assertion below vacuously.
  it("finds tracked source under a build/ directory to check", () => {
    expect(trackedUnderBuild.filter((file) => LINTED.test(file)).length).toBeGreaterThan(0);
    expect(trackedUnderBuild.filter((file) => FORMATTED.test(file)).length).toBeGreaterThan(0);
  });

  it("ESLint does not ignore tracked source under a build/ directory", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const files = trackedUnderBuild.filter((file) => LINTED.test(file));
    const ignored = [];

    for (const file of files) {
      if (await eslint.isPathIgnored(join(repoRoot, file))) ignored.push(file);
    }

    expect(ignored).toEqual([]);
  });

  it("Prettier does not ignore tracked source under a build/ directory", async () => {
    const files = trackedUnderBuild.filter((file) => FORMATTED.test(file));
    const ignored = [];

    for (const file of files) {
      const info = await prettier.getFileInfo(join(repoRoot, file), { ignorePath: PRETTIER_IGNORE_FILES });

      if (info.ignored) ignored.push(file);
    }

    expect(ignored).toEqual([]);
  });

  it("both still ignore node-gyp's build output", async () => {
    const eslint = new ESLint({ cwd: repoRoot });

    for (const file of NATIVE_OUTPUT) {
      expect(await eslint.isPathIgnored(join(repoRoot, file)), file).toBe(true);

      const info = await prettier.getFileInfo(join(repoRoot, file), { ignorePath: PRETTIER_IGNORE_FILES });

      expect(info.ignored, file).toBe(true);
    }
  });
});
