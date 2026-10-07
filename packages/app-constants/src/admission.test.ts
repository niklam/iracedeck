import { describe, expect, it } from "vitest";

/**
 * The admission rule of `@iracedeck/app-constants` (spec #1351): constants,
 * types and pure functions over them, and nothing else — zero dependencies, so
 * every layer and the Property Inspector's browser bundle can import it.
 *
 * Two halves enforce it. `tsconfig.json` (`lib: ["es2022"]`, `types: []`)
 * makes any Node or DOM global a type error. This test refuses any import: the
 * barrel (`index.ts`) may only re-export the package's own modules
 * (`./<name>.js`), and every other module imports nothing at all, types
 * included. That is stricter than "no bare specifier" on purpose — it keeps
 * every module a leaf on its own, which is what `key-binding-defaults.ts`'
 * own test asserted before this package existed.
 *
 * The sources are read through Vite's `import.meta.glob` rather than
 * `node:fs`, because this package has no Node typings for its tests either:
 * declaring them for one test file would declare them for the whole program
 * and switch the tsconfig half of the rule off.
 */
declare global {
  interface ImportMeta {
    glob<T>(
      patterns: string | readonly string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, T>;
  }
}

const sources = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The source with block and line comments blanked, so a doc comment quoting an import is not one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every module specifier the source names: `import … from`, `export … from`, a side-effect import. */
function specifiers(source: string): string[] {
  const body = code(source);
  const found: string[] = [];

  for (const match of body.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
    found.push(match[1]);
  }

  for (const match of body.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
    found.push(match[1]);
  }

  return found;
}

/** Imports that `specifiers` cannot see by shape: a dynamic `import(…)` or a `require(…)`. */
function hasDynamicLoad(source: string): boolean {
  return /\bimport\s*\(|\brequire\s*\(/.test(code(source));
}

const modules = Object.entries(sources).filter(([file]) => file !== "./index.ts");

describe("app-constants admission (spec #1351)", () => {
  it("reads the package's sources", () => {
    // Without this an empty glob would pass every check below vacuously.
    expect(Object.keys(sources)).toContain("./index.ts");
    expect(Object.keys(sources)).toContain("./key-binding-defaults.ts");
    expect(modules.length).toBeGreaterThan(5);
  });

  it.each(modules)("%s imports nothing", (_file, source) => {
    expect(specifiers(source)).toEqual([]);
    expect(code(source)).not.toMatch(/^\s*import\b/m);
    expect(hasDynamicLoad(source)).toBe(false);
  });

  it("the barrel re-exports only the package's own modules", () => {
    const index = sources["./index.ts"];

    for (const specifier of specifiers(index)) {
      expect(specifier).toMatch(/^\.\/[\w-]+\.js$/);
    }

    expect(hasDynamicLoad(index)).toBe(false);
  });

  it.each(modules)("%s is exported by the barrel", (file) => {
    const specifier = file.replace(/\.ts$/, ".js");

    expect(specifiers(sources["./index.ts"])).toContain(specifier);
  });
});
