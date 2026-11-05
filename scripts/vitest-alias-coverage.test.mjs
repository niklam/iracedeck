import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import rootConfig from "../vitest.config.ts";
import { pickTarget } from "./lib/package-exports.mjs";
import { trackedPackageDirs } from "./lib/workspace-packages.mjs";

// Guard for #1375: every `@iracedeck/*` import a test can make resolves to
// TypeScript source, never to a package's built `dist/`.
//
// The root `vitest.config.ts` points each package's export at its `src` through
// a hand-kept alias list. Nothing checked that list, so a package nobody had
// aliased (the three deck adapters and `rasterizer`, until #1375) resolved to
// `dist/` while everything else resolved to `src/` — a test then ran against
// whatever was last built, stale or missing, with nothing red. A new package or
// a new `exports` subpath fell into the same hole silently.
//
// The rule, per package and per entry of its `exports` map (or its `main` when
// it has no `exports`):
//   * an entry whose target is a build output (`dist/…`) needs an alias whose
//     target is the source file that output is compiled from (`src/….ts`), OR
//     a named entry in RESOLVED_TO_DIST below saying why it is left alone;
//   * an entry whose target is already source (`./src/index.ts`, a `.mjs`, a
//     JSON file) needs nothing — Vitest resolves it to source on its own.
// And in the other direction: every `@iracedeck/*` alias names an entry some
// package exports and points at a file that exists, a subpath alias comes
// before its bare package's alias (Vite matches a string alias as a prefix, so
// the bare one listed first would swallow `<pkg>/testing`), and every
// RESOLVED_TO_DIST entry still names an unaliased build-output entry.
//
// The aliases are read from the imported config, so this checks what Vitest
// actually uses rather than the text of the file.

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const SCOPE = "@iracedeck/";

/**
 * Build-output entries deliberately left resolving to `dist/`, each with its
 * reason. Keyed by the import specifier (`@iracedeck/<pkg>` or
 * `@iracedeck/<pkg>/<subpath>`). An entry here that stops being needed — the
 * package or subpath is gone, it is now aliased, or it now points at source —
 * fails the suite, so the list cannot rot.
 *
 * Empty since #1375: its one entry, `@iracedeck/scenario-harness`, named the
 * harness's start script as a `main` no package imported, and the package
 * dropped `main` and `types` instead — it is run, never imported.
 */
const RESOLVED_TO_DIST = {};

/**
 * Every importable entry of a manifest as `{ subpath, target }`: each key of an
 * `exports` map, the one entry of a conditions-only or string `exports`, or
 * `main` when there is no `exports` at all.
 */
export function exportEntries(manifest) {
  const { exports } = manifest;

  if (exports === undefined || exports === null) {
    return manifest.main ? [{ subpath: ".", target: manifest.main }] : [];
  }

  if (typeof exports === "string" || Array.isArray(exports)) {
    return [{ subpath: ".", target: pickTarget(exports) }];
  }

  const keys = Object.keys(exports);

  if (keys.length > 0 && keys.every((k) => !k.startsWith("."))) {
    return [{ subpath: ".", target: pickTarget(exports) }];
  }

  return keys.map((subpath) => ({ subpath, target: pickTarget(exports[subpath]) }));
}

