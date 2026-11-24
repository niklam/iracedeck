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
  unreadStructure,
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
      expect(unreadStructure(file, text)).toEqual([]);
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
      expect(unreadStructure(file, text)).toEqual([]);
    });

    // A template expression is read whole, JSX and all, so a comment after it is one (#1662).
    it("reads a template expression whole, JSX and all, so a comment after it is one", () => {
      for (const expression of [
        '{a < b && "x"}',
        "{a<b}",
        "{x && <b>bold</b>}",
        "{a / b}",
        "{/}/.test(s)}",
        '{x && <p class="a">Don\'t {x}</p>}',
        "{x && <p class=plain><br><img src=a.png>text<!-- } --></p>}",
        "{items.map((i) => { return <li key={i}>{i}</li>; })}",
        "{<>a {b}</>}",
        '{x && <Card load={() => "}"} />}',
      ]) {
        const text = `${expression}\n<!-- <script>import "./commented.js";</script> -->\n<script>import "./after.js";</script>\n`;

        expect(specifiers(file, text), expression).toEqual(["./after.js"]);
        expect(unreadStructure(file, text), expression).toEqual([]);
      }
    });

    // What it cannot read it reports, never reads on as something else: a comment after it may hide a script.
    it("reports a template expression it cannot read, naming its line and what stopped it", () => {
      for (const [expression, stop] of [
        ['{"open', "a string that never closes, on line 2"],
        ["{x && <p>a</div>}", "an end tag that closes no open <p>, on line 2"],
        ["{x && <p>a } b</p>}", "a } in element text, on line 2"],
        ["{x && <b>open}", "a } in element text, on line 2"],
        ["{`never closed}", "a template literal that never closes, on line 2"],
        ["{a /* never closed }", "a comment that never closes, on line 2"],
      ]) {
        const text = `<p>x</p>\n${expression}\n<p>y</p>\n`;

        expect(unreadStructure(file, text), expression).toEqual([
          `a template expression opened on line 2 that this check cannot read (${stop}), so what follows it is ` +
            "not read either: write it so its end can be found",
        ]);
      }
    });

    // A <script> among an expression's JSX is one Astro renders; a "<script>" in its string or comment is not.
    it("reads a <script> among a template expression's JSX, and none in its strings or comments", () => {
      const text = [
        "---",
        "---",
        '{show && <div><script>import "./in-jsx.js";</script></div>}',
        "{\"<script>import './in-string.js';</script>\"} {/* <script>import './in-comment.js';</script> */}",
        '<script>import "./after.js";</script>',
        "",
      ].join("\n");

      expect(specifiers(file, text)).toEqual(["./in-jsx.js", "./after.js"]);
      expect(unreadStructure(file, text)).toEqual([]);
    });

    // A quoted attribute value is text: a "{" or "<!--" in one opens nothing.
    it("reads a start tag whole, so a brace or comment opener in a quoted value opens nothing", () => {
      const text = [
        "<p title=\"{\" data-x='<!--'>x</p>",
        '<script>import "./after.js";</script>',
        '<a href={`/x/${"}"}`} title="}">y</a><script src="./src.js"></script>',
        "",
      ].join("\n");

      expect(specifiers(file, text)).toEqual(["./after.js", "./src.js"]);
      expect(unreadStructure(file, text)).toEqual([]);
    });

    it("reports a script whose end tag never comes, and a self-closing one, and still reads them", () => {
      expect(specifiers(file, '<p>x</p>\n<script>\nimport "./open.js";\n')).toEqual(["./open.js"]);
      expect(unreadStructure(file, '<p>x</p>\n<script>\nimport "./open.js";\n')).toEqual([
        "a <script> element opened on line 2 that never closes, which hides the rest of the file: close it with " +
          "</script> so what follows can be read",
      ]);
      expect(unreadStructure(file, '<p>x</p>\n<script src="./x.js" />\n<script>import "./y.js";</script>\n')).toEqual([
        "a self-closing <script /> on line 2, whose end Astro and HTML may read differently: write it as " +
          "<script …></script>",
      ]);
    });

    it("names the line of a markup comment that never closes, and none for a closed one or a code file", () => {
      const open = '---\nconst a = 1;\n---\n<p>x</p>\n<!-- never closed <script>import "./hidden.js";</script>\n';

      expect(unreadStructure(file, open)).toEqual([
        "an HTML comment opened on line 5 that never closes, which hides the rest of the file: close it with --> " +
          "so what follows can be read",
      ]);
      expect(specifiers(file, open)).toEqual([]);
      expect(unreadStructure(file, "<!-- closed --><p>x</p>")).toEqual([]);
      expect(unreadStructure(file, '<script>const s = "<!--";</script>')).toEqual([]);
      expect(unreadStructure("packages/x/src/a.ts", "const s = '<!--';")).toEqual([]);
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

    // An expression read whole ends where MDX ends it: the code span and fence after it are Markdown again.
    it("reads the code spans and fences after an .mdx expression it reads, and ESM there", () => {
      const text = [
        "{a < b && <p>Don't</p>}",
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

      expect(markupLoads(mdx, text)).toEqual([]);
      expect(specifiers(mdx, text)).toEqual(["@iracedeck/iracing-sdk"]);
      expect(unreadStructure(mdx, text)).toEqual([]);
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
      // MDX fails to compile a block that does not parse, so it is reported, never read as code that runs.
      expect(unreadStructure("packages/website/src/content/docs/ends.mdx", page)).toEqual([
        "an import or export block on line 3 that does not parse as module code: fix it so it can be read",
      ]);
    });

    it("reads no import inside a block a shorter or other-character fence does not close, and reports it", () => {
      const text = ["````md", "```", 'import { y } from "@iracedeck/iracing-sdk";', "~~~~", "", "x", ""].join("\n");

      expect(specifiers("packages/website/src/content/docs/fences.mdx", text)).toEqual([]);
      expect(unreadStructure("packages/website/src/content/docs/fences.mdx", text)).toEqual([
        "a code fence opened on line 1 that never closes, which hides the rest of the page: close it so what " +
          "follows can be read",
      ]);
    });

    describe("its template expressions and JSX, read whole (#1662)", () => {
      const page = "packages/website/src/content/docs/planted.mdx";
      /** downloads.mdx line 19's shape: a flow expression holding JSX with an attribute and a nested expression. */
      const badge = '{version && <p class="version-badge">Latest release: <strong>{version}</strong></p>}';
      /** A fenced example after `head`, whose import line opens `opener`, then a real import. */
      const fencedThenReal = (head, opener) =>
        [
          head,
          "",
          "```md",
          `import { ECOSYSTEMS } from "../../data/brands"; ${opener}`,
          "```",
          "",
          'import X from "@iracedeck/iracing-actions";',
          "",
        ].join("\n");

      // qa's reproducers: the fence after an expression with JSX is a fence, so its comment, string or
      // template opener hides nothing, and the real import after it is read.
      it.each([
        ["a comment opener", "/*"],
        ["a string opener", '+ "'],
        ["a single-quote string opener", "+ '"],
        ["a template opener", "+ `"],
      ])("reads the import after a fenced example holding %s, after an expression with JSX", (_name, opener) => {
        const text = fencedThenReal(badge, opener);

        expect(specifiers(page, text)).toEqual(["@iracedeck/iracing-actions"]);
        expect(joined(page, text)).not.toContain("ECOSYSTEMS");
        expect(unreadStructure(page, text)).toEqual([]);
      });

      it("reads no import inside a fence after an expression with JSX", () => {
        const text = [badge, "", "```md", 'import { ECOSYSTEMS } from "../../data/brands";', "```", ""].join("\n");

        expect(specifiers(page, text)).toEqual([]);
        expect(markupLoads(page, text)).toEqual([]);
        expect(unreadStructure(page, text)).toEqual([]);
      });

      it.each([
        ["a comparison", "{a < b}"],
        ["a comparison with no space", "{a<b}"],
        ["an element alone", "{<b>x</b>}"],
        ["an apostrophe and an expression in element text", `{v && <p class="x">Don't {v}</p>}`],
        ["a quote in element text", '{v && <p>say "hi</p>}'],
        ["a fragment", "{<>a {b} it's</>}"],
        ["a self-closing element with an expression attribute", "{<Foo bar={1} />}"],
        ["an element as an attribute value", "{<Foo icon=<b>x</b> />}"],
        ["a regular expression and a division", "{/}/.test(s) && a / b}"],
        ["an arrow function's block", "{items.map((i) => { return <li key={i}>{i}</li>; })}"],
        ["a template literal holding a brace", "{`}${'{'}`}"],
        ["a comment holding a brace", "{/* } */}"],
        ["a JSX tag in prose with a brace in a quoted value", 'Some <A t="{" /> text.'],
      ])("ends %s where MDX does, so the fenced example after it hides nothing", (_name, head) => {
        const text = fencedThenReal(head, "/*");

        expect(specifiers(page, text), head).toEqual(["@iracedeck/iracing-actions"]);
        expect(unreadStructure(page, text), head).toEqual([]);
      });

      // An import line inside a multi-line expression is JavaScript's, never ESM.
      it("reads no ESM inside an expression that spans lines", () => {
        const text = [
          "{`",
          'import "./in-template.js"; /*',
          "`}",
          "",
          'import X from "@iracedeck/iracing-actions";',
          "",
        ].join("\n");

        expect(specifiers(page, text)).toEqual(["@iracedeck/iracing-actions"]);
        expect(unreadStructure(page, text)).toEqual([]);
      });

      it.each([
        [
          "an end tag that closes another element",
          "{v && <p>x</div>}",
          "an end tag that closes no open <p>, on line 1",
        ],
        ["an element never closed", "{v && <p>x}", "a } in element text, on line 1"],
        ["a string never closed", '{"open', "a string that never closes, on line 1"],
        ["a template literal never closed", "{`open}", "a template literal that never closes, on line 1"],
        ["a brace never closed", "{a", "an expression that never closes, on line 1"],
        ["a < that is no element", "{a && < b}", "a < that opens neither a comparison nor an element, on line 1"],
      ])("reports an expression it cannot read: %s", (_name, head, stop) => {
        const text = `${head}\n\nProse.\n`;

        expect(unreadStructure(page, text), head).toEqual([
          `a template expression opened on line 1 that this check cannot read (${stop}), so what follows it is ` +
            "not read either: write it so its end can be found",
        ]);
      });

      it("reports a JSX tag in prose it cannot read", () => {
        expect(unreadStructure(page, 'Some <A t="open /> text.\n')).toEqual([
          "a JSX tag opened on line 1 that this check cannot read (an attribute value in a <A> tag that never " +
            "closes, on line 1), so what follows it is not read either: write it so its end can be found",
        ]);
      });

      // MDX ends a code span at the matching run anywhere in its paragraph, so a `{` in one may be no expression.
      it("reports a code span that may run onto a later line, and reads one-line spans and lone backticks", () => {
        const text = ["Text `a", '{` more {"}"} and', "", 'import X from "@iracedeck/iracing-actions";', ""].join("\n");

        expect(unreadStructure(page, text)).toContain(
          "a code span opened on line 1 that may run onto a later line, which this check does not read: keep each " +
            "code span on one line",
        );
        expect(unreadStructure(page, "One ` lone backtick.\n\nAnother ` in the next paragraph.\n")).toEqual([]);
        expect(unreadStructure(page, "A `span` and ``a ` span``.\n")).toEqual([]);
      });
    });

    describe("what it cannot tell the block structure of (#1662)", () => {
      const page = "packages/website/src/content/docs/planted.mdx";

      // MDX reads ESM only where a block starts: straight after a line of text it is that paragraph's text,
      // and reading it as code would let its comment opener hide the real import after it.
      it("reports an import straight after a line of text, and still reads the real import after it", () => {
        const text = [
          "Some paragraph",
          'import "./y.js"; /*',
          "",
          'import X from "@iracedeck/iracing-actions";',
          "",
        ].join("\n");

        expect(unreadStructure(page, text)).toEqual([
          "an import or export on line 2 straight after a line of text, which MDX may read as that text rather " +
            "than as module code: put a blank line before it",
        ]);
        // It ends at the blank line, open or not, so the real import is read as a block of its own.
        expect(specifiers(page, text)).toEqual(["./y.js", "@iracedeck/iracing-actions"]);
      });

      it("reads an import right after the frontmatter, a closing fence or another import as ESM", () => {
        const text = [
          "---",
          "title: x",
          "---",
          'import A from "./a.js";',
          'import B from "./b.js";',
          "",
          "```md",
          "x",
          "```",
          'import C from "./c.js";',
          "",
        ].join("\n");

        expect(specifiers(page, text)).toEqual(["./a.js", "./b.js", "./c.js"]);
        expect(unreadStructure(page, text)).toEqual([]);
      });

      // A list item's fence ends where the item does, at a line indented less than its content.
      it("reports an indented fence whose content is indented less than it", () => {
        const text = ["- item", "  ```js", "  code", 'import X from "@iracedeck/iracing-actions";', "  ```", ""].join(
          "\n",
        );

        expect(unreadStructure(page, text)).toEqual([
          "a code fence opened on line 2, indented, whose line 4 is indented less, so a list or other block it " +
            "sits in may end it there: indent its content as far as its fence",
        ]);
        expect(unreadStructure(page, ["- item", "  ```js", "  code", "  ```", ""].join("\n"))).toEqual([]);
      });

      it("reports an ESM block that never completes", () => {
        const text = ['import "./a.js";', "", "export const s = `", "", "text", ""].join("\n");

        expect(unreadStructure(page, text)).toEqual([
          "an import or export block opened on line 3 that never completes, which hides the rest of the page: " +
            "complete it so what follows can be read",
        ]);
      });

      // A block that does not parse is reported and read apart, so its comment opener hides no block after it.
      it("reads a block that does not parse apart from the rest, so it hides nothing after it", () => {
        const text = ['import x y "./a.js"; /*', "", 'import X from "@iracedeck/iracing-actions";', ""].join("\n");

        expect(specifiers(page, text)).toContain("@iracedeck/iracing-actions");
        expect(moduleSources(page, text)).toHaveLength(2);
        expect(unreadStructure(page, text)).toEqual([
          "an import or export block on line 1 that does not parse as module code: fix it so it can be read",
        ]);
      });

      // MDX compiles every block into one module: a binding one block makes is used in the next.
      it("reads every ESM block as one module, so a binding carries from block to block", () => {
        const text = [
          'import { createRequire as cr } from "node:module";',
          "",
          "export const req = cr(import.meta.url);",
          "",
          'export const y = req("@iracedeck/iracing-actions");',
          "",
        ].join("\n");
        const sources = moduleSources(page, text);

        expect(sources).toHaveLength(1);
        expect(sources[0]).toContain("cr(import.meta.url)");
        expect(sources[0]).toContain('req("@iracedeck/iracing-actions")');
        expect(sources[0]).toHaveLength(text.length);
      });
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
