import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard for #1021: every package's own `test` entry point either runs that
// package's tests or does not exist.
//
// pnpm skips a missing `test` script silently with exit 0, and the old
// per-package `vitest run` ran from the package directory, where the root
// config's root-relative `include` globs match nothing — so both shapes
// reported green having run nothing. The fix is one shared runner,
// `scripts/test-package.mjs`, named by byte-identical scripts in every package
// with tests; this test keeps a new package, or a hand-written script copied
// from an old one, from reopening the hole. Design record:
// docs/superpowers/specs/2026-10-04-issue-1021-per-package-test-runner.md

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(ROOT, "packages");

const EXPECTED_SCRIPTS = {
  test: "node ../../scripts/test-package.mjs",
  "test:watch": "node ../../scripts/test-package.mjs --watch",
};

/**
 * The same files the root `vitest.config.ts` runs for a package: its include
 * glob `packages/<name>/src/**\/*.test.ts`, less its excludes (`node_modules`,
 * and the transient probe `typecheck-script-coverage.test.mjs` writes).
 */
function hasTestFiles(dir) {
  return globSync("src/**/*.test.ts", { cwd: dir }).some(
    (f) => !f.split(path.sep).includes("node_modules") && path.basename(f) !== "__typecheck_coverage_probe__.test.ts",
  );
}

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(PACKAGES, d.name, "package.json")))
  .map((d) => {
    const dir = path.join(PACKAGES, d.name);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return {
      folder: d.name,
      name: manifest.name ?? d.name,
      scripts: manifest.scripts ?? {},
      hasTests: hasTestFiles(dir),
    };
  });

describe("per-package test scripts (#1021)", () => {
  it("finds the packages and their tests (the guard is not vacuous)", () => {
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.some((p) => p.hasTests)).toBe(true);
    expect(packages.some((p) => p.folder === "logger" && p.hasTests)).toBe(true);
  });

  it("names a runner that exists where a package's scripts point", () => {
    expect(existsSync(path.resolve(PACKAGES, "logger", "../../scripts/test-package.mjs"))).toBe(true);
  });

  it("gives every package with test files the shared runner's two scripts, exactly", () => {
    const problems = [];
    for (const p of packages.filter((x) => x.hasTests)) {
      for (const [key, expected] of Object.entries(EXPECTED_SCRIPTS)) {
        if (p.scripts[key] !== expected) {
          problems.push(
            `${p.name} (packages/${p.folder}) has src/**/*.test.ts files, so its package.json needs ` +
              `"${key}": "${expected}" — found ${p.scripts[key] === undefined ? "no such script" : JSON.stringify(p.scripts[key])}. ` +
              `Any other shape runs nothing or skips the root config (see scripts/test-package.mjs).`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives a package without test files neither script", () => {
    const problems = [];
    for (const p of packages.filter((x) => !x.hasTests)) {
      for (const key of Object.keys(EXPECTED_SCRIPTS)) {
        if (key in p.scripts) {
          problems.push(
            `${p.name} (packages/${p.folder}) has no src/**/*.test.ts files, so remove "${key}" from its ` +
              `package.json — or add the package's first test, which makes the shared runner's scripts required.`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
