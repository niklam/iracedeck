/**
 * Reading what a workspace package's sources import and which of them are
 * tests, shared by the guards that hold the package boundaries (#1375):
 * `scripts/plugin-shell-dependencies.test.mjs`,
 * `scripts/cross-package-reach.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs`.
 *
 * Imports are read with TypeScript's own scanner (`ts.preProcessFile`), so a
 * comment can neither add nor hide one. An `.astro` component's or `.mdx`
 * page's imports are read from its module code alone (`moduleSources`), so a
 * mention in markup or prose is none either, while an `import(` or `require(`
 * a template expression could evaluate is reported apart (`markupLoads`), for
 * a guard to refuse as a load it cannot follow, as is an `.astro` HTML comment
 * that never closes (`unclosedComment`), which would hide the rest of the file
 * (#1662).
 */
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import ts from "typescript";

/** A JavaScript or TypeScript source, by extension. */
export const CODE = /\.[cm]?[jt]sx?$/;

/**
 * A component that holds module code among markup, by extension: an Astro
 * component (`.astro`) or an MDX page (`.mdx`). Its imports are read through
 * {@link moduleSources}, never from the raw text (#1662).
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
 * {@link moduleSources} (#1662).
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

/**
 * Where the template expression whose `{` is at `open` ends: the offset just
 * past the `}` that closes it, read as JavaScript — a quoted string (which ends
 * at its quote or at the line's end, since JavaScript allows no line break in
 * one), a template literal and its `${…}`, a comment, a nested brace. A `<`
 * (JSX, or a comparison) or a `/` that opens no comment (a regular expression,
 * or a division) is not read, so the expression is taken to run to the end of
 * the text, as is one nothing closes (#1662). Every caller reads the text an
 * expression spans more loosely than markup — no comment, code span or fence
 * hides anything in it — so running long reads more, never less.
 */
function expressionEnd(text, open) {
  /** The open levels, innermost last: a brace depth for code, or "`" for a template literal's text. */
  const levels = [1];

  for (let at = open + 1; at < text.length; at++) {
    const c = text[at];
    const top = levels.length - 1;

    if (levels[top] === "`") {
      if (c === "\\") at++;
      else if (c === "`") levels.pop();
      else if (c === "$" && text[at + 1] === "{") {
        levels.push(1);
        at++;
      }
    } else if (c === '"' || c === "'") {
      at++;
      while (at < text.length && text[at] !== c && text[at] !== "\n") at += text[at] === "\\" ? 2 : 1;
    } else if (c === "`") {
      levels.push("`");
    } else if (c === "/" && text[at + 1] === "/") {
      at = text.indexOf("\n", at);
      if (at === -1) return text.length;
    } else if (c === "/" && text[at + 1] === "*") {
      at = text.indexOf("*/", at + 2);
      if (at === -1) return text.length;
      at++;
    } else if (c === "<" || c === "/") {
      return text.length;
    } else if (c === "{") {
      levels[top]++;
    } else if (c === "}" && --levels[top] === 0) {
      levels.pop();
      if (levels.length === 0) return at + 1;
    }
  }

  return text.length;
}

/**
 * What the markup of an Astro component can open next: an HTML comment, the
 * start tag of a `<script>` or `<style>` element (its name, then its attribute
 * text), whose body is raw text up to its end tag, or a template expression.
 */
const MARKUP_OPENER = /<!--|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|\{/gi;

/**
 * Where an HTML comment ends, searched from just after its `<!--`: an abrupt
 * `>` or `->` at once (`<!-->`, `<!--->`), else the first `-->` or `--!>`, as
 * the HTML tokenizer reads one.
 */
const COMMENT_END = /^-?>|--!?>/;

/** The end tag of a raw-text element, by name: `</script`, then whitespace, `/` or `>`, up to its `>`. */
const endTag = (name) => new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "gi");

/**
 * A `<script src>` the browser loads as written rather than one Astro bundles:
 * an `http:` or `https:` URL, or a protocol-relative `//host/…` one.
 */
