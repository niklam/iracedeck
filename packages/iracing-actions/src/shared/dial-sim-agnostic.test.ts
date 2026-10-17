import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dial primitives and the dash-box renderers must stay liftable into a
 * sim-neutral package when a second action package exists (#1013): they may
 * import deck-core and zod, never the iRacing SDK or its translator, and among
 * the package's own files only each other — a relative import of any other
 * shared module (the replay gate or indicator, say) is an edge that would not
 * lift with them (#1437). A source-text guard, because the thing forbidden is
 * an import edge, not a behaviour.
 */
const SHARED = join(process.cwd(), "packages/iracing-actions/src/shared");
const FORBIDDEN = ["@iracedeck/iracing-sdk", "@iracedeck/sim-events-iracing"];
const dialModules = readdirSync(SHARED).filter(
  (f) => f.startsWith("dial-") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

/** Every relative module specifier in `source`: static imports and re-exports, side-effect imports and `import()`. */
function relativeSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']*)["']/g;

  return [...source.matchAll(pattern)].map((m) => m[1]);
}

describe("shared/dial-* stays free of sim imports", () => {
  it("finds the dial modules", () => {
    expect(dialModules).toEqual(
      expect.arrayContaining([
        "dial-box.ts",
        "dial-fit.ts",
        "dial-strip-box.ts",
        "dial-knob-box.ts",
        "dial-name-icon.ts",
        "dial-preview.ts",
        "dial-release.ts",
      ]),
    );
  });

  it.each(dialModules)("%s", (file) => {
    const source = readFileSync(join(SHARED, file), "utf-8");

    for (const pkg of FORBIDDEN) expect(source, `${file} imports ${pkg}`).not.toContain(pkg);

    for (const specifier of relativeSpecifiers(source)) {
      expect(specifier, `${file} imports ${specifier}, which is not a shared/dial-* module`).toMatch(/^\.\/dial-/);
    }
  });

  it("reads every shape of relative import, so the check above can fail", () => {
    const source = [
      'import type { A } from "./replay-busy-indicator.js";',
      "import { b } from '../actions/x.js';",
      'export type { C } from "./dial-box.js";',
      'import "./side-effect.js";',
      'const d = await import("./lazy.js");',
      'import { z } from "zod";',
    ].join("\n");

    expect(relativeSpecifiers(source)).toEqual([
      "./replay-busy-indicator.js",
      "../actions/x.js",
      "./dial-box.js",
      "./side-effect.js",
      "./lazy.js",
    ]);
  });
});
