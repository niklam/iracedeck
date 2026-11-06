import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  importedPackages,
  isTestSource,
  moduleReferences,
  packageOf,
  trackedPackageSources,
  VENDORED_SOURCES,
} from "./source-imports.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("importedPackages", () => {
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
      'type O = typeof import("pkg-o");',
    ].join("\n");

    expect([...importedPackages(source)].sort()).toEqual([
      "@scope/b",
      "pkg-a",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-f",
      "pkg-o",
    ]);
  });

  it("names a scoped package without its subpath, and nothing for a relative path or a builtin", () => {
    expect(packageOf("@iracedeck/deck-core/testing")).toBe("@iracedeck/deck-core");
    expect(packageOf("zod/v4")).toBe("zod");
    expect(packageOf("../deck-core/src/index.js")).toBeNull();
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("path")).toBeNull();
  });
});

describe("moduleReferences", () => {
  it("gives each import the offset of its opening quote, and keeps a triple-slash path apart", () => {
    const source = '/// <reference path="../types.d.ts" />\nimport a from "./a.js";\nconst b = require("../b");';
    const references = moduleReferences(source);

    expect(references).toEqual([
      { specifier: "./a.js", kind: "import", pos: source.indexOf('"./a.js"') },
      { specifier: "../b", kind: "import", pos: source.indexOf('"../b"') },
      { specifier: "../types.d.ts", kind: "reference" },
    ]);
    // A path reference is not a package.
    expect([...importedPackages(source)]).toEqual([]);
  });
});

describe("isTestSource", () => {
  it.each([
    "packages/x/src/a.test.ts",
    "packages/x/src/a.test.mjs",
    "packages/x/src/a.test-support.ts",
    "packages/x/src/a.test-util.ts",
    "packages/x/src/shared/dial-box-baseline.fixture-cases.ts",
    "packages/x/src/test-support/fake-host.ts",
  ])("counts %s as a test", (file) => {
    expect(isTestSource(file)).toBe(true);
  });

  it.each(["packages/x/src/a.ts", "packages/x/src/testing.ts", "packages/x/src/latest-support/a.ts"])(
    "counts %s as production",
    (file) => {
      expect(isTestSource(file)).toBe(false);
    },
  );
});

describe("trackedPackageSources", () => {
  const files = trackedPackageSources(ROOT);

  it("lists the packages' sources and leaves out build output, plugin bundles and vendored files", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain("packages/deck-core/src/index.ts");
    expect(files).toContain("packages/plugin-build/src/plugin-rollup.mjs");
    expect(files.some((file) => /(^|\/)(dist|node_modules)\/|\.sdPlugin\/|\.ulanziPlugin\//.test(file))).toBe(false);
    for (const vendored of Object.keys(VENDORED_SOURCES)) expect(files).not.toContain(vendored);
  });

  it("names only vendored files git still tracks", () => {
    for (const vendored of Object.keys(VENDORED_SOURCES)) {
      const listed = execFileSync("git", ["ls-files", "--", vendored], { cwd: ROOT, encoding: "utf-8" }).trim();

      expect(listed, vendored).toBe(vendored);
    }
  });
});
