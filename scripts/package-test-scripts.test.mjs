import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import rootConfig from "../vitest.config.ts";

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

// The root config's own lists, read rather than copied: if `include` grows a
// pattern, a package whose only tests match it must count as having tests, or
// this guard would demand it have NO test script while the root suite runs them.
const { include, exclude } = rootConfig.test;
const PACKAGE_PREFIX = "packages/*/";
const packageGlobs = include.filter((g) => g.startsWith(PACKAGE_PREFIX)).map((g) => g.slice(PACKAGE_PREFIX.length));

/** Whether the root `vitest.config.ts` collects any test file from `packages/<folder>`. */
function hasTestFiles(folder) {
  return globSync(packageGlobs, { cwd: path.join(PACKAGES, folder) }).some((f) => {
    const rel = `packages/${folder}/${f.split(path.sep).join("/")}`;
    return !exclude.some((g) => path.posix.matchesGlob(rel, g));
  });
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
      hasTests: hasTestFiles(d.name),
    };
  });

describe("per-package test scripts (#1021)", () => {
  it("understands every include pattern of the root vitest config", () => {
    // A `packages/...` pattern not of the `packages/*/<glob>` shape would select
    // package tests this guard cannot attribute to a package.
    expect(packageGlobs.length).toBeGreaterThan(0);
    expect(include.filter((g) => g.startsWith("packages/") && !g.startsWith(PACKAGE_PREFIX))).toEqual([]);
  });

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
            `${p.name} (packages/${p.folder}) has test files the root vitest config collects, so its package.json needs ` +
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
            `${p.name} (packages/${p.folder}) has no test files the root vitest config collects, so remove "${key}" from its ` +
              `package.json — or add the package's first test, which makes the shared runner's scripts required.`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
