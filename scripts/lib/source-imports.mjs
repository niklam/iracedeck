/**
 * Reading what a workspace package's sources import and which of them are
 * tests, shared by the guards that hold the package boundaries (#1375):
 * `scripts/plugin-shell-dependencies.test.mjs`,
 * `scripts/cross-package-reach.test.mjs` and
 * `scripts/testing-entries-test-only.test.mjs`.
 *
 * Imports are read with TypeScript's own scanner (`ts.preProcessFile`), so a
 * comment can neither add nor hide one. An `.astro` component's or `.mdx`
 * page's loads are read from its raw text, never parsed (`componentLoads`,
 * #1662): every literal module specifier anywhere in it is a candidate load,
 * and a load a literal cannot say (a computed `import(`, a `require` or
 * `createRequire` or `getBuiltinModule`, a machine-specific path, a glob of
 * module code) is reported as unread, for a guard
 * to refuse. A reader of markup that is not the one Astro and MDX run leaks
 * where the two disagree, so this one tells no code from markup or prose.
 */
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import ts from "typescript";

/** A JavaScript or TypeScript source, by extension. */
export const CODE = /\.[cm]?[jt]sx?$/;

/**
 * A component Astro or MDX compiles, by extension: an Astro component
 * (`.astro`) or an MDX page (`.mdx`). Its loads are read from its raw text
 * through {@link componentLoads}, never parsed (#1662).
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
 * too ({@link COMPONENT}), whose loads a caller then reads through
 * {@link componentLoads} (#1662).
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
 * The named character references that decode to an ASCII character, the only
 * ones that can spell a module specifier's text (no letter, digit or hyphen
 * has a name, so those are written by number or not at all), with the four
 * that HTML also decodes without their `;`.
 */
const ASCII_REFERENCES = {
  amp: "&",
  apos: "'",
  ast: "*",
  bsol: "\\",
  colon: ":",
  comma: ",",
  commat: "@",
  DiacriticalGrave: "`",
  dollar: "$",
  equals: "=",
  excl: "!",
  grave: "`",
  gt: ">",
  Hat: "^",
  lbrace: "{",
  lbrack: "[",
  lcub: "{",
  lowbar: "_",
  lpar: "(",
  lsqb: "[",
  lt: "<",
  midast: "*",
  num: "#",
  percnt: "%",
  period: ".",
  plus: "+",
  quest: "?",
  quot: '"',
  rbrace: "}",
  rbrack: "]",
  rcub: "}",
  rpar: ")",
  rsqb: "]",
  semi: ";",
  sol: "/",
  Tab: "\t",
  UnderBar: "_",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
};
const LEGACY_REFERENCES = new Set(["amp", "gt", "lt", "quot"]);

/**
 * A decoded character as a view keeps it: a line break becomes a space, so
 * every view has the file's own lines and a line number means the same in each.
 */
const kept = (char) => (/^[\r\n\u2028\u2029]$/.test(char) ? " " : char);

/** A code point as a character, or undefined when it names none. */
function codePoint(hex, radix = 16) {
  const value = Number.parseInt(hex, radix);

  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

/**
 * `text` with its HTML character references decoded, as Astro reads an
 * attribute value and MDX a JSX one: `&#46;`, `&#x2e;` and the ASCII named
 * ones ({@link ASCII_REFERENCES}). A `<script src="&#46;&#46;/x.ts">` loads
 * `../x.ts` (#1662).
 */
function decodeReferences(text) {
  return text.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|([A-Za-z]+));?/g, (whole, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const char = decimal !== undefined ? codePoint(decimal, 10) : codePoint(hex);

      return char === undefined ? whole : kept(char);
    }
    if (!Object.hasOwn(ASCII_REFERENCES, name)) return whole;
    if (!whole.endsWith(";") && !LEGACY_REFERENCES.has(name)) return whole;

    return kept(ASCII_REFERENCES[name]);
  });
}

/** A line break, as JavaScript ends a line: LF, CRLF, CR, or the line and paragraph separators. */
const LINE_BREAK = /(\r\n|[\n\r\u2028\u2029])/;

/**
 * `text` with each line continuation — a `\` that ends a line, which a
 * JavaScript string reads as nothing — joined (#1662), so `"@\` and
 * `iracedeck/x"` on the next line read as the `"@iracedeck/x"` they are. The
 * line breaks a join removes are put back after the joined line, so every
 * line after it keeps its number.
 */
