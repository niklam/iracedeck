/**
 * Reading what a workspace package's sources import and which of them are
 * tests, shared by the guards that hold the package boundaries (#1375):
 * `scripts/plugin-shell-dependencies.test.mjs`,
 * `scripts/cross-package-reach.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs`.
 *
 * Imports are read with TypeScript's own scanner (`ts.preProcessFile`), so a
 * comment can neither add nor hide one. An `.astro` component's or `.mdx`
 * page's imports are read from its module code alone (`moduleSource`), so a
 * mention in markup or prose is none either, while an `import(` or `require(`
 * a template expression could evaluate is reported apart (`markupLoads`), for
 * a guard to refuse as a load it cannot follow (#1662).
 */
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import ts from "typescript";

/** A JavaScript or TypeScript source, by extension. */
export const CODE = /\.[cm]?[jt]sx?$/;

/**
 * A component that holds module code among markup, by extension: an Astro
 * component (`.astro`) or an MDX page (`.mdx`). Its imports are read through
 * {@link moduleSource}, never from the raw text (#1662).
 */
export const COMPONENT = /\.(astro|mdx)$/;

/** True when `file` names a module: a {@link CODE} source or a {@link COMPONENT}. */
export function isModuleSource(file) {
  return CODE.test(file) || COMPONENT.test(file);
}

/**
 * A test, or support that only tests load: `*.test.*`, `*.test-support.*`,
 * `*.test-util.*`, `*.fixture-cases.*`, and anything under a `test-support/`
 * folder. Takes a `/`-separated path.
 */
export const TEST = /\.test\.[cm]?[jt]sx?$|\.test-support\.|\.test-util\.|\.fixture-cases\.|(^|\/)test-support\//;

/** True when `file` (a `/`-separated path) is a test or test-only support. */
export function isTestSource(file) {
  return TEST.test(file);
}

/**
 * Tracked sources under `packages/` that are not ours to hold to a rule, each
 * with the reason. They are left out of {@link trackedPackageSources}.
 */
export const VENDORED_SOURCES = {
  "packages/pi-components/browser/sdpi-components.js":
    "the vendored, minified sdpi-components bundle (`sdpi-components.md`), copied in as published",
};

/** A path segment that holds build output or a plugin bundle rather than source. */
const NOT_SOURCE_SEGMENT = /^(dist|node_modules)$|\.sdPlugin$|\.ulanziPlugin$/;

/**
 * Every git-tracked JavaScript or TypeScript source under `packages/`,
 * repo-relative with `/` separators, sorted: no `dist/`, `node_modules/` or
 * plugin bundle folder (`*.sdPlugin/`, `*.ulanziPlugin/`), and none of
 * {@link VENDORED_SOURCES}. With `components`, the `.astro` and `.mdx` files
 * too ({@link COMPONENT}), whose imports a caller then reads through
 * {@link moduleSource} (#1662).
 *
 * @param {string} root The repository root.
 * @param {{ components?: boolean }} [options]
 * @returns {string[]}
 */
