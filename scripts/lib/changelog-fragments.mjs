// Changelog fragments (issue #1386): the in-development release notes live as
// one file per bullet in `changelog.d/`, and every reader composes them into
// `changelog.mdx` through this module, so the website preview, the plugin's
// What's New pane and the release fold all see the same text.
//
// Composing runs in one of two modes over one shared core (#1398): a preview
// writes `## <version>` / `_Unreleased_`, or `## Unreleased` with no date line in
// the window after a stable fold, when the root version still names the newest
// dated section; the fold writes `## <version>` / `_<date>_`. The rules are on
// `sectionFor` and `composeChangelogParts`, decided in
// `docs/superpowers/specs/2026-11-08-issue-1398-changelog-fragment-release-window.md`.
//
// Everything here is pure except `loadChangelogSources`, the one thin loader that
// reads the tree. The format is deliberately STRICT, in the manner of
// `changelog-parse.mjs`: anything that is not exactly the documented shape is an
// error naming the file and the line, because a fragment that slips through here
// breaks the website build at release time rather than when it was written.
//
// A fragment:
//
//   ---
//   category: Bug Fixes
//   weight: 60
//   ---
//
//   The bullet text, one line, without its `- ` marker.
//
// The format is documented for authors in `changelog.d/README.md` and decided in
// `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CHANGELOG_SOURCE_PATH } from "./changelog-data.mjs";
import { renderInlineMarkdown } from "./changelog-inline-html.mjs";
import { CHANGELOG_CATEGORIES, compareVersions, UNRELEASED_LABEL } from "./changelog-parse.mjs";

/** The fragment directory, relative to the repository root. */
export const CHANGELOG_FRAGMENTS_DIR = "changelog.d";

/** The one file in the fragment directory that is not a fragment. */
export const CHANGELOG_FRAGMENTS_README = "README.md";

// Files editors and operating systems leave beside the ones you write: Windows'
// thumbnail cache and folder settings (matched without case, as Windows names
// them either way). Dotfiles (`.DS_Store`, vim's `.x.md.swp`) and backups
// ending in `~` are recognised by shape in `isFragmentDirLitter`.
const LITTER_NAMES = new Set(["thumbs.db", "desktop.ini"]);

/**
 * The date line a preview writes under `## <version>` when the in-development
 * version is newer than every released section (the normal case). In the window
 * after a stable fold the section is `## Unreleased` with no date line instead.
 */
export const UNRELEASED_DATE_LINE = "_Unreleased_";

/** Thrown for any fragment, or any composition, that does not follow the format. */
export class ChangelogFragmentError extends Error {
  /**
   * @param {string} file - The file the error is about, as a repository-relative path.
   * @param {number | null} line - 1-based line number in that file, or null when the error has none.
   * @param {string} message
   */
  constructor(file, line, message) {
    super(line === null ? `${file}: ${message}` : `${file} line ${line}: ${message}`);
    this.name = "ChangelogFragmentError";
    this.file = file;
    this.line = line;
  }
}