function joinContinuations(text) {
  const parts = text.split(LINE_BREAK);
  let out = "";
  let joined = "";
  let held = "";

  for (let at = 0; at < parts.length; at += 2) {
    const line = parts[at];
    const lineBreak = parts[at + 1];

    if (lineBreak !== undefined && line.endsWith("\\")) {
      joined += line.slice(0, -1);
      held += lineBreak;
    } else {
      out += joined + line + (lineBreak ?? "") + held;
      joined = "";
      held = "";
    }
  }

  return out + joined + held;
}

/** The characters a JavaScript single-character escape stands for. */
const SINGLE_ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };

/**
 * `text` with its JavaScript escapes decoded wherever they are: a `\x`, a
 * four-digit or braced `\u` and a single-character escape, so
 * `import("\x2e./x.ts")` reads as the `../x.ts` it loads, and a `require`
 * spelled with a `\u` escape in its name as the `require` it is. A line
 * continuation is joined first ({@link joinContinuations}).
 */
function decodeEscapes(text) {
  return joinContinuations(text).replace(
    /\\(?:x([\da-fA-F]{2})|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|(\r\n|[\s\S]))/g,
    (whole, x, braced, u, single) => {
      if (single === undefined) return kept(codePoint(x ?? braced ?? u) ?? whole);
      if (/^[\r\n\u2028\u2029]/.test(single)) return single;

      return kept(SINGLE_ESCAPES[single] ?? single);
    },
  );
}

/**
 * `text` with each run of percent-encoded bytes decoded as UTF-8, as Vite
 * decodes a URL path, so `src=%2E%2E/x.ts` reads as `../x.ts`. A run that is
 * not UTF-8 is left as written.
 */
function decodePercents(text) {
  return text.replace(/(?:%[\da-fA-F]{2})+/g, (run) => {
    try {
      return [...decodeURIComponent(run)].map(kept).join("");
    } catch {
      return run;
    }
  });
}

/**
 * The texts a component is read in (#1662): as written, and with every
 * combination of its character references, its JavaScript escapes and its
 * percent-encoding decoded, each on the file's own lines. What any of them
 * shows is read, so neither an attribute's `&#46;`, a string's `\x2e` nor a
 * URL's `%2E` hides a specifier.
 */
function views(text) {
  let all = [text];

  for (const decode of [decodeReferences, decodeEscapes, decodePercents]) all = [...all, ...all.map(decode)];

  return [...new Set(all)];
}

