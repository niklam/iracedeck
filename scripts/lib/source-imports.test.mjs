import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COMPONENT,
  importedPackages,
  isTestSource,
  markupLoads,
  moduleReferences,
  moduleSources,
  packageOf,
  trackedPackageSources,
  unclosedComment,
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

describe("moduleSources (#1662)", () => {
  /** The imports `text` makes as `file`, read through moduleSources. */
  const specifiers = (file, text) =>
    moduleSources(file, text).flatMap((source) => moduleReferences(source).map(({ specifier }) => specifier));
  /** Every module of `text` as `file`, joined, for what none of them may hold. */
  const joined = (file, text) => moduleSources(file, text).join("\n");

  it("passes a code file through unchanged", () => {
    const text = 'import a from "./a.js";\n<p>not markup in a .ts</p>';

    expect(moduleSources("packages/x/src/a.ts", text)).toEqual([text]);
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
      const sources = moduleSources(file, text);

      // The frontmatter, then the three script bodies: each its own module.
      expect(sources).toHaveLength(4);
      for (const source of sources) {
        expect(source).toHaveLength(text.length);
        expect(source.split("\n")).toHaveLength(text.split("\n").length);
      }
      expect(sources[0].indexOf('"../../../iracing-actions/src/rows.js"')).toBe(
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
      const source = joined(file, text);

      for (const mention of ["deck-iracing", "iracing-sdk", "../../../c.js", "../../../d.js", "<p>", "<script"]) {
        expect(source, mention).not.toContain(mention);
      }
    });

    it("reads a component with no frontmatter by its scripts alone, and one with neither as empty", () => {
      expect(specifiers(file, '<p>x</p>\n<script>import "./a.js";</script>\n')).toEqual(["./a.js"]);
      expect(moduleSources(file, '<p>import a from "./a.js"</p>\n')).toEqual([]);
    });

    // Astro compiles each script alone, so what one leaves open on its last line cannot run into the next.
    it("reads each script apart, so a comment ending one hides nothing after it on its line", () => {
      for (const [script, expected] of [
        ['<script>// Setup</script><script src="./client.ts"></script>', ["./client.ts"]],
        ['<script>// Setup</script><script>import "./next.js";</script>', ["./next.js"]],
        ['<script>/* open</script><script>import "./after-block.js";</script>', ["./after-block.js"]],
        ['<script>const s = `</script><script src="./after-template.ts"></script>', ["./after-template.ts"]],
      ]) {
        expect(specifiers(file, script), script).toEqual(expected);
      }
    });

    // Astro bundles a local <script src>, so it is the import of what it names.
    it("reads each <script src> that names a module as its import, the quote at the attribute's own offset", () => {
      const scripts = [
        "---",
        'import Card from "./Card.astro";',
        "---",
        '<script src="../../../iracing-actions/src/a.js"></script>',
        "<script type=\"module\" src='./single.ts' defer></script>",
        "<script src=./unquoted.js></script>",
        '<script data-src="./not-src.js" src="@iracedeck/iracing-sdk">import "./body.js";</script>',
        '<script data-type="json">import "./data-type.js";</script>',
        '<script src="https://cdn.example.com/x.js"></script>',
        '<script src="//cdn.example.com/y.js"></script>',
        '<script type="application/json" src="./z.json"></script>',
        '<!-- <script src="./commented.js"></script> -->',
        // Left for the browser to fetch from the served site, its body still read as ESLint reads it.
        '<script is:inline src="/diagram-zoom.js"></script>',
        '<script src="./inline-relative.js" is:inline>import "./inline-body.js";</script>',
        "<script IS:INLINE src='./inline-upper.js'></script>",
        // A processed script's root-absolute src is read, for the walk to refuse as an absolute path.
        '<script src="/root-absolute.js"></script>',
        // A look-alike attribute is not the directive.
        '<script data-is:inline src="./not-inline.js"></script>',
        "",
      ].join("\n");
      const sources = moduleSources(file, scripts);
      const source = sources.join("\n");

      for (const each of sources) {
        expect(each).toHaveLength(scripts.length);
        expect(each.split("\n")).toHaveLength(scripts.split("\n").length);
      }
      expect(specifiers(file, scripts)).toEqual([
        "./Card.astro",
        "../../../iracing-actions/src/a.js",
        "./single.ts",
        "./unquoted.js",
        "@iracedeck/iracing-sdk",
        "./body.js",
        "./data-type.js",
        "./inline-body.js",
        "/root-absolute.js",
        "./not-inline.js",
      ]);
      const quoteOf = (specifier) =>
        sources.flatMap(moduleReferences).find((reference) => reference.specifier === specifier).pos;

      expect(quoteOf("../../../iracing-actions/src/a.js")).toBe(scripts.indexOf('"../../../iracing-actions/src/a.js"'));
      expect(quoteOf("./single.ts")).toBe(scripts.indexOf("'./single.ts'"));
      // An unquoted value has no quote of its own: its synthetic one sits two characters before it, on its line.
      expect(quoteOf("./unquoted.js")).toBe(scripts.indexOf("./unquoted.js") - 2);
      for (const mention of [
        "not-src",
        "cdn.example.com",
        "z.json",
        "commented",
        "diagram-zoom",
        "inline-relative",
        "inline-upper",
      ]) {
        expect(source, mention).not.toContain(mention);
      }
    });

    // A <script> or <style> body is raw text up to its end tag: a "<!--" in it opens no
    // comment, so it hides neither the end tag nor anything after it.
    it("reads a comment opener inside a <script> or <style> body as text, and a comment in markup as a comment", () => {
      const text = [
        "---",
        'const fm = "<!--";',
        "---",
        "<script>",
        '  const marker = "<!--";',
        '  const later = await import("./later.js");',
        "</script>",
        '<style>.a::before { content: "<!--"; }</style>',
        '<script>import "./after-style.js";</script>',
        '<!-- <script>import "./commented.js";</script> -->',
        '<!--><script>import "./after-abrupt.js";</script>',
        '<!---><script>import "./after-abrupt-dash.js";</script>',
        '<!-- a --!><script>import "./after-bang.js";</script>',
        '<!-- <script>const s = "-->"; import "./after-early-close.js";</script> -->',
        "<SCRIPT>import './upper.js';</SCRIPT >",
        "",
      ].join("\n");

      expect(specifiers(file, text)).toEqual([
        "./later.js",
        "./after-style.js",
        "./after-abrupt.js",
        "./after-abrupt-dash.js",
        "./after-bang.js",
        "./upper.js",
      ]);
      expect(joined(file, text)).not.toContain("commented");
      expect(unclosedComment(file, text)).toBeUndefined();
    });

    // A template expression is JavaScript: a "<!--" in one is a string or the like,
    // never a comment, so it hides no <script> after it.
    it("reads a comment opener inside a template expression as JavaScript, not a comment", () => {
      const text = [
        "---",
        "const a = 1;",
        "---",
        '<p>{"<!--"}</p>',
        '<script src="./client.ts"></script>',
        "<!-- note -->",
        "<p>{'<!--'} {`<!--${a}`} {/* <!-- */ a}</p>",
        '<script>import "./after-quoted.js";</script>',
        "<!-- a real comment: <script>import './commented.js';</script> -->",
        "",
      ].join("\n");

      expect(specifiers(file, text)).toEqual(["./client.ts", "./after-quoted.js"]);
      expect(unclosedComment(file, text)).toBeUndefined();
    });

    // An expression whose end this cannot find runs to the end of the file, so a "<!--" after it reads as no comment.
    it("reads no comment after a template expression it cannot bound", () => {
      for (const expression of [
        '{a < b && "x"}',
        "{x && <b>bold</b>}",
        "{a / b}",
        "{/}/.test(s)}",
        '{"never closed"',
      ]) {
        const text = `${expression}\n<!-- <script>import "./after.js";</script> -->\n`;

        expect(specifiers(file, text), expression).toEqual(["./after.js"]);
      }
      // One it can bound ends where its brace closes, so a comment after it is one.
      expect(specifiers(file, '{"}" + `${"{"}`}\n<!-- <script>import "./x.js";</script> -->\n')).toEqual([]);
    });

    it("reads a script whose end tag never comes to the end of the file, as HTML does", () => {
      expect(specifiers(file, '<p>x</p>\n<script>\nimport "./open.js";\n')).toEqual(["./open.js"]);
    });

    it("names the line of a markup comment that never closes, and none for a closed one or a code file", () => {
      const open = '---\nconst a = 1;\n---\n<p>x</p>\n<!-- never closed <script>import "./hidden.js";</script>\n';

      expect(unclosedComment(file, open)).toBe(5);
      expect(specifiers(file, open)).toEqual([]);
      expect(unclosedComment(file, "<!-- closed --><p>x</p>")).toBeUndefined();
      expect(unclosedComment(file, '<script>const s = "<!--";</script>')).toBeUndefined();
      expect(unclosedComment("packages/x/src/a.ts", "const s = '<!--';")).toBeUndefined();
      expect(unclosedComment("packages/x/src/a.mdx", "<!-- open")).toBeUndefined();
    });
  });

  describe("markupLoads", () => {
    const astro = "packages/website/src/components/Planted.astro";
    const mdx = "packages/website/src/content/docs/planted.mdx";

    it("finds an import( or require( an .astro template expression could evaluate, by line", () => {
      const text = [
        "---",
        'const a = await import("./frontmatter.js");',
        "---",
        '<p>{import("@iracedeck/iracing-sdk")}</p>',
        "<Card load={() => require ('./b.js')} />",
        '<p>{x.import("./method.js")} {x.require("./method.js")} {reimport("./c.js")}</p>',
        '<!-- {import("./commented.js")} -->',
        '<script>const d = import("./script.js");</script>',
        '<script type="application/json">{ "e": "import(\'./json.js\')" }</script>',
        '<style>.f { content: "import(./style.css)"; }</style>',
        "",
      ].join("\n");

      expect(markupLoads(astro, text)).toEqual([
        { call: "import(", line: 4 },
        { call: "require(", line: 5 },
      ]);
    });

    it("finds one in .mdx prose or JSX, and none in its ESM, frontmatter, fenced code or code spans", () => {
      const text = [
        "---",
        'title: import("./frontmatter.js")',
        "---",
        "",
        'export const g = await import("./esm.js");',
        "",
        'Prose {import("@iracedeck/iracing-sdk")} and `import("./span.js")` and ``require("./span2.js")``.',
        "",
        '<Card load={require("./jsx.js")} />',
        "",
        "```ts",
        'const h = import("./fenced.js");',
        "```",
        "",
      ].join("\n");

      expect(markupLoads(mdx, text)).toEqual([
        { call: "import(", line: 7 },
        { call: "require(", line: 9 },
      ]);
    });

    // A backtick in a template expression opens a template literal, not a code span.
    it("finds a load in an .mdx expression's template literal, and in every line of one that spans lines", () => {
      const text = [
        'Prose {`${String(import("./client.js"))}`} and `import("./span.js")`.',
        'Prose {``+require("./empty-templates.js")+``} and ``require("./span2.js")``.',
        "{(",
        '  `${import("./multi-line.js")}`',
        ")}",
        "",
        '`import("./after.js")` is a code span again.',
        "",
        '{"}" + `${import("./string-brace.js")}`}',
        "",
      ].join("\n");

      expect(markupLoads(mdx, text)).toEqual([
        { call: "import(", line: 1 },
        { call: "require(", line: 2 },
        { call: "import(", line: 4 },
        { call: "import(", line: 9 },
      ]);
    });

    it("opens no code span or fence after an .mdx expression it cannot bound, and still reads ESM there", () => {
      const text = [
        "{a < b}",
        "",
        '`import("./span.js")`',
        "",
        "```ts",
        'require("./fenced.js");',
        "```",
        "",
        'import x from "@iracedeck/iracing-sdk";',
        "",
      ].join("\n");

      expect(markupLoads(mdx, text)).toEqual([
        { call: "import(", line: 3 },
        { call: "require(", line: 6 },
      ]);
      expect(specifiers(mdx, text)).toEqual(["@iracedeck/iracing-sdk"]);
    });

    it("keeps an escaped brace and a code span holding braces as Markdown", () => {
      const text = ['\\{ `{{= import("./span.js") }}` \\}', '`{` then `import("./two.js")` then `}`', ""].join("\n");

      expect(markupLoads(mdx, text)).toEqual([]);
    });

    it("finds a load with a comment between its name and its parenthesis, and none in prose", () => {
      const text = [
        "---",
        "---",
        '<p>{import /* lazy */ ("./client.js")}</p>',
        "<p>{require // x",
        '  ("./b.js")}</p>',
        "<p>{import/**/(`./c.js`)}</p>",
        "<p>Import the profile (it is free), or require it (once).</p>",
        "",
      ].join("\n");

      expect(markupLoads(astro, text)).toEqual([
        { call: "import(", line: 3 },
        { call: "require(", line: 4 },
        { call: "import(", line: 6 },
      ]);
      expect(markupLoads(mdx, 'Prose {import /* lazy */ ("./client.js")}.\n')).toEqual([{ call: "import(", line: 1 }]);
    });

    it("finds nothing in a code source, whose loads are module code", () => {
      expect(markupLoads("packages/x/src/a.ts", 'const a = import("./a.js");')).toEqual([]);
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
      const [source] = moduleSources(file, text);

      expect(source).toHaveLength(text.length);
      expect(specifiers(file, text)).toEqual([
        "../../../components/Gallery.astro",
        "../../../../../iracing-actions/src/rows.js",
      ]);
      expect(source).toContain('export const meta = { from: "../../../data/meta.json" };');
    });

    it("reads nothing from the frontmatter, prose, fenced code or JSX", () => {
      const [source] = moduleSources(file, text);

      for (const mention of ["hero.js", "deck-iracing", "iracing-sdk", "Prose", "<Gallery"]) {
        expect(source, mention).not.toContain(mention);
      }
    });

    // CommonMark's closing rule: a fence line that is indented four spaces, carries
    // an info string, is shorter or uses the other character is the block's
    // content, so the block ends where a reader sees it end and the import after it is read.
    it.each([
      ["an indented fence and one with an info string", ["```md", "    ```bash", "```ts", "    ```", "```"]],
      ["an indented fence alone", ["```md", "    ```bash", "echo hi", "```"]],
      ["a fence with an info string alone", ["```md", "```ts", "const x = 1;", "```"]],
      ["a longer opening fence", ["````md", "```", "```ts", "```", "````"]],
      ["a closing fence followed by text", ["```md", "``` not a close", "```"]],
      ["tilde fences", ["~~~md", "    ~~~", "```", "~~~ not a close", "~~~"]],
      ["a tilde fence inside a backtick block", ["```md", "~~~", "```"]],
    ])("closes a code block as CommonMark does: %s", (_name, block) => {
      const lines = [
        ...block.slice(0, -1),
        'import { y } from "@iracedeck/iracing-sdk";',
        block.at(-1),
        "",
        'import X from "@iracedeck/iracing-actions";',
        "",
      ];

      expect(specifiers("packages/website/src/content/docs/fences.mdx", lines.join("\n"))).toEqual([
        "@iracedeck/iracing-actions",
      ]);
    });

    // MDX's ESM parser reads on past a blank line while the declaration is still open.
    it("keeps an ESM block open across a blank line until its declaration is complete", () => {
      const page = [
        'import Gallery from "./Gallery.astro";',
        "import {",
        "  A,",
        "",
        "  B,",
        '} from "../../../../../iracing-actions/src/rows.js";',
        "export const meta = {",
        "",
        '  load: () => import("./meta.js"),',
        "};",
        "",
        'Prose after the block, naming "../not-read.js".',
        "",
      ].join("\n");

      expect(specifiers("packages/website/src/content/docs/blank.mdx", page)).toEqual([
        "./Gallery.astro",
        "../../../../../iracing-actions/src/rows.js",
        "./meta.js",
      ]);
      expect(joined("packages/website/src/content/docs/blank.mdx", page)).not.toContain("Prose");
    });

    it("ends a block at a blank line when it is complete, or malformed before its end", () => {
      const page = [
        'import A from "./a.js";',
        "",
        "import the profile into Stream Deck.",
        "",
        "```ts",
        'import { y } from "@iracedeck/iracing-sdk";',
        "```",
        "",
      ].join("\n");
      const [source] = moduleSources("packages/website/src/content/docs/ends.mdx", page);

      expect(source).toContain('import A from "./a.js";');
      expect(source).not.toContain("iracing-sdk");
    });

    it("reads no import inside a block a shorter or other-character fence does not close", () => {
      const text = ["````md", "```", 'import { y } from "@iracedeck/iracing-sdk";', "~~~~", "", "x", ""].join("\n");

      expect(specifiers("packages/website/src/content/docs/fences.mdx", text)).toEqual([]);
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
