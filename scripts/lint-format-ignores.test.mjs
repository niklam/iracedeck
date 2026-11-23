import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/lint-format-ignores.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// What the prettier CLI reads by default; the API reads nothing unless told.
// node-gyp's output roots are ignored through .gitignore alone.
const PRETTIER_IGNORE_FILES = [join(repoRoot, ".gitignore"), join(repoRoot, ".prettierignore")];

// The `build/` ignores exist for node-gyp's output, and must stay narrow enough
// that source living in a directory named `build/` is still linted and
// formatted. A bare `**/build/**` hid packages/audio-assets/src/build/ and
// packages/pi-components/src/build/ from both gates (#1125) with nothing red.
// Every tracked file is source by definition — the native output is gitignored.
const trackedUnderBuild = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8" })
  .split("\0")
  .filter((file) => /(^|\/)build\//.test(file));

// ESLint's isPathIgnored() also answers true for a file no config block's
// `files` matches, so only an extension eslint.config.js lints proves anything
// about the ignores. Prettier's answer depends on the path alone, so it checks
// every tracked file.
const LINTED = /\.(ts|mts|mjs|js|astro)$/;

// Paths node-gyp writes, which must stay ignored. They need not exist, and are
// `.ts` so the ESLint answer cannot come from the extension alone.
const NATIVE_OUTPUT = [
  "build/Release/obj/config.ts",
  "packages/iracing-native/build/Release/obj/iracing_native.ts",
  "packages/audio-native/build/Release/obj/audio_native.ts",
];

// Loading eslint.config.js (typescript-eslint, the Astro parser) and Prettier's
// ignore machinery is a one-time cold cost: about 0.7 s and 0.5 s alone, up to
// 2.6 s each inside a full `pnpm test`, and 9.3 s once under load (#1588),
// against vitest's 5 s per test. A fresh ESLint per test paid it inside the
// first ESLint test (#1647). So each tool's cost is paid once, in a hook of its
// own block, under a timeout of about three times the slowest load seen; its
// tests then read warm caches, and a tool that fails to load fails only its own.
const WARM_UP_TIMEOUT_MS = 30_000;

describe("lint and format ignores", () => {
  // A discovery that finds nothing would pass every assertion below vacuously.
  it("finds tracked source under a build/ directory to check", () => {
    expect(trackedUnderBuild.filter((file) => LINTED.test(file)).length).toBeGreaterThan(0);
  });

  describe("ESLint", () => {
    let eslint;

    beforeAll(async () => {
      eslint = new ESLint({ cwd: repoRoot });
      await eslint.isPathIgnored(join(repoRoot, "eslint.config.js"));
    }, WARM_UP_TIMEOUT_MS);

    // The control for the node-gyp check below: the same kind of path outside a
    // build/ root is NOT ignored, so a `true` there comes from the ignore pattern.
    it("does not ignore a .ts path outside a build/ root", async () => {
      expect(await eslint.isPathIgnored(join(repoRoot, "packages/iracing-native/src/config.ts"))).toBe(false);
    });

    it("does not ignore tracked source under a build/ directory", async () => {
      const files = trackedUnderBuild.filter((file) => LINTED.test(file));
      const ignored = [];

      for (const file of files) {
        if (await eslint.isPathIgnored(join(repoRoot, file))) ignored.push(file);
      }

      expect(ignored).toEqual([]);
    });

    it("still ignores node-gyp's build output", async () => {
      for (const file of NATIVE_OUTPUT) {
        expect(await eslint.isPathIgnored(join(repoRoot, file)), file).toBe(true);
      }
    });
  });

  describe("Prettier", () => {
    const fileInfo = (file) => prettier.getFileInfo(join(repoRoot, file), { ignorePath: PRETTIER_IGNORE_FILES });

    beforeAll(async () => {
      await fileInfo("eslint.config.js");
    }, WARM_UP_TIMEOUT_MS);

    it("does not ignore tracked source under a build/ directory", async () => {
      const ignored = [];

      for (const file of trackedUnderBuild) {
        if ((await fileInfo(file)).ignored) ignored.push(file);
      }

      expect(ignored).toEqual([]);
    });

    it("still ignores node-gyp's build output", async () => {
      for (const file of NATIVE_OUTPUT) {
        expect((await fileInfo(file)).ignored, file).toBe(true);
      }
    });
  });
});