// `<number>-<slug>.md`: the issue (or PR) number without a leading zero, then
// lowercase words joined by single hyphens.
const FRAGMENT_NAME = /^([1-9]\d*)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const FENCE = /^---[ \t]*$/;
const KEY_LINE = /^([A-Za-z]+):[ \t]*(.*?)[ \t]*$/;
const WEIGHT = /^(?:[1-9]\d?|100)$/;
const FRAGMENT_KEYS = Object.freeze(["category", "weight"]);
// The markers a markdown list item can open with: `-`, `*`, `+`, or `1.` / `1)`.
const LIST_MARKER = /^(?:[-*+]|\d+[.)])(?:[ \t]|$)/;
// Block syntax that would turn the bullet into something else once the fold
// writes it after a `- `, each with what the error calls it. CommonMark allows up
// to three spaces of indent before any of them; a body may not start with
// whitespace at all, so only the unindented forms are needed.
const BLOCK_OPENERS = [
  // An ATX heading, `# ` to `###### ` (seven hashes are text).
  { pattern: /^#{1,6}(?=[ \t]|$)/, what: "a heading" },
  { pattern: /^>/, what: "a blockquote" },
  // A code fence: three or more backticks or tildes.
  { pattern: /^(?:`{3,}|~{3,})/, what: "a fenced code block" },
  // A thematic break: three or more of one of `*`, `-`, `_`, with spaces and
  // tabs between them allowed and nothing else on the line (the body is trimmed).
  { pattern: /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/, what: "a thematic break" },
  // A link reference definition, `[label]: …`, which renders as nothing. A link,
  // `[label](url)`, has no colon after the bracket and is untouched.
  { pattern: /^\[(?:[^[\]\\]|\\.)+\]:/, what: "a link reference definition" },
];
// The same code-span shape `renderInlineMarkdown` lifts out, so the two agree on
// what counts as "inside backticks".
const CODE_SPAN = /`[^`]+`/g;

// The lines of changelog.mdx the composer has to find. They mirror the patterns
// in `changelog-parse.mjs`, which the composed text is parsed with afterwards.
const VERSION_HEADING = /^##[ \t]+(.*?)[ \t]*$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const DATE_LINE = /^_\d{4}-\d{2}-\d{2}_$/;
const UNRELEASED_LINE = /^_Unreleased_[ \t]*$/;
const BULLET_LINE = /^-[ \t]+(.*\S)[ \t]*$/;

const fragmentPath = (fileName) => `${CHANGELOG_FRAGMENTS_DIR}/${fileName}`;

/**
 * @typedef {{ fileName: string, issue: number, category: string, weight: number, body: string }} ChangelogFragment
 */

/**
 * Parse and validate one fragment.
 *
 * @param {string} fileName - The fragment's bare file name, e.g. `1345-session-info-cpu.md`.
 * @param {string} text - The file's contents. LF or CRLF.
 * @returns {ChangelogFragment}
 * @throws {ChangelogFragmentError} naming the file, and the line where there is one.
 */
export function parseFragment(fileName, text) {
  const file = fragmentPath(fileName);
  const fail = (line, message) => {
    throw new ChangelogFragmentError(file, line, message);
  };

  const name = FRAGMENT_NAME.exec(fileName);
  if (!name) {
    fail(
      null,
      `the file name must be "<number>-<slug>.md": the issue (or PR) number, then lowercase words joined by hyphens, e.g. "1345-session-info-cpu.md"`,
    );
  }
  const issue = Number(name[1]);

  const lines = String(text).split(/\r?\n/);
  // The newline that ends the last line is not a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  if (!FENCE.test(lines[0])) {
    fail(1, `a fragment must open with a "---" line`);
  }

  /** @type {Map<string, { value: string, line: number }>} */
  const keys = new Map();
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    if (FENCE.test(line)) {
      closing = i;
      break;
    }
    const match = KEY_LINE.exec(line);
    if (!match) {
      fail(lineNumber, `expected "key: value" in the frontmatter, found ${JSON.stringify(line)}`);
    }
    const [, key, value] = match;
    if (!FRAGMENT_KEYS.includes(key)) {
      fail(lineNumber, `unknown frontmatter key "${key}" (a fragment has exactly: ${FRAGMENT_KEYS.join(", ")})`);
    }
    if (keys.has(key)) {
      fail(lineNumber, `frontmatter key "${key}" appears twice (first on line ${keys.get(key).line})`);
    }
    keys.set(key, { value, line: lineNumber });
  }

  if (closing === -1) {
    fail(lines.length, `the frontmatter is never closed with a "---" line`);
  }
  for (const key of FRAGMENT_KEYS) {
    if (!keys.has(key)) {
      fail(closing + 1, `the frontmatter has no "${key}" (a fragment has exactly: ${FRAGMENT_KEYS.join(", ")})`);
    }
  }

  const category = keys.get("category");
  if (!CHANGELOG_CATEGORIES.includes(category.value)) {
    fail(
      category.line,
      `unknown category ${JSON.stringify(category.value)} (expected one of: ${CHANGELOG_CATEGORIES.join(", ")})`,
    );
  }

  const weight = keys.get("weight");
  if (!WEIGHT.test(weight.value)) {
    fail(
      weight.line,
      `weight ${JSON.stringify(weight.value)} must be a whole number from 1 to 100, with no sign, leading zero or decimal`,
    );
  }

  // The body: exactly one non-blank line, anywhere after the closing fence.
  let body = null;
  let bodyLine = -1;
  for (let i = closing + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (body !== null) {
      fail(i + 1, `the body must be one line (the bullet text); a second line was found after line ${bodyLine}`);
    }
    body = lines[i];
    bodyLine = i + 1;
  }
  if (body === null) {
    fail(null, `the fragment has no body: write the bullet text on one line after the frontmatter`);
  }

  if (/^[ \t]/.test(body)) {
    fail(bodyLine, `the body must not start with whitespace`);
  }
  body = body.trimEnd();
  for (const { pattern, what } of BLOCK_OPENERS) {
    const opener = pattern.exec(body);
    if (opener) {
      fail(bodyLine, `the body must not open with "${opener[0]}": ${what} cannot sit in a bullet`);
    }
  }
  if (LIST_MARKER.test(body)) {
    fail(bodyLine, `the body is the bullet text without its list marker: drop the leading "${body.split(/[ \t]/)[0]}"`);
  }

  // The fold writes this text into MDX, where a bare `<` opens JSX and a bare `{`
  // an expression. The website preview parses plain markdown, so without this
  // check the preview would render a bullet that breaks the build at release time.
  // An escaped backtick is refused first: `CODE_SPAN` does not know CommonMark's
  // backslash escapes, so `\`{x}`` would read here as a code span while MDX reads a
  // literal backtick and then a live `{x}` expression. No released bullet uses one.
  const escapedBacktick = body.indexOf("\\`");
  if (escapedBacktick !== -1) {
    fail(bodyLine, "an escaped backtick (\\`) is not supported: reword so the backtick is not needed");
  }
  const outsideCode = body.replace(CODE_SPAN, "");
  const unsafe = /[<{]/.exec(outsideCode);
  if (unsafe) {
    fail(bodyLine, `a bare "${unsafe[0]}" breaks the MDX build: wrap it in backticks`);
  }

  try {
    renderInlineMarkdown(body);
  } catch (error) {
    fail(bodyLine, error instanceof Error ? error.message : String(error));
  }

  return { fileName, issue, category: category.value, weight: Number(weight.value), body };
}

/** Compare by UTF-16 code unit, the same on every machine and in every locale. */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function categoryIndex(fragment) {
  const index = CHANGELOG_CATEGORIES.indexOf(fragment.category);
  if (index === -1) {
    throw new ChangelogFragmentError(
      fragmentPath(fragment.fileName),
      null,
      `unknown category ${JSON.stringify(fragment.category)} (expected one of: ${CHANGELOG_CATEGORIES.join(", ")})`,
    );
  }
  return index;
}

/**
 * Order fragments as the section lists them: category in `CHANGELOG_CATEGORIES`
 * order, then weight descending, then issue ascending, then file name by code unit.
 * The last key is total (file names are unique), so the result never depends on
 * the input order.
 *
 * @param {readonly ChangelogFragment[]} fragments
 * @returns {ChangelogFragment[]} a new array; the input is not modified.
 */
export function sortFragments(fragments) {
  return [...fragments].sort(
    (a, b) =>
      categoryIndex(a) - categoryIndex(b) ||
      b.weight - a.weight ||
      a.issue - b.issue ||
      compareCodeUnits(a.fileName, b.fileName),
  );
}

/**
 * Render one release section exactly as `changelog.mdx` writes one: the heading,
 * the date line, then each category that has fragments as a bold header followed
 * by its bullets, every block separated by one blank line. The text ends with a
 * single newline after the last bullet.
 *
 * The window section (#1398) is the same call with `UNRELEASED_LABEL` for the
 * version and `null` for the date line: `## Unreleased`, then the categories.
 * The label takes no date line and a version always takes one, so neither mix
 * can be written.
 *
 * @param {string} version - A plain `X.Y.Z`, or `UNRELEASED_LABEL`.
 * @param {string | null} dateLine - `_Unreleased_` or `_YYYY-MM-DD_` for a
 *   version; `null` for the label.
 * @param {readonly ChangelogFragment[]} fragments - At least one; sorted here.
 * @returns {string}
 */
export function renderReleaseSection(version, dateLine, fragments) {
  const isLabel = version === UNRELEASED_LABEL;
  if (!isLabel && !PLAIN_VERSION.test(version)) {
    throw new Error(
      `renderReleaseSection: version ${JSON.stringify(version)} is not a plain X.Y.Z or "${UNRELEASED_LABEL}"`,
    );
  }
  if (isLabel && dateLine !== null) {
    throw new Error(
      `renderReleaseSection: "## ${UNRELEASED_LABEL}" takes no date line, got ${JSON.stringify(dateLine)}`,
    );
  }
  if (!isLabel && dateLine !== UNRELEASED_DATE_LINE && !DATE_LINE.test(String(dateLine))) {
    throw new Error(
      dateLine === null
        ? `renderReleaseSection: release ${version} needs a date line ("${UNRELEASED_DATE_LINE}" or "_YYYY-MM-DD_")`
        : `renderReleaseSection: date line ${JSON.stringify(dateLine)} must be "${UNRELEASED_DATE_LINE}" or "_YYYY-MM-DD_"`,
    );
  }
  if (fragments.length === 0) {
    // A section with no categories is refused by the parser; never emit one.
    throw new Error(`renderReleaseSection: release ${version} has no fragments to render`);
  }

  const lines = isLabel ? [`## ${version}`, ""] : [`## ${version}`, "", dateLine, ""];
  let current = null;
  for (const fragment of sortFragments(fragments)) {
    if (fragment.category !== current) {
      if (current !== null) lines.push("");
      lines.push(`**${fragment.category}**`, "");
      current = fragment.category;
    }
    lines.push(`- ${fragment.body}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Refuse a hand-written in-development section in changelog.mdx: an
 * `_Unreleased_` line, or a `## Unreleased` heading (`UNRELEASED_LABEL`), which
 * exists only in composed text. Once the notes are fragments, either is the old
 * habit coming back, and with no fragments to compose it would otherwise pass
 * every reader silently. It runs whatever the fragment count and the mode;
 * `composeChangelog` calls it first.
 *
 * @param {string} mdx - The full contents of changelog.mdx.
 * @throws {ChangelogFragmentError} naming the line.
 */
export function assertNoInDevelopmentSection(mdx) {
  const lines = String(mdx).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const found = UNRELEASED_LINE.test(lines[i])
      ? UNRELEASED_DATE_LINE
      : VERSION_HEADING.exec(lines[i])?.[1] === UNRELEASED_LABEL
        ? `## ${UNRELEASED_LABEL}`
        : null;
    if (found !== null) {
      throw new ChangelogFragmentError(
        CHANGELOG_SOURCE_PATH,
        i + 1,
        `"${found}" left in changelog.mdx: in-development notes are fragments in ${CHANGELOG_FRAGMENTS_DIR}/, not a section`,
      );
    }
  }
}

/**
 * How a composition is used, which decides the version rules and the section's
 * heading and date line:
 *
 * - `{ mode: "preview" }` — a reader showing the tree as it stands (the What's
 *   New data, the website page). `version` is the root `package.json` version.
 * - `{ mode: "fold", date }` — the stable release writing the fragments into
 *   changelog.mdx. `version` is the release version; `date` is `YYYY-MM-DD`.
 *
 * @typedef {{ mode: "preview" } | { mode: "fold", date: string }} ComposeMode
 */

const FOLD_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Refuse anything but exactly `{ mode: "preview" }` or `{ mode: "fold", date }`.
 * A programming error rather than a changelog one, so a plain Error.
 *
 * @param {unknown} mode
 * @returns {ComposeMode}
 */
function checkComposeMode(mode) {
  const describe = () => JSON.stringify(mode) ?? String(mode);
  if (mode === null || typeof mode !== "object" || Array.isArray(mode)) {
    throw new Error(
      `composeChangelog: mode ${describe()} must be { mode: "preview" } or { mode: "fold", date: "YYYY-MM-DD" }`,
    );
  }
  const keys = Object.keys(mode).sort();
  if (mode.mode === "preview" && keys.length === 1) return mode;
  if (mode.mode === "fold" && keys.length === 2 && keys[0] === "date" && keys[1] === "mode") {
    if (typeof mode.date === "string" && FOLD_DATE.test(mode.date)) return mode;
    throw new Error(`composeChangelog: fold mode needs a date as "YYYY-MM-DD", got ${JSON.stringify(mode.date)}`);
  }
  throw new Error(
    `composeChangelog: mode ${describe()} must be { mode: "preview" } or { mode: "fold", date: "YYYY-MM-DD" }`,
  );
}

/**
 * The heading and date line the fragments are written under, after the version
 * rules of `mode`. Only called while fragments exist.
 *
 * A fold refuses a `## <version>` section anywhere: a stable release always
 * names a new version, so meeting its own section means a release already wrote
 * it and stopped before deleting the fragments (`release-hooks.mjs` relies on
 * this to refuse a re-run over that tree).
 *
 * A preview compares `version` (V) with the newest `## ` section (N):
 * - no `## ` heading, or V newer than N: `## V` / `_Unreleased_`;
 * - V equal to N (the window after a stable fold, #1398): `## Unreleased`, no
 *   date line;
 * - V older than N, or V's section further down: refused, a misconfigured tree
 *   rather than a window.
 * A newest heading that is not a plain version is left to the parser, which
 * every composed text goes through and which names it; the preview then writes
 * `## V` / `_Unreleased_` above it, as it always has.
 *
 * @param {string[]} lines - changelog.mdx, split into lines.
 * @param {string} version
 * @param {ComposeMode} mode
 * @returns {{ heading: string, dateLine: string | null }}
 * @throws {ChangelogFragmentError} naming the line.
 */
function sectionFor(lines, version, mode) {
  /** @type {{ version: string, line: number }[]} */
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = VERSION_HEADING.exec(lines[i]);
    if (heading) headings.push({ version: heading[1], line: i + 1 });
  }
  const own = headings.find((heading) => heading.version === version);

  if (mode.mode === "fold") {
    if (own) {
      throw new ChangelogFragmentError(
        CHANGELOG_SOURCE_PATH,
        own.line,
        `a "## ${version}" section already exists while ${CHANGELOG_FRAGMENTS_DIR}/ still holds fragments: this is a half-folded tree, where a release wrote the section and stopped before removing the fragments. Run the "git restore" the release hook printed, then release again`,
      );
    }
    return { heading: version, dateLine: `_${mode.date}_` };
  }

  const newest = headings[0];
  if (newest === undefined || !PLAIN_VERSION.test(newest.version)) {
    return { heading: version, dateLine: UNRELEASED_DATE_LINE };
  }
  if (compareVersions(version, newest.version) < 0) {
    throw new ChangelogFragmentError(
      CHANGELOG_SOURCE_PATH,
      newest.line,
      `the in-development version ${version} (package.json) is behind the newest section "## ${newest.version}" while ${CHANGELOG_FRAGMENTS_DIR}/ holds fragments — bump the version to ${newest.version} or later`,
    );
  }
  if (own && own !== newest) {
    throw new ChangelogFragmentError(
      CHANGELOG_SOURCE_PATH,
      own.line,
      `a "## ${version}" section already exists below the newest section "## ${newest.version}" while ${CHANGELOG_FRAGMENTS_DIR}/ holds fragments — the sections are out of newest-first order`,
    );
  }
  if (own) return { heading: UNRELEASED_LABEL, dateLine: null };
  return { heading: version, dateLine: UNRELEASED_DATE_LINE };
}

/**
 * Compose the changelog and return it together with the section it inserted:
 * the fragments rendered as one section and inserted before the first `## `
 * heading (or appended after the preamble when there is none). With no
 * fragments the MDX is returned unchanged (after the in-development check) and
 * the section is `null`, so a tree with nothing in development reads exactly as
 * it does after a release — whatever its version, in either mode.
 *
 * Which section, by `mode` (see `sectionFor`): a fold writes `## <version>` /
 * `_<date>_`; a preview writes `## <version>` / `_Unreleased_`, or, in the
 * window after a stable fold where `version` is the newest dated section,
 * `## Unreleased` with no date line.
 *
 * A reader that needs the section on its own (the website page, the fold's dry
 * run) takes it from here, so it passes exactly the checks the composed file
 * does and is rendered once.
 *
 * The version rules run only while fragments exist, on purpose: on a stable
 * release commit the version is the plain `X.Y.Z` whose dated section the fold
 * has just written, with no fragments left, and the release build composes
 * exactly that tree.
 *
 * @param {string} mdx - The full contents of changelog.mdx.
 * @param {readonly ChangelogFragment[]} fragments
 * @param {string} version - A plain `X.Y.Z`: the in-development version for a
 *   preview, the release version for a fold.
 * @param {ComposeMode} mode
 * @returns {{ content: string, section: string | null }} the composed MDX, in the
 *   MDX's own line endings, and the section as `renderReleaseSection` writes it
 *   (LF), or `null` with no fragments.
 * @throws {ChangelogFragmentError} on a hand-written in-development section (an
 *   `_Unreleased_` line or a `## Unreleased` heading), a fold over an existing
 *   `## <version>` section, a preview whose version is behind the newest section
 *   or has a section below it, two fragments with the same bullet, or a fragment
 *   whose bullet repeats a dated one.
 * @throws {Error} on a mode that is not one of the two, or a version that is not
 *   a plain `X.Y.Z`.
 */
export function composeChangelogParts(mdx, fragments, version, mode) {
  checkComposeMode(mode);
  if (typeof version !== "string" || !PLAIN_VERSION.test(version)) {
    throw new Error(`composeChangelog: version ${JSON.stringify(version)} is not a plain X.Y.Z`);
  }
  assertNoInDevelopmentSection(mdx);
  if (fragments.length === 0) return { content: mdx, section: null };

  const source = String(mdx);
  const lines = source.split(/\r?\n/);
  const { heading, dateLine } = sectionFor(lines, version, mode);
  const firstHeading = lines.findIndex((line) => VERSION_HEADING.test(line));

  // Two fragments with one bullet (a copied file, or a follow-up that added a
  // fragment instead of editing the first) would list the change twice.
  /** @type {Map<string, string>} */
  const fragmentBodies = new Map();
  for (const fragment of fragments) {
    const first = fragmentBodies.get(fragment.body);
    if (first !== undefined) {
      throw new ChangelogFragmentError(
        fragmentPath(fragment.fileName),
        null,
        `its bullet is the same as ${fragmentPath(first)} — one change is one fragment, so delete one of the two`,
      );
    }
    fragmentBodies.set(fragment.body, fragment.fileName);
  }

  // A cherry-picked fix leaves the same bullet in a dated section and as a
  // fragment; refusing it here stops the note from shipping twice.
  /** @type {Map<string, number>} */
  const datedBullets = new Map();
  for (let i = firstHeading === -1 ? lines.length : firstHeading; i < lines.length; i++) {
    const bullet = BULLET_LINE.exec(lines[i]);
    if (bullet && !datedBullets.has(bullet[1])) datedBullets.set(bullet[1], i + 1);
  }
  for (const fragment of fragments) {
    if (datedBullets.has(fragment.body)) {
      throw new ChangelogFragmentError(
        fragmentPath(fragment.fileName),
        null,
        `its bullet is already in a released section (${CHANGELOG_SOURCE_PATH} line ${datedBullets.get(fragment.body)}) — delete the fragment`,
      );
    }
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const section = renderReleaseSection(heading, dateLine, fragments);
  const inserted = section.replace(/\n/g, eol);

  if (firstHeading === -1) {
    const separator = source === "" || source.endsWith(`${eol}${eol}`) ? "" : source.endsWith(eol) ? eol : eol + eol;
    return { content: `${source}${separator}${inserted}`, section };
  }

  // Splice by line so the text before and after the section is kept byte for byte.
  const offset = lines.slice(0, firstHeading).reduce((sum, line) => sum + line.length + eol.length, 0);
  return { content: `${source.slice(0, offset)}${inserted}${eol}${source.slice(offset)}`, section };
}

/**
 * Compose the changelog: `composeChangelogParts`' content alone, for a reader
 * that needs only the composed file.
 *
 * @param {string} mdx - The full contents of changelog.mdx.
 * @param {readonly ChangelogFragment[]} fragments
 * @param {string} version - A plain `X.Y.Z`: the in-development version for a
 *   preview, the release version for a fold.
 * @param {ComposeMode} mode - `{ mode: "preview" }` or `{ mode: "fold", date }`.
 * @returns {string}
 * @throws {ChangelogFragmentError} as `composeChangelogParts` does.
 */
export function composeChangelog(mdx, fragments, version, mode) {
  return composeChangelogParts(mdx, fragments, version, mode).content;
}

/**
 * Whether a directory entry in `changelog.d/` is something an editor or the
 * operating system left there rather than a file anyone wrote: a dotfile
 * (`.DS_Store`, a vim swap file such as `.1345-x.md.swp`), a backup ending in
 * `~`, `Thumbs.db` or `desktop.ini`. Readers skip these; anything else that is
 * not a valid fragment, a mis-named `.md` included, stays an error.
 *
 * @param {string} entry - A bare directory entry name.
 * @returns {boolean}
 */
export function isFragmentDirLitter(entry) {
  return entry.startsWith(".") || entry.endsWith("~") || LITTER_NAMES.has(entry.toLowerCase());
}

/**
 * Read everything a reader composes from: the MDX, every fragment (validated and
 * sorted) and the in-development version, which is the root `package.json`
 * version with any `-…` suffix stripped.
 *
 * @param {string} root - The repository root.
 * @returns {{ mdx: string, fragments: ChangelogFragment[], version: string }}
 * @throws {ChangelogFragmentError} on any file in `changelog.d/` other than a
 *   valid fragment, the README or editor and OS litter (`isFragmentDirLitter`).
 */
export function loadChangelogSources(root) {
  const mdx = readFileSync(path.join(root, CHANGELOG_SOURCE_PATH), "utf8");

  const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const version = String(packageVersion).replace(/-.*$/, "");
  if (!PLAIN_VERSION.test(version)) {
    throw new ChangelogFragmentError(
      "package.json",
      null,
      `version ${JSON.stringify(packageVersion)} does not start with a plain X.Y.Z`,
    );
  }

  const dir = path.join(root, CHANGELOG_FRAGMENTS_DIR);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new ChangelogFragmentError(
      `${CHANGELOG_FRAGMENTS_DIR}/`,
      null,
      `cannot read the fragment directory (it holds at least ${CHANGELOG_FRAGMENTS_README}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fragments = [];
  for (const entry of entries.sort(compareCodeUnits)) {
    if (entry === CHANGELOG_FRAGMENTS_README || isFragmentDirLitter(entry)) continue;
    const full = path.join(dir, entry);
    if (!statSync(full).isFile()) {
      throw new ChangelogFragmentError(
        fragmentPath(entry),
        null,
        `only fragments and ${CHANGELOG_FRAGMENTS_README} belong in ${CHANGELOG_FRAGMENTS_DIR}/`,
      );
    }
    fragments.push(parseFragment(entry, readFileSync(full, "utf8")));
  }

  return { mdx, fragments: sortFragments(fragments), version };
}
