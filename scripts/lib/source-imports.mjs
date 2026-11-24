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
 * a guard to refuse as a load it cannot follow (#1662). Where the reader of a
 * component cannot tell its structure — an expression or tag whose end it
 * cannot find, a comment, `<script>` or code fence that never closes, an
 * `import` MDX may read as text — it reports that (`unreadStructure`), for a
 * guard to refuse, rather than read on as something else: markup read as code
 * lets a comment or string opener in it hide the real code after it.
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
 * Where a reader cannot tell what the text is (#1662): `at` is the offset it
 * stopped at, `what` says what it found there. A reader that meets one reports
 * the structure it was reading as unread ({@link unreadStructure}) rather than
 * guess at it, since a guess that reads markup as code lets a comment or string
 * opener in it hide the real code after it.
 */
class Unreadable extends Error {
  constructor(at, what) {
    super(what);
    this.at = at;
    this.what = what;
  }
}

/** The HTML elements that never have an end tag. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** The elements whose body is raw text up to their end tag, in an `.astro` component. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/** The JavaScript words after which an operand comes, not an operator: `return <p />` is an element. */
const OPERAND_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const WORD = /[\w$]+/y;
const TAG_NAME = /[A-Za-z_$][\w$.:-]*/y;
const ATTRIBUTE_NAME = /[^\s"'<>/={}`]+/y;
const UNQUOTED_VALUE = /[^\s"'=<>`]+/y;
const SPACE = /\s/;
/** What may follow a `<` that opens an element: a tag name's first character, or the `>` of a fragment. */
const ELEMENT_START = /[A-Za-z_$>]/;

/** The end tag of a raw-text element, by name: `</script`, then whitespace, `/` or `>`, up to its `>`. */
const endTag = (name) => new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "gi");

/**
 * Where an HTML comment ends, searched from just after its `<!--`: an abrupt
 * `>` or `->` at once (`<!-->`, `<!--->`), else the first `-->` or `--!>`, as
 * the HTML tokenizer reads one.
 */
const COMMENT_END = /^-?>|--!?>/;

/**
 * A reader of the structures a template holds (#1662): the JavaScript of a
 * template expression, with the JSX elements in it, and an element's start
 * tag. Each method takes the offset a structure starts at and returns the one
 * just past its end, or throws {@link Unreadable} where it cannot tell what the
 * text is: it never guesses an end, since text read as the wrong thing can hide
 * what follows it.
 *
 * JavaScript is read as far as finding its end needs: strings, which end at
 * their quote (a line break in one is an error), template literals and their
 * `${…}`, comments, regular expressions, nested braces, and a `<` — a
 * comparison where an operator may come (after a value), an element where an
 * operand may (`a && <p>…</p>`, `() => <li />`). An element's start tag holds
 * quoted attribute values, in which nothing is code, and `{…}` ones; its
 * children are text (an apostrophe or quote there is just text), `{…}`
 * expressions and nested elements, up to the end tag that matches it. A `}` in
 * element text, an end tag that matches no open element, or the end of the
 * file before a structure closes is unreadable.
 *
 * With `html` (an `.astro` component) an element is read as Astro reads one: a
 * void element (`<br>`) needs no end tag, an attribute value may be unquoted or
 * a template literal, an HTML comment may sit among the children, and the body
 * of a `<script>` or `<style>` is raw text up to its end tag; each such element
 * is collected in `rawTexts`, for the caller to read as module code or blank.
 *
 * @param {string} text
 * @param {boolean} html
 */
function structureReader(text, html) {
  /** The raw-text elements read inside a structure, in order: the caller takes them. */
  const rawTexts = [];
  const fail = (at, what) => {
    throw new Unreadable(at, what);
  };
  const matchAt = (pattern, at) => {
    pattern.lastIndex = at;

    return pattern.exec(text)?.[0];
  };
  const skipSpace = (at) => {
    while (at < text.length && SPACE.test(text[at])) at++;

    return at;
  };

  /** A quoted JavaScript string from its quote at `at`. */
  function string(at) {
    for (let i = at + 1; i < text.length; i++) {
      const c = text[i];

      if (c === "\\") i += text.startsWith("\r\n", i + 1) ? 2 : 1;
      else if (c === text[at]) return i + 1;
      else if (c === "\n" || c === "\r") break;
    }

    return fail(at, "a string that never closes");
  }

  /** A template literal from its backtick at `at`, with each `${…}` in it. */
  function template(at) {
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === "`") return i + 1;
      else if (text[i] === "$" && text[i + 1] === "{") i = code(i + 2) - 1;
    }

    return fail(at, "a template literal that never closes");
  }

  /** A regular expression literal from its `/` at `at`, with its flags. */
  function regex(at) {
    let inClass = false;

    for (let i = at + 1; i < text.length; i++) {
      const c = text[i];

      if (c === "\n" || c === "\r") break;
      if (c === "\\") {
        if (text[i + 1] === "\n" || text[i + 1] === "\r") break;
        i++;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "]") {
        inClass = false;
      } else if (c === "/" && !inClass) {
        return i + 1 + (matchAt(WORD, i + 1)?.length ?? 0);
      }
    }

    return fail(at, "a regular expression that never closes");
  }

  /** JavaScript from `at` up to the `}` that closes the brace just before it: returns the offset past that `}`. */
  function code(at) {
    const open = at - 1;
    let depth = 0;
    /** True where an operand may come next, so a `<` opens an element and a `/` a regular expression. */
    let operand = true;
    /** True just after a `.`, where a word is a property name, never a keyword. */
    let member = false;

    while (at < text.length) {
      const c = text[at];
      const next = text[at + 1] ?? "";
      const afterDot = member;

      member = false;
      if (SPACE.test(c)) {
        member = afterDot;
        at++;
      } else if (c === '"' || c === "'") {
        at = string(at);
        operand = false;
      } else if (c === "`") {
        at = template(at);
        operand = false;
      } else if (c === "/" && next === "/") {
        const end = text.indexOf("\n", at);

        member = afterDot;
        at = end === -1 ? text.length : end;
      } else if (c === "/" && next === "*") {
        const end = text.indexOf("*/", at + 2);

        if (end === -1) fail(at, "a comment that never closes");
        member = afterDot;
        at = end + 2;
      } else if (c === "/") {
        at = operand ? regex(at) : at + 1;
        operand = !operand;
      } else if (c === "<" && !operand) {
        at++;
        operand = true;
      } else if (c === "<") {
        if (!ELEMENT_START.test(next)) fail(at, "a < that opens neither a comparison nor an element");
        at = element(at);
        operand = false;
      } else if (c === "{") {
        depth++;
        at++;
        operand = true;
      } else if (c === "}") {
        if (depth === 0) return at + 1;
        depth--;
        at++;
        operand = false;
      } else if (c === "(" || c === "[") {
        at++;
        operand = true;
      } else if (c === ")" || c === "]") {
        at++;
        operand = false;
      } else if (c === ".") {
        const spread = text.startsWith("...", at);

        at += spread ? 3 : 1;
        operand = spread;
        member = !spread;
      } else if (/[\w$]/.test(c)) {
        const word = matchAt(WORD, at);

        at += word.length;
        operand = !afterDot && OPERAND_KEYWORDS.has(word);
      } else {
        // An operator or other punctuation: an operand comes next.
        at++;
        operand = true;
      }
    }

    return fail(open, "an expression that never closes");
  }

  /** An attribute's value from its first character at `at`, in the start tag of `name`. */
  function attributeValue(at, name) {
    const c = text[at];

    if (c === '"' || c === "'") {
      const end = text.indexOf(c, at + 1);

      if (end === -1) fail(at, `an attribute value in a <${name}> tag that never closes`);

      return end + 1;
    }
    if (c === "{") return code(at + 1);
    if (html && c === "`") return template(at);
    if (!html && c === "<") return element(at);
    const unquoted = html ? matchAt(UNQUOTED_VALUE, at) : undefined;

    if (unquoted === undefined) fail(at, `an attribute value in a <${name}> tag that this cannot read`);

    return at + unquoted.length;
  }

  /**
   * An element's start tag from its `<` at `at`: its `name` (empty for a
   * fragment's `<>`), where it ends, whether it closes itself (`/>`), and where
   * its attribute text runs.
   *
   * @returns {{ name: string, end: number, selfClosing: boolean, attributesAt: number, attributesEnd: number }}
   */
  function startTag(at) {
    if (text[at + 1] === ">")
      return { name: "", end: at + 2, selfClosing: false, attributesAt: at + 1, attributesEnd: at + 1 };
    const name = matchAt(TAG_NAME, at + 1);

    if (name === undefined) fail(at, "a < that opens no tag");
    const attributesAt = at + 1 + name.length;
    let i = attributesAt;

    for (;;) {
      i = skipSpace(i);
      if (i >= text.length) fail(at, `a <${name}> tag that never ends`);
      if (text.startsWith("/>", i)) return { name, end: i + 2, selfClosing: true, attributesAt, attributesEnd: i };
      if (text[i] === ">") return { name, end: i + 1, selfClosing: false, attributesAt, attributesEnd: i };
      if (text[i] === "{") {
        i = code(i + 1);
        continue;
      }
      if (html && text[i] === "/") {
        i++;
        continue;
      }
      const attribute = matchAt(ATTRIBUTE_NAME, i);

      if (attribute === undefined) fail(i, `an attribute in a <${name}> tag that this cannot read`);
      i += attribute.length;
      const equals = skipSpace(i);

      if (text[equals] === "=") i = attributeValue(skipSpace(equals + 1), name);
    }
  }

  /**
   * A raw-text element's body, from its start `tag` at `at`: up to its end tag,
   * or `bodyEnd` and `end` -1 when none comes.
   */
  function rawText(at, tag) {
    const close = endTag(tag.name.toLowerCase());

    close.lastIndex = tag.end;
    const closing = close.exec(text);

    return {
      name: tag.name.toLowerCase(),
      tagAt: at,
      attributes: text.slice(tag.attributesAt, tag.attributesEnd),
      attributesAt: tag.attributesAt,
      bodyStart: tag.end,
      bodyEnd: closing?.index ?? -1,
      end: closing === null ? -1 : closing.index + closing[0].length,
    };
  }

  /** An element's children from `at`, up to and past the end tag that matches the element of `name` opened at `openedAt`. */
  function children(at, name, openedAt) {
    while (at < text.length) {
      const c = text[at];

      if (c === "{") {
        at = code(at + 1);
      } else if (c === "}") {
        fail(at, "a } in element text");
      } else if (c === "<" && text[at + 1] === "/") {
        const nameAt = skipSpace(at + 2);
        const closing = matchAt(TAG_NAME, nameAt) ?? "";
        const end = skipSpace(nameAt + closing.length);
        const matches = html ? closing.toLowerCase() === name.toLowerCase() : closing === name;

        if (text[end] !== ">" || !matches) fail(at, `an end tag that closes no open <${name}>`);

        return end + 1;
      } else if (html && text.startsWith("<!--", at)) {
        const close = COMMENT_END.exec(text.slice(at + "<!--".length));

        if (close === null) fail(at, "an HTML comment that never closes");
        at += "<!--".length + close.index + close[0].length;
      } else if (c === "<" && ELEMENT_START.test(text[at + 1] ?? "")) {
        at = element(at);
      } else if (c === "<" && !html) {
        fail(at, "a < in element text");
      } else {
        at++;
      }
    }

    return fail(openedAt, `a <${name}> element that never closes`);
  }

  /** A whole element from its `<` at `at`: its start tag, then its children and end tag unless it has none. */
  function element(at) {
    const tag = startTag(at);
    const lower = tag.name.toLowerCase();

    if (html && RAW_TEXT_ELEMENTS.has(lower)) {
      if (tag.selfClosing) fail(at, `a self-closing <${lower} />, whose end Astro and HTML may read differently`);
      const raw = rawText(at, tag);

      if (raw.end === -1) fail(at, `a <${lower}> element that never closes`);
      rawTexts.push(raw);

      return raw.end;
    }
    if (tag.selfClosing || (html && VOID_ELEMENTS.has(lower))) return tag.end;

    return children(tag.end, tag.name, at);
  }

  return { code, startTag, rawText, rawTexts };
}

/** The 1-based line of offset `at` in `text`. */
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

/** What a reader reports for a structure opened at `at` that it could not read, as `error` says. */
function unreadable(text, at, structure, error) {
  return {
    at,
    what:
      `${structure} opened on line ${lineOf(text, at)} that this check cannot read (${error.what}, on line ` +
      `${lineOf(text, error.at)}), so what follows it is not read either: write it so its end can be found`,
  };
}

/**
 * A `<script src>` the browser loads as written rather than one Astro bundles:
 * an `http:` or `https:` URL, or a protocol-relative `//host/…` one.
 */
const BROWSER_URL = /^(https?:)?\/\//i;

/** True when a start tag's attribute text carries the `is:inline` directive. */
const isInline = (attributes) => /(^|\s)is:inline(?=[\s=/]|$)/i.test(attributes);

/** What the markup of an Astro component can open next: an HTML comment, a start tag or a template expression. */
const ASTRO_OPENER = /<!--|<[A-Za-z]|\{/g;

/**
 * The parts of an Astro component: its `modules`, in the order they appear —
 * the frontmatter, and for each `<script>` the import its `src` makes and its
 * body — each one module apart, as Astro compiles them, so nothing one leaves
 * open (a `//` comment on its last line) can run into the next on its line;
 * the `blanks` that hold no template — the frontmatter, HTML comments and the
 * `<script>` and `<style>` bodies — so what is left is the template, whose
 * `{…}` expressions Astro evaluates; and `unread`, what it could not read.
 *
 * The markup after the frontmatter is read in order, as the HTML tokenizer
 * reads it: a start tag whole, its quoted attribute values and `{…}` ones
 * included, so a `{` or `<!--` in a value opens nothing; a `<!--` opens a
 * comment only where markup is read, never inside a `<script>` or `<style>`
 * body, which is raw text up to its end tag, so a script's `"<!--"` string
 * hides nothing after it, while a `<script>` inside a comment is part of the
 * comment and loads nothing. A template expression is read whole by
 * {@link structureReader}, so nothing in its strings or comments opens a
 * comment or a script, while a `<script>` element among its JSX is one. What
 * cannot be read is reported (#1662), never read on as something else: an
 * expression or tag whose end cannot be found, a comment or `<script>` or
 * `<style>` that never closes, and a self-closing `<script />`.
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
  const unread = [];
  const reader = structureReader(text, true);
  /** Takes a <script> or <style> element read: blanks its body, and reads a script's as module code. */
  const take = (raw) => {
    blanks.push([raw.bodyStart, raw.bodyEnd]);
    if (raw.name !== "script") return;
    const type = attributeOf(raw.attributes, "type")?.value ?? "";
    const src = attributeOf(raw.attributes, "src");

    if (/json$|importmap/i.test(type)) return;
    if (src !== undefined && !BROWSER_URL.test(src.value) && !isInline(raw.attributes)) {
      const quote = src.quote || '"';
      const quoteAt = raw.attributesAt + src.at - (src.quote ? 0 : 2);

      modules.push({ ranges: [], overlays: [[quoteAt - "import ".length, `import ${quote}${src.value}${quote};`]] });
    }
    if (text.slice(raw.bodyStart, raw.bodyEnd).trim() !== "") {
      modules.push({ ranges: [[raw.bodyStart, raw.bodyEnd]], overlays: [] });
    }
  };

  if (fence) modules.push({ ranges: [[fence.contentStart, fence.contentEnd]], overlays: [] });
  ASTRO_OPENER.lastIndex = markupStart;
  for (let match = ASTRO_OPENER.exec(text); match !== null; match = ASTRO_OPENER.exec(text)) {
    const at = match.index;

    if (match[0] === "<!--") {
      const after = at + "<!--".length;
      const close = COMMENT_END.exec(text.slice(after));

      if (close === null) {
        unread.push({
          at,
          what:
            `an HTML comment opened on line ${lineOf(text, at)} that never closes, which hides the rest of the file: ` +
            "close it with --> so what follows can be read",
        });
        blanks.push([at, text.length]);
        break;
      }
      blanks.push([at, after + close.index + close[0].length]);
      ASTRO_OPENER.lastIndex = after + close.index + close[0].length;
      continue;
    }
    try {
      if (match[0] === "{") {
        ASTRO_OPENER.lastIndex = reader.code(at + 1);
      } else {
        const tag = reader.startTag(at);
        const name = tag.name.toLowerCase();

        ASTRO_OPENER.lastIndex = tag.end;
        if (RAW_TEXT_ELEMENTS.has(name)) {
          const raw = reader.rawText(at, tag);

          if (tag.selfClosing) {
            unread.push({
              at,
              what:
                `a self-closing <${name} /> on line ${lineOf(text, at)}, whose end Astro and HTML may read ` +
                `differently: write it as <${name} …></${name}>`,
            });
            Object.assign(raw, { bodyEnd: tag.end, end: tag.end });
          } else if (raw.end === -1) {
            unread.push({
              at,
              what:
                `a <${name}> element opened on line ${lineOf(text, at)} that never closes, which hides the rest of ` +
                `the file: close it with </${name}> so what follows can be read`,
            });
            Object.assign(raw, { bodyEnd: text.length, end: text.length });
          }
          reader.rawTexts.push(raw);
          ASTRO_OPENER.lastIndex = raw.end;
        }
      }
      reader.rawTexts.splice(0).forEach(take);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      reader.rawTexts.length = 0;
      unread.push(unreadable(text, at, match[0] === "{" ? "a template expression" : "a tag", error));
      ASTRO_OPENER.lastIndex = at + 1;
    }
  }

  return { modules, blanks, unread };
}

/**
 * A fenced code block's opening line, as CommonMark reads one: up to three
 * spaces, then three or more backticks followed by no backtick (the info
 * string may not hold one), or three or more tildes followed by anything.
 */
const CODE_FENCE = /^( {0,3})(?:(`{3,})[^`]*|(~{3,}).*)$/;

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

/** The columns of a line's leading whitespace, a tab counting four. */
const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, "    ").length;

