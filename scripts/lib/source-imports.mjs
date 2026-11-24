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
 * mention in markup or prose is none either (#1662).
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

/**
 * `text` with every character outside `ranges` turned into a space, line breaks
 * kept, so offsets and line numbers in what is left are the file's own. The
 * first blanked character after a kept range becomes `;`, so two ranges that
 * meet on one line read as two statements.
 *
 * @param {string} text
 * @param {[number, number][]} ranges sorted, non-overlapping `[start, end)` pairs
 */
function keepOnly(text, ranges) {
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
 * The module code of an Astro component: its frontmatter, between the leading
 * `---` fences, and the body of every `<script>` the Astro ESLint processor
 * hands on as a virtual file — each one that has a body and whose `type` is not
 * JSON or an import map, `is:inline` included (eslint-plugin-astro's
 * `preprocess`). A `<script>` inside an HTML comment is markup. The template's
 * `{…}` expressions are not read: lint refuses no import there, and a module
 * cannot be imported from one.
 */
function astroModuleSource(text) {
  const ranges = [];
  const fence = leadingFence(text);
  const markupStart = fence?.end ?? 0;

  if (fence) ranges.push([fence.contentStart, fence.contentEnd]);
  // The markup with its HTML comments blanked to the same length, so a commented-out <script> is not found.
  const markup =
    text.slice(0, markupStart).replace(/[^\r\n]/g, " ") +
    text.slice(markupStart).replace(/<!--[\s\S]*?(-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
  const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;

  for (let match; (match = SCRIPT.exec(markup)) !== null;) {
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const typeValue = type ? (type[1] ?? type[2] ?? type[3]) : "";

    if (match[2].trim() === "" || /json$|importmap/i.test(typeValue)) continue;
    const bodyStart = match.index + match[0].indexOf(">") + 1;

    ranges.push([bodyStart, bodyStart + match[2].length]);
  }

  return keepOnly(text, ranges);
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
 * The module code of an MDX page: its ESM, each run of lines from one that
 * starts `import` or `export` at the left margin (`ESM_LINE`) up to the next
 * blank line, outside fenced code. MDX reads ESM only where a block starts;
 * this reads it on any line, so a block it might miss is read rather than
 * lost, and prose that begins a line with `import ` is read as code, where it
 * names nothing unless it is written as an import. The YAML frontmatter, the
 * rest of the prose, fenced code and JSX are not module code; a `{…}`
 * expression is not read, since a module cannot be imported from one.
 */
function mdxModuleSource(text) {
  const ranges = [];
  let at = leadingFence(text)?.end ?? 0;
  /** The fence that opened the code block `at` is in, or null outside one. */
  let codeFence = null;
  /** Where the ESM block `at` is in started, or -1 outside one. */
  let esmStart = -1;

  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, end).replace(/\r?\n$/, "");
    const blank = line.trim() === "";

    if (codeFence !== null) {
      if (closesFence(line, codeFence)) codeFence = null;
    } else if (esmStart !== -1) {
      if (blank) {
        ranges.push([esmStart, at]);
        esmStart = -1;
      }
    } else if (CODE_FENCE.test(line)) {
      const open = CODE_FENCE.exec(line);

      codeFence = open[1] ?? open[2];
    } else if (ESM_LINE.test(line)) {
      esmStart = at;
    }
    at = end;
  }
  if (esmStart !== -1) ranges.push([esmStart, text.length]);

  return keepOnly(text, ranges);
}

/**
 * The module code of `file`, whose text is `text`, laid out at the offsets it
 * has in the file: the whole text for a {@link CODE} source, the frontmatter
 * and `<script>` bodies of an `.astro` component, the ESM blocks of an `.mdx`
 * page, everything else blanked (#1662). So a reader of imports or path
 * strings sees what loads, and a mention in markup or prose is nothing.
 *
 * @param {string} file
 * @param {string} text
 * @returns {string}
 */
export function moduleSource(file, text) {
  if (file.endsWith(".astro")) return astroModuleSource(text);
  if (file.endsWith(".mdx")) return mdxModuleSource(text);

  return text;
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
