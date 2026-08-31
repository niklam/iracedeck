import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// scripts/tsconfig-base-inheritance.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const basePath = resolve(repoRoot, "tsconfig.base.json");

// Packages that deliberately do not extend our base, and why. Listed so that a
// package vanishing from the discovery below is a failure rather than a silent
// loss of coverage.
const PACKAGES_NOT_EXTENDING_BASE = new Map([["website", "extends astro/tsconfigs/strict"]]);

// Directories that never hold a project config worth checking.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

// Options whose values TypeScript matches case-INSENSITIVELY, so a duplicate
// differing only in case is still a duplicate. Verified against tsc 5.9.3:
// `"module": "ESNEXT"` resolves to `esnext`, exactly the inherited value, which
// means the base has silently stopped governing it — the #988 defect.
//
// Kept as an explicit list rather than lowercasing every string, because plenty
// of option values ARE case-sensitive (`customConditions`, and any path). Folding
// case on those would report a genuine difference as a duplicate and invite
// someone to delete a key that is doing real work. Missing an enum here costs a
// miss; guessing wrong the other way costs a wrong removal.
const CASE_INSENSITIVE_OPTIONS = new Set([
  "importsNotUsedAsValues",
  "jsx",
  "module",
  "moduleDetection",
  "moduleResolution",
  "newLine",
  "target",
]);

// Guards one invariant, and deliberately only one (#988): no package tsconfig
// re-declares a compiler option whose value it already inherits from
// `tsconfig.base.json`.
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
// Genuinely local settings — `outDir`, `rootDir`, `lib`, `include`, or any value
// that deliberately DIFFERS from the base — are untouched by this rule. Only a
// duplicate of an inherited value is wrong.

// tsconfig is JSONC: comments and trailing commas are legal and tsc accepts
// them. Parse with TypeScript's own reader so this test accepts exactly what the
// compiler does, rather than failing on a comment someone was right to add.
function readTsconfig(absPath) {
  const { config, error } = ts.parseConfigFileTextToJson(absPath, readFileSync(absPath, "utf-8"));
  if (error) {
    const detail = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new Error(`${absPath} is not valid tsconfig JSON: ${detail}`);
  }
  return config ?? {};
}

// `extends` may be a string or, since TS 5.0, an array. Resolve every entry
// relative to the config's own directory so a nested config is matched by path
// rather than by a hardcoded number of `../` segments.
function extendsBase(absPath, config) {
  const entries = Array.isArray(config.extends) ? config.extends : [config.extends];
  return entries.some((entry) => typeof entry === "string" && resolve(dirname(absPath), entry) === basePath);
}

function findTsconfigs(absDir) {
  const found = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findTsconfigs(join(absDir, entry.name)));
    } else if (/^tsconfig.*\.json$/.test(entry.name)) {
      found.push(join(absDir, entry.name));
    }
  }
  return found;
}

const packagesDir = join(repoRoot, "packages");
const allTsconfigs = findTsconfigs(packagesDir).sort();
const baseCompilerOptions = readTsconfig(basePath).compilerOptions ?? {};
const inheritingTsconfigs = allTsconfigs.filter((absPath) => extendsBase(absPath, readTsconfig(absPath)));

const relative = (absPath) => absPath.slice(repoRoot.length + 1).replaceAll("\\", "/");
const packageOf = (absPath) => relative(absPath).split("/")[1];

function isDuplicate(key, value) {
  if (!(key in baseCompilerOptions)) return false;
  const baseValue = baseCompilerOptions[key];
  if (CASE_INSENSITIVE_OPTIONS.has(key) && typeof value === "string" && typeof baseValue === "string") {
    return value.toLowerCase() === baseValue.toLowerCase();
  }
  return isDeepStrictEqual(value, baseValue);
}

describe("package tsconfigs inherit from tsconfig.base.json rather than repeating it", () => {
  it("reads the base options", () => {
    expect(Object.keys(baseCompilerOptions).length).toBeGreaterThan(0);
  });

  // Coverage guard. Without it, a change to the discovery above could quietly
  // shrink the checked set to a handful while every remaining case still passes.
  it("examines every package that extends the base", () => {
    const covered = new Set(inheritingTsconfigs.map(packageOf));
    const missing = [...new Set(allTsconfigs.map(packageOf))].filter(
      (name) => !covered.has(name) && !PACKAGES_NOT_EXTENDING_BASE.has(name),
    );
    expect(
      missing,
      `these packages have a tsconfig that is not being checked: ${missing.join(", ")}. Either it stopped ` +
        `extending ${relative(basePath)}, or discovery in this test has broken. Add it to ` +
        `PACKAGES_NOT_EXTENDING_BASE with a reason only if it genuinely does not extend the base.`,
    ).toEqual([]);
  });

  it.each(inheritingTsconfigs.map(relative))("re-declares no value it already inherits: %s", (relPath) => {
    const compilerOptions = readTsconfig(join(repoRoot, relPath)).compilerOptions ?? {};
    const redundant = Object.keys(compilerOptions).filter((key) => isDuplicate(key, compilerOptions[key]));

    expect(
      redundant,
      `${relPath} repeats ${redundant.map((key) => `"${key}"`).join(", ")} with the value it already ` +
        `inherits from ${relative(basePath)}. Delete the duplicate so the base governs it — a repeated ` +
        `value means editing the base silently does nothing for this package (#988). Keep the key only ` +
        `if you intend it to DIFFER from the base.`,
    ).toEqual([]);
  });
});