/** A line that opens an MDX ESM block: `import` or `export` at the left margin, then a space, `{` or `*`. */
const ESM_LINE = /^(import|export)[\s{*]/;

/**
 * Whether the ESM `block` is `"complete"` (it parses), `"incomplete"` (its
 * first syntax error sits at its end, after its last non-blank character, as an
 * unclosed `import {`, object literal or comment leaves one) or `"malformed"`
 * (its first error comes sooner). Incomplete is the test MDX's ESM parser makes
 * at a blank line (an error at the end of what it has read means "read on"),
 * made here with TypeScript's parser; a malformed block fails MDX's own
 * compile.
 */
function esmState(block) {
  const { diagnostics } = ts.transpileModule(block, {
    fileName: "esm.tsx",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve },
  });

  if (diagnostics.length === 0) return "complete";

  return Math.min(...diagnostics.map(({ start }) => start ?? 0)) >= block.trimEnd().length ? "incomplete" : "malformed";
}

/**
 * The parts of an MDX page: its `modules`, which hold its ESM, the `blanks`
 * that are neither ESM nor markup — the YAML frontmatter, fenced code and code
 * spans — so what is left is the prose and JSX, whose `{…}` expressions MDX
 * evaluates, and `unread`, what it could not read.
 *
 * The page is read line by line, as CommonMark reads blocks. A fenced code
 * block, from its opening fence to the line that closes it (`closesFence`), is
 * no module code, whatever it holds. The ESM is each run of lines from one that
 * starts `import` or `export` at the left margin (`ESM_LINE`) up to the next
 * blank line that ends it, outside fenced code; a blank line ends the block only
 * once what it holds is complete (`esmState`), since MDX's ESM parser carries a
 * declaration still open at the blank line on to the next one. The blocks that
 * parse are read as one module, as MDX compiles them, so a binding one makes is
 * known in the next (a `createRequire` alias, say), and since each parses on
 * its own, none leaves a comment or string open into the next. A block that
 * does not is reported and read as a module apart, so its comment or string
 * opener hides no other block.
 *
 * Markdown text is read for its code spans and for the structures MDX reads in
 * it, each read whole by {@link structureReader}: a `{…}` template expression,
 * which is JavaScript with JSX in it, and a JSX tag (`<Card title="…" />`),
 * whose quoted attribute values are text. A code span opens only in Markdown,
 * never inside a structure, where a backtick is a template literal's and a load
 * in one runs; a line a structure spans is neither a fence nor ESM.
 *
 * What it cannot read is reported (#1662), never read on as something else,
 * since text read as code lets a comment or string opener in it hide the real
 * code after it, and code read as text hides the code itself: a structure
 * whose end cannot be found, a code span that may run onto a later line, a
 * fence that never closes or whose content is indented less than it (a list it
 * sits in may end it there), an `import` or `export` line straight after a
 * line of text (MDX reads ESM only where a block starts, so it may be that
 * paragraph's text), and an ESM block that does not parse or never completes.
 */