const BROWSER_URL = /^(https?:)?\/\//i;

/** True when a start tag's attribute text carries the `is:inline` directive. */
const isInline = (attributes) => /(^|\s)is:inline(?=[\s=/]|$)/i.test(attributes);

/**
 * The parts of an Astro component: its `modules`, in the order they appear —
 * the frontmatter, and for each `<script>` the import its `src` makes and its
 * body — each one module apart, as Astro compiles them, so nothing one leaves
 * open (a `//` comment on its last line) can run into the next on its line;
 * the `blanks` that hold no template — the frontmatter, HTML comments and the
 * `<script>` and `<style>` bodies — so what is left is the template, whose
 * `{…}` expressions Astro evaluates; and `unclosedComment`, the offset of an
 * HTML comment that runs to the end of the file, or -1.
 *
 * The markup after the frontmatter is read in order, as the HTML tokenizer
 * reads it: a `<!--` opens a comment only where markup is read, never inside a
 * `<script>` or `<style>` body, which is raw text up to its end tag, so a
 * script's `"<!--"` string hides nothing after it, while a `<script>` inside a
 * comment is part of the comment and loads nothing. Nor inside a template
 * expression (`expressionEnd`), whose `"<!--"` is a string: an expression
 * this cannot bound runs to the end of the file, so no `<!--` after it opens a
 * comment, and what follows one is read (#1662).
 *
 * Module code is the frontmatter, between the leading `---` fences, and the
 * body of every `<script>` the Astro ESLint processor hands on as a virtual
 * file: each one that has a body and whose `type` is not JSON or an import map,
 * `is:inline` included (eslint-plugin-astro's `preprocess`). A `<script>` whose
 * `src` names a module loads it as Astro bundles it, so it reads as
 * `import "<src>";`, written over the start tag with its quote at the
 * attribute's own (an unquoted value's two characters before it), whatever the
 * element's body. Not so the `src` of an `is:inline` script, which Astro leaves
 * for the browser to fetch from the served site (`public/`), nor an `http(s)`
 * or protocol-relative URL, the browser's to fetch too. A processed script's
 * root-absolute `src` (`/x.js`) is read as the import it is, which the walk
 * refuses as an absolute path it cannot follow, since Vite may resolve it
 * against the project root or serve it from `public/`. Astro also treats a
 * script with any attribute but `src` as inline; this reads only the explicit
 * directive, so such a script's `src` is read as an import: a red the fix for
 * is `is:inline`, never a pass.
 */
