// The website deploy builds the site alone (`turbo run build --filter=@iracedeck/website`),
// so turbo builds only the workspace packages the website's package.json declares. A
// source the build runs that reaches an undeclared package (by name, or by a relative
// path into `packages/<pkg>/`) finds no `dist/` there, while every PR check runs a full
// `pnpm build` that hides the gap — which is how the v3.6.0 deploy failed (#1458).
// The build also runs root `scripts/` modules the website imports by relative path, so
// those are followed and their imports count as the website's. A package reached is not
// followed: its own imports are its declared dependencies, which turbo builds with it.
// Test files are left out: the build never runs them, and the root suite builds everything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEBSITE_DIR = "packages/website";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx|astro|mdx)$/;
const TEST = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;

// Static `import … from "x"`, `export … from "x"`, side-effect `import "x"` and dynamic `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function packageNamesByDir() {
  const names = new Map();
  const manifests = execFileSync("git", ["ls-files", "packages/*/package.json"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    // git's `*` crosses `/`, so keep only a package root's own manifest, not a nested fixture's.
    .filter((file) => file.split("/").length === 3);
  for (const file of manifests) {
    names.set(file.split("/")[1], JSON.parse(readFileSync(path.join(ROOT, file), "utf-8")).name);
  }

  return names;
}

/**
 * What `source` (a repo-relative path) imports: the workspace packages it reaches, by
 * package name, and the repo-relative files outside `packages/` it imports by path.
 */
function workspaceImports(source, text, namesByDir) {
  const packages = new Set();
  const follow = new Set();
  for (const [, spec] of text.matchAll(SPECIFIER)) {
    if (spec.startsWith("@iracedeck/")) {
      packages.add(spec.split("/").slice(0, 2).join("/"));
    } else if (spec.startsWith(".")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), spec));
      const [top, dir] = target.split("/");
      if (top === "packages") {
        if (dir !== "website" && namesByDir.has(dir)) packages.add(namesByDir.get(dir));
      } else if (!target.startsWith("../")) {
        follow.add(target);
      }
    }
  }

  return { packages, follow };
}

function websiteSources() {
  return execFileSync("git", ["ls-files", WEBSITE_DIR], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((f) => SOURCE.test(f) && !TEST.test(f));
}

/**
 * Every workspace package the website's sources reach, directly or through the root
 * modules they import, with the files that reach it.
 */
function scan(sources, namesByDir) {
  const reached = new Map();
  const scanned = new Set();
  const queue = [...sources];
  while (queue.length > 0) {
    const file = queue.shift();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const { packages, follow } = workspaceImports(file, readFileSync(path.join(ROOT, file), "utf-8"), namesByDir);
    for (const name of packages) {
      if (!reached.has(name)) reached.set(name, []);
      reached.get(name).push(file);
    }
    for (const target of follow) {
      if (SOURCE.test(target) && !TEST.test(target) && existsSync(path.join(ROOT, target))) queue.push(target);
    }
  }

  return { reached, scanned };
}

describe("website workspace dependencies (#1458)", () => {
  const namesByDir = packageNamesByDir();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, WEBSITE_DIR, "package.json"), "utf-8"));
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));

  const sources = websiteSources();
  const { reached, scanned } = scan(sources, namesByDir);

  it("treats JSX and TSX as sources and their tests as tests, though the site has none yet", () => {
    for (const ext of [".jsx", ".tsx"]) {
      expect(SOURCE.test(`packages/website/src/a${ext}`)).toBe(true);
      expect(TEST.test(`packages/website/src/a.test${ext}`)).toBe(true);
    }
  });

  it("scans every kind of source the build compiles", () => {
    for (const ext of [".mts", ".mjs", ".ts", ".astro", ".mdx"]) {
      expect(sources.some((f) => f.endsWith(ext))).toBe(true);
    }
  });

  it("follows the root modules the website imports", () => {
    expect([...scanned]).toEqual(
      expect.arrayContaining(["scripts/lib/voice-catalog-data.mjs", "scripts/lib/changelog-composed.mjs"]),
    );
  });

  it("finds the generators' imports, so the scan is not vacuous", () => {
    expect([...reached.keys()]).toEqual(
      expect.arrayContaining([
        "@iracedeck/icon-composer",
        "@iracedeck/iracing-actions",
        // reached through scripts/lib/voice-catalog-data.mjs
        "@iracedeck/voice-packs",
      ]),
    );
  });

  it("declares every workspace package a website source imports", () => {
    const undeclared = [...reached]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);

    expect(undeclared).toEqual([]);
  });

  it("reads a relative import into another package as that package, and a root module as one to follow", () => {
    const text = `import { x } from "../../iracing-actions/src/a.ts";\nimport y from "../src/local.js";\nimport w from "../../../scripts/lib/w.mjs";\nconst z = await import("@iracedeck/deck-core/sub");\n`;
    const { packages, follow } = workspaceImports("packages/website/scripts/gen.mts", text, namesByDir);

    expect([...packages].sort()).toEqual(["@iracedeck/deck-core", "@iracedeck/iracing-actions"]);
    // The website's own files are scanned already, so only the root module is left to follow.
    expect([...follow]).toEqual(["scripts/lib/w.mjs"]);
  });
});
