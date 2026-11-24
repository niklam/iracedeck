import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COMPONENT,
  importedPackages,
  isTestSource,
  moduleReferences,
  moduleSource,
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

describe("moduleSource (#1662)", () => {
  /** The imports `text` makes as `file`, read through moduleSource. */
  const specifiers = (file, text) => moduleReferences(moduleSource(file, text)).map(({ specifier }) => specifier);

  it("passes a code file through unchanged", () => {
    const text = 'import a from "./a.js";\n<p>not markup in a .ts</p>';

    expect(moduleSource("packages/x/src/a.ts", text)).toBe(text);
  });

  describe("an .astro component", () => {
    const text = [
      "---",
      'import Card from "./Card.astro";',
      'import { rows } from "../../../iracing-actions/src/rows.js";',
      "---",
      "",
      '<p>import x from "../../../deck-iracing/src/a.js"</p>',
      '<!-- <script>import "../../../iracing-sdk/src/b.js";</script> -->',
      '<script type="application/ld+json">{ "import": "../../../c.js" }</script>',
      '<script type="importmap">{ "imports": { "d": "../../../d.js" } }</script>',
      "<script>",
      '  import { go } from "../client/go.js";',
      "  go();",
      "</script>",
      '<script is:inline>import "../inline.js";</script><script>import "../after.js";</script>',
      "",
    ].join("\n");
    const file = "packages/website/src/components/Planted.astro";

    it("reads its frontmatter and each <script> ESLint reads, at the file's own offsets", () => {
      const source = moduleSource(file, text);

      expect(source).toHaveLength(text.length);
      expect(source.split("\n")).toHaveLength(text.split("\n").length);
      expect(source.indexOf('"../../../iracing-actions/src/rows.js"')).toBe(
        text.indexOf('"../../../iracing-actions/src/rows.js"'),
      );
      expect(specifiers(file, text)).toEqual([
        "./Card.astro",
        "../../../iracing-actions/src/rows.js",
        "../client/go.js",
        "../inline.js",
        "../after.js",
      ]);
    });

    it("reads nothing from markup, a comment, a JSON script or an import map", () => {
      const source = moduleSource(file, text);

      for (const mention of ["deck-iracing", "iracing-sdk", "../../../c.js", "../../../d.js", "<p>", "<script"]) {
        expect(source, mention).not.toContain(mention);
      }
    });

    it("reads a component with no frontmatter by its scripts alone, and one with neither as empty", () => {
      expect(specifiers(file, '<p>x</p>\n<script>import "./a.js";</script>\n')).toEqual(["./a.js"]);
      expect(moduleSource(file, '<p>import a from "./a.js"</p>\n').trim()).toBe("");
    });
  });

  describe("an .mdx page", () => {
    const text = [
      "---",
      "title: Planted",
      'hero: "../../../../../iracing-actions/src/hero.js"',
      "---",
      "",
      'import Gallery from "../../../components/Gallery.astro";',
      "import {",
      "  ROWS,",
      '} from "../../../../../iracing-actions/src/rows.js";',
      'export const meta = { from: "../../../data/meta.json" };',
      "",
      'Prose that says import x from "../../../../../deck-iracing/src/a.js" mid-line.',
      "",
      "```ts",
      'import { y } from "../../../../../iracing-sdk/src/b.js";',
      "```",
      "",
      "<Gallery rows={ROWS} />",
      "",
    ].join("\n");
    const file = "packages/website/src/content/docs/planted.mdx";

    it("reads its import and export blocks, a multi-line import whole, at the file's own offsets", () => {
      const source = moduleSource(file, text);

      expect(source).toHaveLength(text.length);
      expect(specifiers(file, text)).toEqual([
        "../../../components/Gallery.astro",
        "../../../../../iracing-actions/src/rows.js",
      ]);
      expect(source).toContain('export const meta = { from: "../../../data/meta.json" };');
    });

    it("reads nothing from the frontmatter, prose, fenced code or JSX", () => {
      const source = moduleSource(file, text);

      for (const mention of ["hero.js", "deck-iracing", "iracing-sdk", "Prose", "<Gallery"]) {
        expect(source, mention).not.toContain(mention);
      }
    });
  });
});

describe("trackedPackageSources", () => {
  const files = trackedPackageSources(ROOT);

  it("lists the .astro components and .mdx pages only when asked, and never a plain .md", () => {
    const withComponents = trackedPackageSources(ROOT, { components: true });
    const components = withComponents.filter((file) => COMPONENT.test(file));

    expect(files.some((file) => COMPONENT.test(file))).toBe(false);
    expect(components).toContain("packages/website/src/components/IconGallery.astro");
    expect(components).toContain("packages/website/src/content/docs/docs/development/icon-gallery.mdx");
    expect(withComponents.filter((file) => !COMPONENT.test(file))).toEqual(files);
    expect(withComponents.some((file) => file.endsWith(".md"))).toBe(false);
  });

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