function astroParts(text) {
  const modules = [];
  const fence = leadingFence(text);
  const markupStart = fence?.end ?? 0;
  /** The HTML comments, and the bodies of the <script> and <style> elements: never a template. */
  const blanks = [[0, markupStart]];
  let unclosedComment = -1;
  /** Where the template expressions read so far end, at the furthest. */
  let expressionsEnd = markupStart;

  if (fence) modules.push({ ranges: [[fence.contentStart, fence.contentEnd]], overlays: [] });
  MARKUP_OPENER.lastIndex = markupStart;
  for (let match = MARKUP_OPENER.exec(text); match !== null; match = MARKUP_OPENER.exec(text)) {
    if (match[0] === "{") {
      // Read on inside it: a <script> there is still one.
      if (match.index >= expressionsEnd) expressionsEnd = expressionEnd(text, match.index);
      continue;
    }
    if (match[1] === undefined) {
      // A "<!--" in a template expression is JavaScript's, not a comment.
      if (match.index < expressionsEnd) continue;
      const after = match.index + "<!--".length;
      const close = COMMENT_END.exec(text.slice(after));
      const end = close === null ? text.length : after + close.index + close[0].length;

      if (close === null) unclosedComment = match.index;
      blanks.push([match.index, end]);
      MARKUP_OPENER.lastIndex = end;
      continue;
    }
    const name = match[1].toLowerCase();
    const attributes = match[2];
    const bodyStart = match.index + match[0].length;
    const close = endTag(name);

    close.lastIndex = bodyStart;
    const closing = close.exec(text);
    // An element whose end tag never comes runs to the end of the file, as HTML reads it.
    const bodyEnd = closing?.index ?? text.length;

    blanks.push([bodyStart, bodyEnd]);
    MARKUP_OPENER.lastIndex = closing === null ? text.length : closing.index + closing[0].length;
    if (name !== "script") continue;
    const type = attributeOf(attributes, "type")?.value ?? "";
    const src = attributeOf(attributes, "src");
    const attributesAt = match.index + "<script".length;

    if (/json$|importmap/i.test(type)) continue;
    if (src !== undefined && !BROWSER_URL.test(src.value) && !isInline(attributes)) {
      const quote = src.quote || '"';
      const quoteAt = attributesAt + src.at - (src.quote ? 0 : 2);

      modules.push({ ranges: [], overlays: [[quoteAt - "import ".length, `import ${quote}${src.value}${quote};`]] });
    }
    if (text.slice(bodyStart, bodyEnd).trim() !== "") modules.push({ ranges: [[bodyStart, bodyEnd]], overlays: [] });
  }

  return { modules, blanks, unclosedComment };
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

/**
 * True when the ESM `block` is still open where it stops: its first syntax
 * error sits at its end, after its last non-blank character, as an unclosed
 * `import {` or object literal leaves one. That is the test MDX's ESM parser
 * makes at a blank line (an error at the end of what it has read means "read
 * on"), made here with TypeScript's parser. A block whose first error comes
 * sooner is complete but malformed, which fails MDX's own compile, so it ends
 * where it is.
 */
function incompleteEsm(block) {
  const { diagnostics } = ts.transpileModule(block, {
    fileName: "esm.tsx",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
  });
  const first = Math.min(...diagnostics.map(({ start }) => start ?? 0));

  return diagnostics.length > 0 && first >= block.trimEnd().length;
}

/** A Markdown code span on one line, from its opening run of backticks: anything up to a run as long. */
const CODE_SPAN_AT = /(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)/y;

/**
 * The parts of an MDX page: its one module, the `ranges` that hold its ESM,
 * and the `blanks` that are neither ESM nor markup — the YAML frontmatter,
 * fenced code and one-line code spans — so what is left is the prose and JSX,
 * whose `{…}` expressions MDX evaluates.
 *
 * A code span or a fence is Markdown's, so it opens only in Markdown text,
 * never inside a template expression (`expressionEnd`), where a backtick is a
 * template literal's and a load in one runs (#1662). An expression this cannot
 * bound runs to the end of the page, so after it nothing is a code span or
 * fence and every load is found; an `import` or `export` line is still read as
 * ESM there, so nothing the misreading spans can hide one.
 *
 * The ESM is each run of lines from one that starts `import` or `export` at the
 * left margin (`ESM_LINE`) up to the next blank line that ends it, outside
 * fenced code. MDX reads ESM only where a block starts; this reads it on any
 * line, so a block it might miss is read rather than lost, and prose that
 * begins a line with `import ` is read as code, where it names nothing unless
 * it is written as an import.
 *
 * A blank line ends the block only once what it holds is complete
 * (`incompleteEsm`): MDX's ESM parser carries a declaration that is still open
 * at the blank line on to the next one, so `import {`, a name list holding a
 * blank line and its `} from "x"` are one block, and its specifier is read.
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
  /** Where the template expressions read so far end, at the furthest: text before it is no Markdown. */
  let expressionsEnd = frontmatterEnd;
  /**
   * Reads Markdown text from `from` to `to`, on one line: blanks each code
   * span, steps over each template expression, and returns where the last one
   * ends when that is past `to`, else `to`.
   */
  const readMarkdown = (from, to) => {
    for (let i = from; i < to; i++) {
      if (text[i] === "\\") {
        i++;
      } else if (text[i] === "`") {
        CODE_SPAN_AT.lastIndex = i;
        const span = CODE_SPAN_AT.exec(text);

        if (span === null) {
          // A run with no run as long after it on the line is text.
          while (text[i + 1] === "`") i++;
        } else {
          blanks.push([i, i + span[0].length]);
          i += span[0].length - 1;
        }
      } else if (text[i] === "{") {
        const end = expressionEnd(text, i);

        if (end > to) return end;
        i = end - 1;
      }
    }

    return to;
  };

  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, end).replace(/\r?\n$/, "");
    const lineEnd = at + line.length;
    const blank = line.trim() === "";

    if (codeFence !== null) {
      if (closesFence(line, codeFence)) {
        codeFence = null;
        blanks.push([codeStart, end]);
      }
    } else if (esmStart !== -1) {
      if (blank && !incompleteEsm(text.slice(esmStart, at))) {
        ranges.push([esmStart, at]);
        esmStart = -1;
      }
    } else if (at < expressionsEnd) {
      // Inside a template expression: JavaScript, where no fence opens.
      if (ESM_LINE.test(line)) esmStart = at;
      else if (expressionsEnd < lineEnd) expressionsEnd = readMarkdown(expressionsEnd, lineEnd);
    } else if (CODE_FENCE.test(line)) {
      const open = CODE_FENCE.exec(line);

      codeFence = open[1] ?? open[2];
      codeStart = at;
    } else if (ESM_LINE.test(line)) {
      esmStart = at;
    } else {
      expressionsEnd = readMarkdown(at, lineEnd);
    }
    at = end;
  }
  if (esmStart !== -1) ranges.push([esmStart, text.length]);
  // An unclosed code block runs to the end of the page.
  if (codeFence !== null) blanks.push([codeStart, text.length]);

  return { modules: [{ ranges, overlays: [] }], blanks: [...blanks, ...ranges] };
}

