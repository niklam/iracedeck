// A plugin shell declares what its own sources import, and nothing else (#1375).
//
// Since #1349 a shell is its adapter plus `startPlugin`: the composition root is
// `@iracedeck/plugin-runtime`, and the bundle's other packages are reached
// through it. Rollup resolves every import from the importing file's real path,
// so an import made inside `plugin-runtime` or `iracing-actions` is resolved
// through THEIR links, never the shell's; a native external is installed in
// `bin/` from whichever workspace package declares it (`scripts/lib/runtime-deps.mjs`);
// and turbo orders the shell's build after everything `plugin-runtime` and
// `plugin-build` depend on. So an entry the shell's sources do not import buys
// nothing — the Mirabox and Ulanzi shells carried ten such `@iracedeck`
// entries and Stream Deck seven, and removing them left every byte of the three
// plugin folders and every turbo closure unchanged. This keeps them from
// growing back.
//
// Per shell, read from its tracked `src/` files (TypeScript's own import
// scanner, so a comment can neither add nor hide an import):
//   * every `dependencies` entry is imported by a non-test source, and every
//     package a non-test source imports is in `dependencies`;
//   * every package a test imports is declared in one of the two sections;
//   * an `@iracedeck/*` devDependency is imported by a test — except the named
//     ones in BUILD_ONLY, which the shell's `rollup.config.mjs` uses.
// Third-party devDependencies are tools the package scripts and configs run
// (`rollup`, `typescript`, `rimraf`, `@elgato/cli`, `@tsconfig/node22`,
// `@types/node`), not imports, so they are not checked.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCOPE = "@iracedeck/";
const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$|\.test-support\.|\/test-support\//;

/**
 * Workspace devDependencies a shell declares without any of its sources
 * importing them, each with the reason. An entry no shell declares any more
 * fails the suite.
 */