const posix = (p) => p.replaceAll("\\", "/").replace(/^\.\//, "");

/** Whether an export target is compiled output rather than source. */
const isBuildOutput = (target) => posix(target).startsWith("dist/");

/** The source files a `dist/` target may be compiled from, most likely first. */
function sourceCandidates(target) {
  const rel = "src/" + posix(target).slice("dist/".length);
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  const exts = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[ext] ?? [];

  return exts.map((e) => stem + e);
}

const samePath = (a, b) => path.relative(a, b) === "";

const specifierOf = (name, subpath) => (subpath === "." ? name : name + subpath.slice(1));

/**
 * The whole check, pure over its inputs so the positive controls can feed it
 * synthetic packages.
 *
 * @param {object} input
 * @param {{ name: string, dir: string, entries: { subpath: string, target: string | null }[], layout: { rootDir?: string, outDir?: string } | null }[]} input.packages
 * @param {[string, string][]} input.aliases  `[find, replacement]` in the config's order
 * @param {Record<string, string>} input.allowList  specifier → reason
 * @param {(file: string) => boolean} input.fileExists
 * @returns {string[]} one line per problem; empty when the suite is consistent
 */
export function checkAliasCoverage({ packages, aliases, allowList, fileExists }) {
  const problems = [];
  const scoped = aliases.filter(([find]) => find.startsWith(SCOPE));
  const aliasOf = new Map(scoped);
  const known = new Set();

  for (const pkg of packages) {
    for (const { subpath, target } of pkg.entries) {
      const spec = specifierOf(pkg.name, subpath);
      known.add(spec);

      if (!target) {
        problems.push(
          `${spec}: its "exports" entry has no import/node/development/default target this guard can read.`,
        );
        continue;
      }

      const alias = aliasOf.get(spec);
      const allowed = Object.hasOwn(allowList, spec);

      if (!isBuildOutput(target)) {
        if (alias && !samePath(alias, path.join(pkg.dir, target))) {
          problems.push(`${spec}: the alias points at ${alias}, but the export is the source file ${target} itself.`);
        }

        if (allowed) {
          problems.push(`${spec}: RESOLVED_TO_DIST names it, but it exports source (${target}); remove the entry.`);
        }

        continue;
      }

      // The dist→src mapping below assumes tsc compiles `src/` into `dist/`.
      const rootDir = posix(pkg.layout?.rootDir ?? "");
      const outDir = posix(pkg.layout?.outDir ?? "");

      if (rootDir !== "src" || outDir !== "dist") {
        problems.push(
          `${spec}: exports ${target} but its tsconfig is not rootDir "src" / outDir "dist" ` +
            `(read rootDir=${JSON.stringify(pkg.layout?.rootDir)}, outDir=${JSON.stringify(pkg.layout?.outDir)}); ` +
            "teach this guard the package's layout.",
        );
        continue;
      }

      const candidates = sourceCandidates(target);
      const source = candidates.map((c) => path.join(pkg.dir, c)).find((f) => fileExists(f));

      if (!source) {
        problems.push(
          `${spec}: exports ${target}, but no source it is built from exists (looked for ${candidates.join(", ") || "nothing: unknown extension"}).`,
        );
        continue;
      }

      if (alias) {
        if (!samePath(alias, source)) {
          problems.push(`${spec}: the alias points at ${alias}, but ${target} is built from ${source}.`);
        }

        if (allowed) {
          problems.push(`${spec}: RESOLVED_TO_DIST names it, but it is aliased; remove the entry.`);
        }
      } else if (!allowed) {
        const rel = posix(path.relative(pkg.dir, source));
        const folder = path.basename(pkg.dir);
        const arg = rel === "src/index.ts" ? `"${folder}"` : `"${folder}", "${rel}"`;
        problems.push(
          `${spec}: tests resolve it to ${target}. Add \`"${spec}": packageSrc(${arg})\` to the aliases in ` +
            "vitest.config.ts (a subpath before its bare package), or name it in RESOLVED_TO_DIST with the reason.",
        );
      }
    }
  }

  for (const [find, replacement] of scoped) {
    if (!known.has(find)) {
      problems.push(`alias ${find}: no workspace package exports that specifier; remove the alias.`);
    }

    if (!fileExists(replacement)) {
      problems.push(`alias ${find}: points at ${replacement}, which does not exist.`);
    }
  }

  for (const spec of Object.keys(allowList)) {
    if (!known.has(spec)) {
      problems.push(`RESOLVED_TO_DIST names ${spec}, which no workspace package exports any more; remove the entry.`);
    }
  }

  // Vite matches a string alias when the import equals it or starts with it
  // plus "/", in list order, so a bare package alias must follow its subpaths.
  scoped.forEach(([bare], i) => {
    for (const [later] of scoped.slice(i + 1)) {
      if (later.startsWith(bare + "/")) {
        problems.push(`alias ${later} comes after ${bare}, which matches it first; move it above.`);
      }
    }
  });

  return problems;
}

/** The root config's aliases as ordered `[find, replacement]` pairs. */
function configAliases(alias) {
  if (Array.isArray(alias)) {
    return alias.filter((a) => typeof a.find === "string").map((a) => [a.find, a.replacement]);
  }

  return Object.entries(alias ?? {});
}

function readLayout(dir) {
  const file = path.join(dir, "tsconfig.json");
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, "utf8")).compilerOptions ?? {};
  } catch {
    return null;
  }
}

const workspacePackages = trackedPackageDirs(ROOT).map((name) => {
  const dir = path.join(PACKAGES, name);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));

  return { name: manifest.name, dir, entries: exportEntries(manifest), layout: readLayout(dir) };
});

const rootAliases = configAliases(rootConfig.resolve?.alias);