/** The parts of a component, or undefined for a {@link CODE} source, which is module code throughout. */
function componentParts(file, text) {
  if (file.endsWith(".astro")) return astroParts(text);
  if (file.endsWith(".mdx")) return mdxParts(text);

  return undefined;
}

/**
 * The modules of `file`, whose text is `text`, each laid out at the offsets it
 * has in the file with everything else blanked (#1662): the whole text for a
 * {@link CODE} source; an `.mdx` page's ESM blocks, which MDX compiles as one
 * module; and an `.astro` component's frontmatter, each `<script>` body and
 * each `<script src>` that names a module, read as its import (an `is:inline`
 * one's is the browser's), one module apart, since Astro compiles each alone,
 * so a `//` comment ending one script cannot hide the next on its line. So a
 * reader of imports or path strings reads each, sees what loads, and a mention
 * in markup or prose is nothing. A load a template expression makes is not
 * module code: {@link markupLoads} finds it.
 *
 * @param {string} file
 * @param {string} text
 * @returns {string[]} in the order they appear in the file; none for a component with no module code
 */
export function moduleSources(file, text) {
  const parts = componentParts(file, text);

  return parts === undefined ? [text] : parts.modules.map(({ ranges, overlays }) => keepOnly(text, ranges, overlays));
}

/**
 * An `import(` or `require(` call, not a method of that name, with any
 * whitespace or comments between the name and its `(`.
 */
const LOAD_CALL = /(?<![\w$.])(import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*\(/g;

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
 * The 1-based line of an HTML comment in an `.astro` component's markup that
 * never closes, or undefined (#1662). Such a comment runs to the end of the
 * file, so everything after it reads as nothing; a guard refuses it rather than
 * pass what it hides, since a `<!--` Astro reads otherwise, such as one in a
 * template expression's string, would hide a load from the reader that Astro
 * still makes. Undefined for any other file.
 *
 * @param {string} file
 * @param {string} text
 * @returns {number | undefined}
 */
export function unclosedComment(file, text) {
  if (!file.endsWith(".astro")) return undefined;
  const at = astroParts(text).unclosedComment;

  return at === -1 ? undefined : text.slice(0, at).split("\n").length;
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
