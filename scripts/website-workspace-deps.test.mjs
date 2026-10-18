// The website deploy builds the site alone (`turbo run build --filter=@iracedeck/website`),
// so turbo builds only the workspace packages the website's package.json declares. A
// source the build runs that reaches an undeclared package (by name, or by a relative
// path into `packages/<pkg>/`) finds no `dist/` there, while every PR check runs a full
// `pnpm build` that hides the gap — which is how the v3.6.0 deploy failed (#1458).
// Test files are left out: the build never runs them, and the root suite builds everything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEBSITE_DIR = "packages/website";
const SOURCE = /\.(?:[cm]?[jt]s|mts|astro)$/;
const TEST = /\.test\.[cm]?[jt]s$/;

// Static `import … from "x"`, `export … from "x"`, side-effect `import "x"` and dynamic `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function packageNamesByDir() {
  const names = new Map();
  const dirs = execFileSync("git", ["ls-files", "packages/*/package.json"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
  for (const file of dirs) {
    names.set(path.posix.dirname(file).split("/")[1], JSON.parse(readFileSync(path.join(ROOT, file), "utf-8")).name);
  }

  return names;
}

/**
 * The workspace packages `source` (a repo-relative path) reaches, by package name.
 */
function workspaceImports(source, text, namesByDir) {
  const found = new Set();
  for (const [, spec] of text.matchAll(SPECIFIER)) {
    if (spec.startsWith("@iracedeck/")) {
      found.add(spec.split("/").slice(0, 2).join("/"));
    } else if (spec.startsWith(".")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), spec));
      const [top, dir] = target.split("/");
      if (top === "packages" && dir !== "website" && namesByDir.has(dir)) found.add(namesByDir.get(dir));
    }
  }

  return found;
}

function websiteSources() {
  return execFileSync("git", ["ls-files", WEBSITE_DIR], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((f) => SOURCE.test(f) && !TEST.test(f));
}

describe("website workspace dependencies (#1458)", () => {
  const namesByDir = packageNamesByDir();
  const pkg = JSON.parse(readFileSync(path.join(ROOT, WEBSITE_DIR, "package.json"), "utf-8"));
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));

  const reached = new Map();
  for (const file of websiteSources()) {
    for (const name of workspaceImports(file, readFileSync(path.join(ROOT, file), "utf-8"), namesByDir)) {
      if (!reached.has(name)) reached.set(name, []);
      reached.get(name).push(file);
    }
  }

  it("finds the gallery's imports, so the scan is not vacuous", () => {
    expect([...reached.keys()]).toEqual(
      expect.arrayContaining(["@iracedeck/icon-composer", "@iracedeck/iracing-actions"]),
    );
  });

  it("declares every workspace package a website source imports", () => {
    const undeclared = [...reached]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);

    expect(undeclared).toEqual([]);
  });

  it("reads a relative import into another package as that package", () => {
    const text = `import { x } from "../../iracing-actions/src/a.ts";\nimport y from "../src/local.js";\nconst z = await import("@iracedeck/deck-core/sub");\n`;

    expect([...workspaceImports("packages/website/scripts/gen.mts", text, namesByDir)].sort()).toEqual([
      "@iracedeck/deck-core",
      "@iracedeck/iracing-actions",
    ]);
  });
});