/** Whitespace and comments, as JavaScript skips them between two tokens. */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*`;

/** One string literal: quoted on one line, or a template literal with no `${`. */
const LITERAL =
  String.raw`(?:"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*'|` + "`(?:[^`\\\\$]|\\\\[\\s\\S]|\\$(?!\\{))*`)";

/**
 * A word that loads a module by what follows it: `import` before a `(` (not a
 * method of that name, nor `import.meta`), `require` anywhere, and
 * `createRequire` and `getBuiltinModule` anywhere.
 */
const LOAD_WORD = new RegExp(
  String.raw`(?<![\w$.])import(?=${GAP}\()|(?<![\w$])(?:require|createRequire|getBuiltinModule)(?![\w$])`,
  "g",
);

/**
 * A path that names a place on one machine rather than in the repository: a
 * drive letter (`C:/`, `C:\`), Vite's `/@fs/` prefix or a `file:` URL (#1662).
 * An import of one loads whatever is there, which this cannot follow.
 */
const MACHINE_PATH =
  /\/@fs\/(?:[A-Za-z]:[\\/])?|(?<![\w.+-])(?:file:(?=[\\/]|[A-Za-z]:)(?:[\\/]*[A-Za-z]:[\\/])?|[A-Za-z]:[\\/])/gi;

/** From just past `import` or `require`: its `(`, then one string literal, then `)` or the `,` before an option. */
const LITERAL_CALL = new RegExp(String.raw`${GAP}\(${GAP}${LITERAL}${GAP}[,)]`, "y");

/** A Vite glob import's callee, `import.meta.glob` (or `globEager`), however spaced. */
const GLOB = new RegExp(String.raw`(?<![\w$.])import${GAP}\.${GAP}meta${GAP}\.${GAP}glob[\w$]*`, "g");

/**
 * A bare path in a component's text: `./`, `../` (either with `\` for `/`, as
 * a `file:` URL reads it on Windows), a root-absolute `/` that is not a
 * protocol-relative `//`, or an `@iracedeck/` package, starting where no other
 * path character comes before it and running to whitespace, a quote, a bracket
 * or a separator. An unquoted `src=../x.ts`, a Markdown image `![](../x.ts)`
 * or a reference definition `[x]: ../x.ts` is one, which MDX and Astro import
 * as written.
 */
const BARE_PATH = /(?<![\w.~@$%+\-/\\])(?:\.{1,2}[/\\]|\/(?!\/)|@iracedeck\/)[^\s"'`<>()[\]{}|,;:*]*/gi;

/** A module specifier a component's raw text is read for: relative, root-absolute or an `@iracedeck/` package. */
export const CANDIDATE = /^(?:\.{1,2}\/|\/(?!\/)|@iracedeck\/[a-z\d])/;

/** `@iracedeck/<name>`, its package part. */
const IRACEDECK_PACKAGE = /^@iracedeck\/[^/]*/i;

/**
 * The specifiers one piece of text may be read as: as written, with `\` for
 * `/`, and each without the punctuation a sentence puts after it. A package
 * name is taken only up to whitespace, without that punctuation and in lower
 * case, as Windows resolves its folder, so a sentence's full stop or the rest
 * of a template literal's lines names no other package.
 */
function specifiersOf(piece) {
  const found = new Set();
  const add = (text) => {
    const bare = text.replace(/[.,:;!?]+$/, "");

    if (IRACEDECK_PACKAGE.test(text)) {
      const name = text.split(/\s/)[0].replace(/[.,:;!?]+$/, "");

      found.add(name.replace(IRACEDECK_PACKAGE, (part) => part.toLowerCase()));
    } else {
      found.add(text);
      found.add(bare);
    }
  };

  for (const text of new Set([piece, piece.replaceAll("\\", "/")])) add(text);

  return [...found].filter((specifier) => CANDIDATE.test(specifier));
}

/** The line an unread sentence names. */
const lineNamed = (sentence) => Number(/ on line (\d+)/.exec(sentence)[1]);

/** The 1-based line of offset `at` in `text`. */
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

/**
 * Each item that occurs in any of `lists`, as many times as the list holding
 * it most often does, in the order they first appear: so one thing read in
 * several views is read once, and two of it on a line stay two.
 */
function mostOf(lists) {
  const counts = new Map();

  for (const list of lists) {
    const here = new Map();

    for (const item of list) here.set(item, (here.get(item) ?? 0) + 1);
    for (const [item, count] of here) counts.set(item, Math.max(counts.get(item) ?? 0, count));
  }

  return [...counts].flatMap(([item, count]) => Array(count).fill(item));
}

/** The candidates of one view: each quoted string's text and each bare path, every specifier each may be read as. */
function viewCandidates(view) {
  /** Offset of each piece → the specifiers read from it, so a quoted path and the bare path inside it are one. */
  const at = new Map();
  const take = (offset, piece) => {
    const each = at.get(offset) ?? new Set();

    for (const specifier of specifiersOf(piece)) each.add(specifier);
    at.set(offset, each);
  };
  let lineStart = 0;

  for (const line of view.split("\n")) {
    for (const quote of ['"', "'", "`"]) {
      let open = line.indexOf(quote);

      // Every two quotes in a row, so no string is missed for a quote before it that opens none.
      for (let close = line.indexOf(quote, open + 1); open !== -1 && close !== -1;) {
        take(lineStart + open + 1, line.slice(open + 1, close));
        open = close;
        close = line.indexOf(quote, open + 1);
      }
    }
    lineStart += line.length + 1;
  }
  // A template literal may run across lines: every two backticks in a row in the whole text, too.
  for (let open = view.indexOf("`"), close = view.indexOf("`", open + 1); open !== -1 && close !== -1;) {
    take(open + 1, view.slice(open + 1, close));
    open = close;
    close = view.indexOf("`", open + 1);
  }
  for (const match of view.matchAll(BARE_PATH)) take(match.index, match[0]);

  return [...at.entries()].sort(([a], [b]) => a - b).flatMap(([, each]) => [...each]);
}

/** What one view of a component loads that a literal cannot say: each sentence reads after "makes". */
function viewUnread(view, isDataGlob) {
  const unread = [];

  for (const match of view.matchAll(LOAD_WORD)) {
    const word = match[0];
    const line = lineOf(view, match.index);

    if (word === "createRequire") {
      unread.push(
        `a createRequire on line ${line}, whose require functions this check cannot follow under the names they ` +
          "get: load the module with import and a string literal",
      );
      continue;
    }
    if (word === "getBuiltinModule") {
      unread.push(
        `a getBuiltinModule on line ${line}, which loads a module this check cannot follow: load it with import ` +
          "and a string literal",
      );
      continue;
    }
    LITERAL_CALL.lastIndex = match.index + word.length;
    if (LITERAL_CALL.test(view)) continue;
    unread.push(
      word === "import"
        ? `an import( on line ${line} whose specifier is not a single string literal, a load this check cannot ` +
            "read: write the specifier as a literal"
        : `a require on line ${line} that is not called with a single string literal, a load this check cannot ` +
            "read: write the specifier as a literal",
    );
  }
  for (const match of view.matchAll(MACHINE_PATH)) {
    unread.push(
      `a machine-specific path on line ${lineOf(view, match.index)} this check cannot follow; use a relative path ` +
        "inside the repository",
    );
  }
  for (const match of view.matchAll(GLOB)) {
    const line = lineOf(view, match.index);
    const sf = ts.createSourceFile("glob.ts", view.slice(match.index), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let call;
    const find = (node) => {
      if (call !== undefined) return;
      if (
        ts.isCallExpression(node) &&
        node.getStart(sf) === 0 &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isMetaProperty(node.expression.expression)
      ) {
        call = node;
      } else {
        ts.forEachChild(node, find);
      }
    };

    find(sf);
    const broken = (sf.parseDiagnostics ?? []).some(({ start }) => call === undefined || start < call.end);

    if (call === undefined || broken || !isDataGlob(call)) {
      unread.push(
        `an import.meta.glob on line ${line} that is not a glob of data files, which this check does not expand: ` +
          "import each module by a string literal",
      );
    }
  }

  return unread;
}

/**
 * What an `.astro` component or an `.mdx` page loads, read from its raw text
 * and never parsed (#1662). A parser that is not the one Astro and MDX run
 * leaks wherever the two disagree on where code starts (an indented fence, a
 * regular expression after a `)`), so nothing here tells code from markup,
 * prose, a comment or a fence:
 *
 * - `candidates`: every module specifier the text could spell ({@link
 *   CANDIDATE}), one entry per place it does — the text of each quoted string
 *   (`"…"`, `'…'`, `` `…` ``, between any two of the same quote on a line, and
 *   any two backticks across lines) and each bare path ({@link BARE_PATH}),
 *   read as written, with its character references, JavaScript escapes (a
 *   line continuation joined) and percent-encoding decoded ({@link views}),
 *   `\` as `/`, and without a sentence's trailing punctuation. A load written
 *   as a literal is among them wherever in the file it is.
 * - `unread`: every load a literal cannot say — an `import(` or `require`
 *   whose argument is not a single string literal (a template with `${`, a
 *   concatenation, a name, nothing), `require` used any other way, any
 *   `createRequire` or `getBuiltinModule`, a machine-specific path ({@link
 *   MACHINE_PATH}: a drive letter, `/@fs/`, a `file:` URL), and an
 *   `import.meta.glob` that `isDataGlob` does not pass (`isDataGlob` gets the
 *   call, parsed from where it starts). Each sentence reads after "makes" and
 *   names its line.
 *
 * This over-approximates: a mention in prose, a fence, a code span, an href or
 * a comment is a candidate as much as an import is. A caller follows the
 * candidates that resolve and refuses the rest it cannot clear.
 *
 * @param {string} text
 * @param {{ isDataGlob?: (call: ts.CallExpression) => boolean }} [options]
 * @returns {{ candidates: string[], unread: string[] }}
 */
export function componentLoads(text, { isDataGlob = () => false } = {}) {
  const each = views(text);

  return {
    candidates: mostOf(each.map(viewCandidates)),
    // By line, then by text, so the order is the same whichever view read each first.
    unread: mostOf(each.map((view) => viewUnread(view, isDataGlob))).sort(
      (a, b) => lineNamed(a) - lineNamed(b) || (a < b ? -1 : a > b ? 1 : 0),
    ),
  };
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