const BUILD_ONLY = {
  "@iracedeck/plugin-build":
    "the shell's rollup.config.mjs calls its createPluginRollupConfig; the factory, not the shell, imports " +
    "pi-components, audio-assets and app-constants for the build's copy steps",
};

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`), or null for a relative path or a Node builtin. */
export function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  return builtinModules.includes(name) ? null : name;
}

/** The packages `source` imports: static, type-only, side-effect, re-export, dynamic and `require`. */
export function importedPackages(source) {
  const { importedFiles } = ts.preProcessFile(source, true, true);

  return new Set(importedFiles.map(({ fileName }) => packageOf(fileName)).filter((name) => name !== null));
}

/**
 * Every way a shell's manifest disagrees with its sources' imports, one line
 * each; empty when it holds. Pure, so the positive controls can feed it.
 *
 * @param {object} input
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} input.manifest
 * @param {Map<string, string[]>} input.sourceImports package → the non-test files importing it
 * @param {Map<string, string[]>} input.testImports package → the test files importing it
 * @param {Record<string, string>} input.buildOnly
 * @returns {string[]}
 */
export function shellDependencyProblems({ manifest, sourceImports, testImports, buildOnly }) {
  const problems = [];
  const deps = Object.keys(manifest.dependencies ?? {});
  const devDeps = Object.keys(manifest.devDependencies ?? {});

  for (const name of deps) {
    if (!sourceImports.has(name)) {
      problems.push(
        `declares ${name} in dependencies, but no non-test source imports it: remove it (what plugin-runtime ` +
          `or plugin-build need, they declare themselves)`,
      );
    }
  }

  for (const [name, files] of sourceImports) {
    if (!deps.includes(name)) {
      problems.push(`${files.join(", ")} import ${name}, which is not in dependencies`);
    }
  }

  for (const [name, files] of testImports) {
    if (!deps.includes(name) && !devDeps.includes(name)) {
      problems.push(`${files.join(", ")} import ${name}, which is declared in neither section`);
    }
  }

  for (const name of devDeps.filter((d) => d.startsWith(SCOPE))) {
    if (Object.hasOwn(buildOnly, name) || testImports.has(name)) continue;
    problems.push(
      sourceImports.has(name)
        ? `declares ${name} in devDependencies, but a non-test source imports it: move it to dependencies`
        : `declares ${name} in devDependencies, but no test imports it: remove it, or name it in BUILD_ONLY with the reason`,
    );
  }

  for (const name of Object.keys(buildOnly)) {
    if (!devDeps.includes(name)) problems.push(`BUILD_ONLY names ${name}, which is not in its devDependencies`);
  }

  return problems;
}

/** package → the files among `files` (repo-relative) that import it. */
function importsOf(files) {
  const byPackage = new Map();
  for (const file of files) {
    for (const name of importedPackages(readFileSync(path.join(ROOT, file), "utf-8"))) {
      if (!byPackage.has(name)) byPackage.set(name, []);
      byPackage.get(name).push(file);
    }
  }

  return byPackage;
}

// Discovered, so a fourth shell is held to this the day it is added.
const SHELLS = trackedPackageDirs(ROOT).filter((dir) => dir.startsWith("iracing-plugin-"));

function shellInput(shell, buildOnly = BUILD_ONLY) {
  const files = execFileSync("git", ["ls-files", `packages/${shell}/src`], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((file) => CODE.test(file));

  return {
    manifest: JSON.parse(readFileSync(path.join(ROOT, "packages", shell, "package.json"), "utf-8")),
    sourceImports: importsOf(files.filter((file) => !TEST.test(file))),
    testImports: importsOf(files.filter((file) => TEST.test(file))),
    buildOnly,
  };
}

describe("plugin shells declare what their sources import (#1375)", () => {
  it("finds the three shells", () => {
    expect(SHELLS).toEqual(["iracing-plugin-mirabox", "iracing-plugin-stream-deck", "iracing-plugin-ulanzi"]);
  });

  it("reads the shells' imports, so the check is not vacuous", () => {
    for (const shell of SHELLS) {
      expect([...shellInput(shell).sourceImports.keys()], shell).toContain("@iracedeck/plugin-runtime");
    }
    expect([...shellInput("iracing-plugin-stream-deck").testImports.keys()]).toContain("vitest");
  });

  it.each(SHELLS)("%s", (shell) => {
    expect(shellDependencyProblems(shellInput(shell))).toEqual([]);
  });

  it("every BUILD_ONLY entry is still declared by every shell", () => {
    for (const shell of SHELLS) {
      for (const name of Object.keys(BUILD_ONLY)) {
        expect(Object.keys(shellInput(shell).manifest.devDependencies ?? {}), shell).toContain(name);
      }
    }
  });
});

describe("the check itself (positive controls)", () => {
  const imports = (entries) => new Map(entries.map(([name, file]) => [name, [file ?? "src/plugin.ts"]]));
  const base = {
    manifest: {
      dependencies: { "@iracedeck/plugin-runtime": "workspace:*" },
      devDependencies: { "@iracedeck/plugin-build": "workspace:*", rollup: "4.64.8" },
    },
    sourceImports: imports([["@iracedeck/plugin-runtime"]]),
    testImports: new Map(),
    buildOnly: BUILD_ONLY,
  };
  const run = (patch) => shellDependencyProblems({ ...base, ...patch });

  it("passes a minimal shell, its build-only devDependency and an unchecked tool", () => {
    expect(run({})).toEqual([]);
  });

  it("fails a dependency no source imports", () => {
    const manifest = {
      ...base.manifest,
      dependencies: { ...base.manifest.dependencies, "@iracedeck/audio-native": "x" },
    };

    expect(run({ manifest })).toEqual([expect.stringContaining("declares @iracedeck/audio-native in dependencies")]);
  });

  it("fails a third-party dependency no source imports", () => {
    const manifest = { ...base.manifest, dependencies: { ...base.manifest.dependencies, ws: "8.22.0" } };

    expect(run({ manifest })).toEqual([expect.stringContaining("declares ws in dependencies")]);
  });

  it("does not let a test's import keep a dependency", () => {
    const manifest = { ...base.manifest, dependencies: { ...base.manifest.dependencies, zod: "4.6.7" } };

    expect(run({ manifest, testImports: imports([["zod", "src/a.test.ts"]]) })).toEqual([
      expect.stringContaining("declares zod in dependencies"),
    ]);
  });

  it("fails a source import that is not a dependency, and one that is only a devDependency", () => {
    const manifest = { ...base.manifest, devDependencies: { ...base.manifest.devDependencies, "@iracedeck/x": "y" } };
    const problems = run({
      manifest,
      sourceImports: imports([["@iracedeck/plugin-runtime"], ["@iracedeck/settings"], ["@iracedeck/x"]]),
    });

    expect(problems).toEqual([
      "src/plugin.ts import @iracedeck/settings, which is not in dependencies",
      "src/plugin.ts import @iracedeck/x, which is not in dependencies",
      expect.stringContaining("declares @iracedeck/x in devDependencies, but a non-test source imports it"),
    ]);
  });

  it("fails a test import declared nowhere, and passes one in devDependencies", () => {
    expect(run({ testImports: imports([["vitest", "src/a.test.ts"]]) })).toEqual([
      "src/a.test.ts import vitest, which is declared in neither section",
    ]);
    const manifest = { ...base.manifest, devDependencies: { ...base.manifest.devDependencies, vitest: "5.0.5" } };

    expect(run({ manifest, testImports: imports([["vitest", "src/a.test.ts"]]) })).toEqual([]);
  });

  it("fails a workspace devDependency no test imports, unless BUILD_ONLY names it", () => {
    const manifest = {
      ...base.manifest,
      devDependencies: { ...base.manifest.devDependencies, "@iracedeck/pi-components": "workspace:*" },
    };

    expect(run({ manifest })).toEqual([
      expect.stringContaining("declares @iracedeck/pi-components in devDependencies, but no test imports it"),
    ]);
    expect(run({ manifest, testImports: imports([["@iracedeck/pi-components", "src/a.test.ts"]]) })).toEqual([]);
    expect(run({ manifest, buildOnly: { ...BUILD_ONLY, "@iracedeck/pi-components": "reason" } })).toEqual([]);
  });

  it("fails a BUILD_ONLY entry the shell no longer declares", () => {
    const manifest = { ...base.manifest, devDependencies: { rollup: "4.64.8" } };

    expect(run({ manifest })).toEqual([
      "BUILD_ONLY names @iracedeck/plugin-build, which is not in its devDependencies",
    ]);
  });

  it("reads every import form, and no mention in a comment or a string", () => {
    const source = [
      'import a from "pkg-a";',
      'import type { B } from "@scope/b/sub/path";',
      'import "pkg-c";',
      'export { d } from "pkg-d";',
      'const e = await import("pkg-e");',
      'const f = require("pkg-f");',
      'import g from "node:path";',
      'import h from "fs";',
      'import i from "./local.js";',
      '// import j from "pkg-j";',
      '/* import("pkg-k") */',
      'const l = "import m from \\"pkg-m\\"";',
      "/** see `@iracedeck/pkg-n` */",
    ].join("\n");

    expect([...importedPackages(source)].sort()).toEqual(["@scope/b", "pkg-a", "pkg-c", "pkg-d", "pkg-e", "pkg-f"]);
  });
});