function mdxParts(text) {
  const frontmatterEnd = leadingFence(text)?.end ?? 0;
  const blanks = [[0, frontmatterEnd]];
  /** The ESM blocks that parse, `[start, end)`: one module, as MDX compiles them. */
  const ranges = [];
  /** The ESM blocks that do not, each a module apart, so none can leave a comment or string open into another. */
  const apart = [];
  const unread = [];
  const reader = structureReader(text, false);
  /** The fence that opened the code block the line is in, or null outside one. */
  let codeFence = null;
  /** Where that code block started, and the indent of its fence. */
  let codeStart = -1;
  let codeIndent = 0;
  /** Whether that code block has been reported for content indented less than its fence. */
  let codeReported = false;
  /** Where the ESM block the line is in started, or -1 outside one. */
  let esmStart = -1;
  /** True when that block starts straight after a line of text, where MDX may read it as text. */
  let esmDoubtful = false;
  /** Where the structures read so far end, at the furthest: text before it is no Markdown. */
  let structuresEnd = frontmatterEnd;
  /** True when the line starts a block: the first, or one after a blank line or a closing fence. */
  let blockStart = true;
  /** Where the paragraph holding `at` ends: the next blank line or fence line, or the end of the page. */
  const paragraphEnd = (at) => {
    const lines = /^[ \t]*\r?$|^ {0,3}(`{3,}|~{3,})/gm;

    lines.lastIndex = text.indexOf("\n", at) + 1 || text.length;
    const found = lines.exec(text);

    return found === null ? text.length : found.index;
  };
  /** Reads a run of backticks at `at` on a line ending at `to`: a code span, or text. Returns where it ends. */
  const codeSpan = (at, to) => {
    const run = /^`+/.exec(text.slice(at, to))[0];
    const closer = new RegExp(`(?<!\`)${run}(?!\`)`, "g");

    closer.lastIndex = at + run.length;
    const close = closer.exec(text);

    if (close !== null && close.index < to) {
      blanks.push([at, close.index + run.length]);

      return close.index + run.length;
    }
    if (close !== null && close.index < paragraphEnd(at)) {
      unread.push({
        at,
        what:
          `a code span opened on line ${lineOf(text, at)} that may run onto a later line, which this check does ` +
          "not read: keep each code span on one line",
      });
    }

    return at + run.length;
  };
  /**
   * Reads Markdown text from `from` to `to`, on one line: blanks each code
   * span, reads each structure, and returns where the last one ends when that
   * is past `to`, else `to`.
   */
  const readMarkdown = (from, to) => {
    for (let i = from; i < to; i++) {
      const c = text[i];

      if (c === "\\") {
        i++;
      } else if (c === "`") {
        i = codeSpan(i, to) - 1;
      } else if (c === "{" || (c === "<" && ELEMENT_START.test(text[i + 1] ?? ""))) {
        let end;

        try {
          end = c === "{" ? reader.code(i + 1) : reader.startTag(i).end;
        } catch (error) {
          if (!(error instanceof Unreadable)) throw error;
          unread.push(unreadable(text, i, c === "{" ? "a template expression" : "a JSX tag", error));
          continue;
        }
        if (end > to) return end;
        i = end - 1;
      }
    }

    return to;
  };
  /** Ends the ESM block at `end`, reporting it when it does not parse. */
  const endEsm = (end, state, reported = false) => {
    (state === "complete" ? ranges : apart).push([esmStart, end]);
    if (reported) {
      // Already reported where it started.
    } else if (state === "malformed") {
      unread.push({
        at: esmStart,
        what:
          `an import or export block on line ${lineOf(text, esmStart)} that does not parse as module code: fix ` +
          "it so it can be read",
      });
    } else if (state === "incomplete") {
      unread.push({
        at: esmStart,
        what:
          `an import or export block opened on line ${lineOf(text, esmStart)} that never completes, which hides ` +
          "the rest of the page: complete it so what follows can be read",
      });
    }
    esmStart = -1;
  };
  let at = frontmatterEnd;

  while (at < text.length) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, end).replace(/\r?\n$/, "");
    const lineEnd = at + line.length;
    const blank = line.trim() === "";
    let nextStartsBlock = blank;

    if (codeFence !== null) {
      if (closesFence(line, codeFence)) {
        codeFence = null;
        blanks.push([codeStart, end]);
        nextStartsBlock = true;
      } else if (!blank && indentOf(line) < codeIndent && !codeReported) {
        codeReported = true;
        unread.push({
          at: codeStart,
          what:
            `a code fence opened on line ${lineOf(text, codeStart)}, indented, whose line ${lineOf(text, at)} is ` +
            "indented less, so a list or other block it sits in may end it there: indent its content as far as " +
            "its fence",
        });
      }
    } else if (esmStart !== -1) {
      if (blank) {
        const state = esmState(text.slice(esmStart, at));

        // A doubtful block, reported already, reads no further: what follows the blank line is read apart.
        if (state !== "incomplete" || esmDoubtful) endEsm(at, state, esmDoubtful);
      }
    } else if (at < structuresEnd) {
      // A line a structure spans: JavaScript or a tag, where no fence or ESM opens.
      if (structuresEnd < lineEnd) structuresEnd = readMarkdown(structuresEnd, lineEnd);
    } else if (CODE_FENCE.test(line)) {
      const open = CODE_FENCE.exec(line);

      codeFence = open[2] ?? open[3];
      codeStart = at;
      codeIndent = open[1].length;
      codeReported = false;
    } else if (ESM_LINE.test(line)) {
      esmDoubtful = !blockStart;
      if (esmDoubtful) {
        unread.push({
          at,
          what:
            `an import or export on line ${lineOf(text, at)} straight after a line of text, which MDX may read as ` +
            "that text rather than as module code: put a blank line before it",
        });
      }
      esmStart = at;
    } else {
      structuresEnd = readMarkdown(at, lineEnd);
    }
    blockStart = nextStartsBlock;
    at = end;
  }
  if (esmStart !== -1) endEsm(text.length, esmState(text.slice(esmStart)), esmDoubtful);
  if (codeFence !== null) {
    unread.push({
      at: codeStart,
      what:
        `a code fence opened on line ${lineOf(text, codeStart)} that never closes, which hides the rest of the ` +
        "page: close it so what follows can be read",
    });
    blanks.push([codeStart, text.length]);
  }

  const modules = [...(ranges.length === 0 ? [] : [ranges]), ...apart.map((range) => [range])];

  return {
    modules: modules.sort((a, b) => a[0][0] - b[0][0]).map((each) => ({ ranges: each, overlays: [] })),
    blanks: [...blanks, ...ranges, ...apart],
    unread,
  };
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
 * module code: {@link markupLoads} finds it. What the reader could not read,
 * {@link unreadStructure} reports.
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
 * The calls are found by a token scan, which parses no comment or string, so
 * nothing in the markup can hide one; each is a load nothing can follow,
 * wherever in the markup it is: the fix is to make it in the module code.
 * Empty for a {@link CODE} source.
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
    line: lineOf(text, match.index),
  }));
}

/**
 * What the reader of an `.astro` component or `.mdx` page could not read, one
 * sentence each, in the order of the file (#1662): a structure whose end it
 * cannot find, which it reports rather than guess at, since text read as the
 * wrong thing can hide the code after it — an `.astro` HTML comment, `<script>`
 * or `<style>` that never closes, a template expression or tag it cannot read;
 * an `.mdx` page's unreadable expression or JSX tag, a code span that may run
 * onto a later line, a code fence that never closes or that a list may end, an
 * `import` or `export` MDX may read as text, and an ESM block that does not
 * parse or never completes. A guard refuses each rather than pass what it may
 * hide. Each sentence reads after "makes", names its line and says what to
 * write instead. Empty for a {@link CODE} source.
 *
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function unreadStructure(file, text) {
  const parts = componentParts(file, text);

  if (parts === undefined) return [];

  return parts.unread.sort((a, b) => a.at - b.at).map(({ what }) => what);
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