describe("vitest alias coverage (#1375)", () => {
  it("reads a real workspace and a real alias list", () => {
    // Vacuity floor: a reader that found nothing would pass the check below.
    const builtEntries = workspacePackages.flatMap((p) => p.entries.filter((e) => e.target && isBuildOutput(e.target)));
    expect(workspacePackages.length).toBeGreaterThan(30);
    expect(builtEntries.length).toBeGreaterThan(25);
    expect(rootAliases.filter(([find]) => find.startsWith(SCOPE)).length).toBeGreaterThan(25);
  });

  it("resolves every @iracedeck/* export a test can import to source", () => {
    expect(
      checkAliasCoverage({
        packages: workspacePackages,
        aliases: rootAliases,
        allowList: RESOLVED_TO_DIST,
        fileExists: existsSync,
      }),
    ).toEqual([]);
  });

  describe("positive controls: the check fails when it should", () => {
    const dir = path.join(ROOT, "packages", "fake");
    const index = path.join(dir, "src", "index.ts");
    const testing = path.join(dir, "src", "testing.ts");
    const files = new Set([index, testing]);
    const fileExists = (f) => files.has(f);
    const layout = { rootDir: "src", outDir: "dist" };
    const pkg = (exports) => ({ name: "@iracedeck/fake", dir, entries: exportEntries({ exports }), layout });
    const both = {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      "./testing": { import: "./dist/testing.js", types: "./dist/testing.d.ts" },
    };
    const run = (over) =>
      checkAliasCoverage({
        packages: [pkg(both)],
        aliases: [
          ["@iracedeck/fake/testing", testing],
          ["@iracedeck/fake", index],
        ],
        allowList: {},
        fileExists,
        ...over,
      });

    it("passes the consistent baseline", () => {
      expect(run({})).toEqual([]);
    });

    it("reports a dist export with no alias", () => {
      const problems = run({ aliases: [["@iracedeck/fake", index]] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"@iracedeck/fake/testing": packageSrc("fake", "src/testing.ts")');
    });

    it("reports an alias pointing at a missing file", () => {
      const gone = path.join(dir, "src", "gone.ts");
      const problems = run({
        aliases: [
          ["@iracedeck/fake/testing", testing],
          ["@iracedeck/fake", gone],
        ],
      });
      expect(problems.some((p) => p.includes("does not exist"))).toBe(true);
      expect(problems.some((p) => p.includes("is built from"))).toBe(true);
    });

    it("reports an alias for a specifier no package exports", () => {
      const problems = run({
        aliases: [
          ["@iracedeck/fake/testing", testing],
          ["@iracedeck/fake/extra", testing],
          ["@iracedeck/fake", index],
        ],
      });
      expect(problems).toEqual([expect.stringContaining("alias @iracedeck/fake/extra: no workspace package exports")]);
    });

    it("reports a subpath alias listed after its bare package", () => {
      const problems = run({
        aliases: [
          ["@iracedeck/fake", index],
          ["@iracedeck/fake/testing", testing],
        ],
      });
      expect(problems).toEqual([expect.stringContaining("comes after @iracedeck/fake")]);
    });

    it("reports allow-list entries that went stale", () => {
      const problems = run({ allowList: { "@iracedeck/fake": "x", "@iracedeck/removed": "y" } });
      expect(problems).toHaveLength(2);
      expect(problems.some((p) => p.includes("@iracedeck/fake: RESOLVED_TO_DIST names it, but it is aliased"))).toBe(
        true,
      );
      expect(problems.some((p) => p.includes("@iracedeck/removed, which no workspace package exports"))).toBe(true);
    });

    it("accepts an allow-listed unaliased entry and a source export without an alias", () => {
      expect(
        run({
          packages: [
            pkg(both),
            { name: "@iracedeck/raw", dir, entries: exportEntries({ exports: "./src/index.ts" }), layout: null },
          ],
          aliases: [["@iracedeck/fake", index]],
          allowList: { "@iracedeck/fake/testing": "reason" },
        }),
      ).toEqual([]);
    });

    it("reports a dist export whose package layout the mapping does not know", () => {
      const problems = run({ packages: [{ ...pkg(both), layout: { rootDir: "lib", outDir: "dist" } }] });
      expect(problems.filter((p) => p.includes("teach this guard"))).toHaveLength(2);
    });

    // Node and Vite take the first key of the conditions object that is
    // active, so an object listing `node` before `import` resolves to the
    // `node` target. A guard walking its own condition order classed this
    // shape as source and passed it unaliased.
    it("reports a dist export that an earlier node key hides behind a source import key", () => {
      const nodeFirst = { node: "./dist/index.js", import: "./src/index.ts" };
      expect(exportEntries({ exports: { ".": nodeFirst } })).toEqual([{ subpath: ".", target: "./dist/index.js" }]);

      const problems = run({ packages: [pkg({ ".": nodeFirst })], aliases: [] });
      expect(problems).toEqual([expect.stringContaining('"@iracedeck/fake": packageSrc("fake")')]);
    });

    it("reads main when there is no exports map", () => {
      expect(exportEntries({ main: "dist/index.js" })).toEqual([{ subpath: ".", target: "dist/index.js" }]);
      expect(exportEntries({})).toEqual([]);
    });
  });
});