export function trackedPackageSources(root, { components = false } = {}) {
  return execFileSync("git", ["ls-files", "packages"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter((file) => CODE.test(file) || (components && COMPONENT.test(file)))
    .filter((file) => !file.split("/").some((segment) => NOT_SOURCE_SEGMENT.test(segment)))
    .filter((file) => !Object.hasOwn(VENDORED_SOURCES, file))
    .sort();
}

/** `text` with every character inside `ranges` turned into a space, line breaks kept. */
function blankOut(text, ranges) {
  const out = text.split("");

  for (const [start, end] of ranges) {
    for (let at = start; at < end; at++) if (out[at] !== "\r" && out[at] !== "\n") out[at] = " ";
  }

  return out.join("");
}

/**
 * `text` with every character outside `ranges` turned into a space, line breaks
 * kept, so offsets and line numbers in what is left are the file's own. The
 * first blanked character after a kept range becomes `;`, so two ranges that
 * meet on one line read as two statements. Each overlay then writes its text
 * over blanked characters at its offset: a statement the file makes in another
 * syntax, such as an `.astro` component's `<script src>`.
 *
 * @param {string} text
 * @param {[number, number][]} ranges sorted, non-overlapping `[start, end)` pairs
 * @param {[number, string][]} [overlays] `[offset, text]` pairs, each over blanked characters only
 */
function keepOnly(text, ranges, overlays = []) {
  const out = text.replace(/[^\r\n]/g, " ").split("");

  ranges.forEach(([start, end], i) => {
    for (let at = start; at < end; at++) out[at] = text[at];
    const nextStart = ranges[i + 1]?.[0] ?? out.length;

    for (let at = end; at < nextStart; at++) {
      if (out[at] === " ") {
        out[at] = ";";
        break;
      }
    }
  });
  for (const [offset, written] of overlays) {
    for (let i = 0; i < written.length; i++) out[offset + i] = written[i];
  }

  return out.join("");
}

/** A line that is exactly a `---` fence, at the start of a line (with the `m` flag). */
const FENCE = /^---[ \t]*\r?$/m;

/**
 * The leading `---` fence pair of a file, or undefined without one: where the
 * content between the fences starts and ends, and where the closing fence's
 * line ends.
 */
function leadingFence(text) {
  const open = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n/.exec(text);

  if (!open) return undefined;
  const contentStart = open[0].length;
  const close = FENCE.exec(text.slice(contentStart));

  if (!close) return undefined;

  return { contentStart, contentEnd: contentStart + close.index, end: contentStart + close.index + close[0].length };
}

/** Every match of the global regex `pattern` in `text`, as `[start, end)` ranges. */
function rangesOf(pattern, text) {
  return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

/**
 * The value of the attribute `name` in an HTML start tag's attribute text, and
 * where it sits there: `at` is the offset of its opening quote, or of its first
 * character when unquoted. Undefined when the tag has no such attribute.
 *
 * @returns {{ value: string, at: number, quote: string } | undefined}
 */
function attributeOf(attributes, name) {
  const match = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(attributes);

  if (!match) return undefined;
  const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : "";
  const value = match[2] ?? match[3] ?? match[4];

  return { value, quote, at: match.index + match[0].length - value.length - quote.length * 2 };
}

/** A `<script>` element: its attribute text and its body. */
const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;

/** A `<style>` element: its attribute text and its body. */
const STYLE = /<style\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/style\s*>/gi;

/** An HTML comment, an unclosed one running to the end of the text. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * A `<script src>` the browser loads as written rather than one Astro bundles:
 * an `http:` or `https:` URL, or a protocol-relative `//host/…` one.
 */
const BROWSER_URL = /^(https?:)?\/\//i;

/**
 * The parts of an Astro component: the `ranges` that hold module code, the
 * `overlays` that spell a `<script src>` as the import it is, and the `markup`
 * ranges that hold neither — the template, whose `{…}` expressions Astro
 * evaluates.
 *
 * Module code is the frontmatter, between the leading `---` fences, and the
 * body of every `<script>` the Astro ESLint processor hands on as a virtual
 * file: each one that has a body and whose `type` is not JSON or an import map,
 * `is:inline` included (eslint-plugin-astro's `preprocess`). A `<script>` whose
 * `src` names a module — a relative path, a package, anything but an `http(s)`
 * or protocol-relative URL, which is the browser's to fetch — loads it as Astro
 * bundles it, so it reads as `import "<src>";`, written over the start tag with
 * its quote at the attribute's own (an unquoted value's two characters before
 * it), whatever the element's body. A `<script>` inside an HTML comment is
 * markup that loads nothing.
 */
function astroParts(text) {
  const ranges = [];
  const overlays = [];
  const fence = leadingFence(text);
  const markupStart = fence?.end ?? 0;

  if (fence) ranges.push([fence.contentStart, fence.contentEnd]);
  const comments = rangesOf(HTML_COMMENT, text.slice(markupStart)).map(([start, end]) => [
    start + markupStart,
    end + markupStart,
  ]);
  // The markup with its HTML comments blanked to the same length, so a commented-out element is not found.
  const markup = blankOut(text, [[0, markupStart], ...comments]);
  /** The bodies of the <script> and <style> elements: raw text to Astro, never a template. */
  const bodies = [];

  for (const match of markup.matchAll(SCRIPT)) {
    const attributesAt = match.index + "<script".length;
    const bodyStart = attributesAt + match[1].length + 1;
    const type = attributeOf(match[1], "type")?.value ?? "";
    const src = attributeOf(match[1], "src");

    bodies.push([bodyStart, bodyStart + match[2].length]);
    if (/json$|importmap/i.test(type)) continue;
    if (src !== undefined && !BROWSER_URL.test(src.value)) {
      const quote = src.quote || '"';
      const quoteAt = attributesAt + src.at - (src.quote ? 0 : 2);

      overlays.push([quoteAt - "import ".length, `import ${quote}${src.value}${quote};`]);
    }
    if (match[2].trim() !== "") ranges.push([bodyStart, bodyStart + match[2].length]);
  }
  for (const match of markup.matchAll(STYLE)) {
    const bodyStart = match.index + "<style".length + match[1].length + 1;

    bodies.push([bodyStart, bodyStart + match[2].length]);
  }

  return { ranges, overlays, blanks: [[0, markupStart], ...comments, ...bodies] };
}

/**
 * A fenced code block's opening line, as CommonMark reads one: up to three
 * spaces, then three or more backticks followed by no backtick (the info
 * string may not hold one), or three or more tildes followed by anything.
 */
const CODE_FENCE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;

/**
 * True when `line` closes the code block `fence` opened, as CommonMark reads a
 * closing fence: up to three spaces, then a run of the fence's own character at
 * least as long as the opening one, then only spaces or tabs. An indented
 * fence, one with an info string, or a shorter one is the block's content, so a
 * ```` ```md ```` example that shows a ```` ```bash ```` fence stays one block.
 */
function closesFence(line, fence) {
  const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);

  return close !== null && close[1][0] === fence[0] && close[1].length >= fence.length;
}

/** A line that opens an MDX ESM block: `import` or `export` at the left margin, then a space, `{` or `*`. */
const ESM_LINE = /^(import|export)[\s{*]/;

/** A Markdown code span on one line: a run of backticks, then anything up to a run as long. */
const CODE_SPAN = /(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)/g;

/**
 * The parts of an MDX page: the `ranges` that hold its ESM, and the `blanks`
 * that are neither ESM nor markup — the YAML frontmatter, fenced code and
 * one-line code spans — so what is left is the prose and JSX, whose `{…}`
 * expressions MDX evaluates.
 *
 * The ESM is each run of lines from one that starts `import` or `export` at the
 * left margin (`ESM_LINE`) up to the next blank line, outside fenced code. MDX
 * reads ESM only where a block starts; this reads it on any line, so a block it
 * might miss is read rather than lost, and prose that begins a line with
 * `import ` is read as code, where it names nothing unless it is written as an
 * import.
 */
function mdxParts(text) {
  const ranges = [];
  const frontmatterEnd = leadingFence(text)?.end ?? 0;
  const blanks = [[0, frontmatterEnd]];
  let at = frontmatterEnd;
  /** The fence that opened the code block `at` is in, or null outside one. */
  let codeFence = null;
  /** Where that code block started. */
  let codeStart = -1;
  /** Where the ESM block `at` is in started, or -1 outside one. */
  let esmStart = -1;

  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, end).replace(/\r?\n$/, "");
    const blank = line.trim() === "";

    if (codeFence !== null) {
      if (closesFence(line, codeFence)) {
        codeFence = null;
        blanks.push([codeStart, end]);
      }
    } else if (esmStart !== -1) {
      if (blank) {
        ranges.push([esmStart, at]);
        esmStart = -1;
      }
    } else if (CODE_FENCE.test(line)) {
      const open = CODE_FENCE.exec(line);

      codeFence = open[1] ?? open[2];
      codeStart = at;
    } else if (ESM_LINE.test(line)) {
      esmStart = at;
    } else {
      blanks.push(...rangesOf(CODE_SPAN, line).map(([start, stop]) => [at + start, at + stop]));
    }
    at = end;
  }
  if (esmStart !== -1) ranges.push([esmStart, text.length]);
  // An unclosed code block runs to the end of the page.
  if (codeFence !== null) blanks.push([codeStart, text.length]);

  return { ranges, overlays: [], blanks: [...blanks, ...ranges] };
}

/** The parts of a component, or undefined for a {@link CODE} source, which is module code throughout. */
function componentParts(file, text) {
  if (file.endsWith(".astro")) return astroParts(text);
  if (file.endsWith(".mdx")) return mdxParts(text);

  return undefined;
}

/**
 * The module code of `file`, whose text is `text`, laid out at the offsets it
 * has in the file: the whole text for a {@link CODE} source, the frontmatter
 * and `<script>` bodies of an `.astro` component, with each `<script src>` that
 * names a module read as its import, and the ESM blocks of an `.mdx` page,
 * everything else blanked (#1662). So a reader of imports or path strings sees
 * what loads, and a mention in markup or prose is nothing. A load a template
 * expression makes is not module code: {@link markupLoads} finds it.
 *
 * @param {string} file
 * @param {string} text
 * @returns {string}
 */
export function moduleSource(file, text) {
  const parts = componentParts(file, text);

  return parts === undefined ? text : keepOnly(text, parts.ranges, parts.overlays);
}

/** An `import(` or `require(` call, not a method of that name. */
const LOAD_CALL = /(?<![\w$.])(import|require)\s*\(/g;

/**
 * Every `import(` or `require(` in the markup of an `.astro` component or an
 * `.mdx` page (#1662): outside its module code, HTML comments, `<script>` and
 * `<style>` bodies, fenced code and code spans — where a template expression
 * `{…}` sits, which Astro and MDX evaluate, so a module can be loaded from one.
 * Template expressions are not parsed, so each call is a load nothing can
 * follow, wherever in the markup it is: the fix is to make it in the module
 * code. Empty for a {@link CODE} source.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{ call: string, line: number }[]} `call` is `import(` or `require(`; `line` is 1-based
 */
export function markupLoads(file, text) {
  const parts = componentParts(file, text);

  if (parts === undefined) return [];
  const markup = blankOut(text, parts.blanks);

  return [...markup.matchAll(LOAD_CALL)].map((match) => ({
    call: `${match[1]}(`,
    line: text.slice(0, match.index).split("\n").length,
  }));
}

/**
 * Every module `source` names: static, type-only, side-effect, re-export,
 * dynamic, `require` and `import("…")` types (`kind: "import"`, with `pos`
 * the offset of the specifier's opening quote), and triple-slash `path`
 * references (`kind: "reference"`, which sit in a comment and carry no `pos`).
 *
 * @param {string} source
 * @returns {({ specifier: string, kind: "import", pos: number } | { specifier: string, kind: "reference" })[]}
 */
export function moduleReferences(source) {
  const { importedFiles, referencedFiles } = ts.preProcessFile(source, true, true);

  return [
    ...importedFiles.map(({ fileName, pos }) => ({ specifier: fileName, kind: "import", pos })),
    ...referencedFiles.map(({ fileName }) => ({ specifier: fileName, kind: "reference" })),
  ];
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`), or null for a relative path or a Node builtin. */
export function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  return builtinModules.includes(name) ? null : name;
}

/** The packages `source` imports: static, type-only, side-effect, re-export, dynamic and `require`. */
export function importedPackages(source) {
  return new Set(
    moduleReferences(source)
      .filter(({ kind }) => kind === "import")
      .map(({ specifier }) => packageOf(specifier))
      .filter((name) => name !== null),
  );
}
