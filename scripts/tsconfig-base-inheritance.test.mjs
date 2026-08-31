import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

// scripts/tsconfig-base-inheritance.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE_REL_PATH = "tsconfig.base.json";
const EXTENDS_BASE = "../../tsconfig.base.json";

// Guards one invariant, and deliberately only one (#988): no package tsconfig
// re-declares a compiler option whose value is already identical to the one it
// inherits from `tsconfig.base.json`.
//
// Why it is worth a test rather than a convention. Before #988, 16 of the 21
// package tsconfigs repeated `"module": "ES2022"` verbatim from the base, along
// with `moduleResolution`, `customConditions` and `noImplicitOverride`. That is
// invisible while the values agree — and it silently stops the base governing
// anything. Clearing the repo-wide TS2823 import-attribute errors by raising
// `module` in the base alone would have been a no-op for every one of those 16
// packages, including all three plugins, which is exactly where the errors were.
//
// The failure mode is what makes it worth guarding mechanically: nothing goes
// red, no build breaks, and the change simply has no effect. It is only ever
// found by someone measuring the resolved config, and the natural way to add a
// package here is to copy an existing one, which reintroduces the duplication.
//
// Genuinely local settings — `outDir`, `rootDir`, `lib`, `declaration`,
// `include`, or any value that deliberately DIFFERS from the base — are not
// touched by this rule. Only exact duplicates of an inherited value are wrong.
function readJson(relPath) {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf-8"));
}

const baseCompilerOptions = readJson(BASE_REL_PATH).compilerOptions ?? {};

// Discover the configs dynamically so a new package is covered the day it is
// added, rather than needing to be listed here.
function discoverPackageTsconfigs() {
  const found = [];
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(repoRoot, "packages", entry.name))) {
      if (!file.startsWith("tsconfig") || !file.endsWith(".json")) continue;
      const relPath = `packages/${entry.name}/${file}`;
      // Only configs that actually inherit from our base can duplicate it.
      // `packages/website` extends astro's config and is out of scope.
      if (readJson(relPath).extends === EXTENDS_BASE) found.push(relPath);
    }
  }
  return found.sort();
}

const packageTsconfigs = discoverPackageTsconfigs();

describe("package tsconfigs inherit from tsconfig.base.json rather than repeating it", () => {
  it("discovers the base options and the package configs that extend them", () => {
    expect(Object.keys(baseCompilerOptions).length).toBeGreaterThan(0);
    expect(packageTsconfigs.length).toBeGreaterThan(0);
  });

  it.each(packageTsconfigs)("re-declares no value identical to the base: %s", (relPath) => {
    const compilerOptions = readJson(relPath).compilerOptions ?? {};
    const redundant = Object.keys(compilerOptions).filter(
      (key) => key in baseCompilerOptions && isDeepStrictEqual(compilerOptions[key], baseCompilerOptions[key]),
    );

    expect(
      redundant,
      `${relPath} repeats ${redundant.map((key) => `"${key}"`).join(", ")} with the same value as ` +
        `${BASE_REL_PATH}. Delete the duplicate so the base governs it — a repeated value means ` +
        `editing the base silently does nothing for this package (#988). Keep the key only if you ` +
        `intend it to DIFFER from the base.`,
    ).toEqual([]);
  });
});
