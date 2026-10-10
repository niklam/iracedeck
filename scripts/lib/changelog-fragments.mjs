// Changelog fragments (issue #1386): the in-development release notes live as
// one file per bullet in `changelog.d/`, and every reader composes them into
// `changelog.mdx` through this module, so the website preview, the plugin's
// What's New pane and the release fold all see the same text.
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
import { CHANGELOG_CATEGORIES } from "./changelog-parse.mjs";

/** The fragment directory, relative to the repository root. */
export const CHANGELOG_FRAGMENTS_DIR = "changelog.d";

/** The one file in the fragment directory that is not a fragment. */
export const CHANGELOG_FRAGMENTS_README = "README.md";

/** The date line of a section that has not shipped yet. */
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
// Block syntax that would turn the bullet into something else: an ATX heading
// (`# ` to `###### `) or a blockquote (`>`).
const BLOCK_OPENER = /^(?:#{1,6}(?:[ \t]|$)|>)/;
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
  if (BLOCK_OPENER.test(body)) {
    const opener = body.startsWith(">") ? ">" : body.split(/[ \t]/)[0];
    fail(bodyLine, `the body must not open with "${opener}": a heading or blockquote cannot sit in a bullet`);
  }
  if (LIST_MARKER.test(body)) {
    fail(bodyLine, `the body is the bullet text without its list marker: drop the leading "${body.split(/[ \t]/)[0]}"`);
  }

  // The fold writes this text into MDX, where a bare `<` opens JSX and a bare `{`
  // an expression. The website preview parses plain markdown, so without this
  // check the preview would render a bullet that breaks the build at release time.
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
 * @param {string} version - A plain `X.Y.Z`.
 * @param {string} dateLine - `_Unreleased_` or `_YYYY-MM-DD_`.
 * @param {readonly ChangelogFragment[]} fragments - At least one; sorted here.
 * @returns {string}
 */
export function renderReleaseSection(version, dateLine, fragments) {
  if (!PLAIN_VERSION.test(version)) {
    throw new Error(`renderReleaseSection: version ${JSON.stringify(version)} is not a plain X.Y.Z`);
  }
  if (dateLine !== UNRELEASED_DATE_LINE && !DATE_LINE.test(dateLine)) {
    throw new Error(
      `renderReleaseSection: date line ${JSON.stringify(dateLine)} must be "${UNRELEASED_DATE_LINE}" or "_YYYY-MM-DD_"`,
    );
  }
  if (fragments.length === 0) {
    // A section with no categories is refused by the parser; never emit one.
    throw new Error(`renderReleaseSection: release ${version} has no fragments to render`);
  }

  const lines = [`## ${version}`, "", dateLine, ""];
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
 * Refuse an `_Unreleased_` line in changelog.mdx. Once the notes are fragments, a
 * hand-written in-development section is the old habit coming back, and with no
 * fragments to compose it would otherwise pass every reader silently. It runs
 * whatever the fragment count; `composeChangelog` calls it first.
 *
 * @param {string} mdx - The full contents of changelog.mdx.
 * @throws {ChangelogFragmentError} naming the line.
 */
export function assertNoInDevelopmentSection(mdx) {
  const lines = String(mdx).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (UNRELEASED_LINE.test(lines[i])) {
      throw new ChangelogFragmentError(
        CHANGELOG_SOURCE_PATH,
        i + 1,
        `"_Unreleased_" left in changelog.mdx: in-development notes are fragments in ${CHANGELOG_FRAGMENTS_DIR}/, not a section`,
      );
    }
  }
}

/**
 * Compose the changelog: the fragments rendered as the `version` section and
 * inserted before the first `## ` heading. With no fragments the MDX is returned
 * unchanged (after the `_Unreleased_` check), so a tree with nothing in
 * development reads exactly as it does after a release.
 *
 * The existing-`## <version>` check runs only while fragments exist, on purpose:
 * on a stable release commit the version is the plain `X.Y.Z` whose dated section
 * the fold has just written, with no fragments left, and the release build
 * composes exactly that tree.
 *
 * @param {string} mdx - The full contents of changelog.mdx.
 * @param {readonly ChangelogFragment[]} fragments
 * @param {string} version - The in-development `X.Y.Z`.
 * @param {string} dateLine - `_Unreleased_` for a preview, `_YYYY-MM-DD_` for the fold.
 * @returns {string}
 * @throws {ChangelogFragmentError} on a leftover `_Unreleased_` line, an existing
 *   `## <version>` section, or a fragment whose bullet repeats a dated one.
 */
export function composeChangelog(mdx, fragments, version, dateLine) {
  assertNoInDevelopmentSection(mdx);
  if (fragments.length === 0) return mdx;

  const source = String(mdx);
  const lines = source.split(/\r?\n/);

  let firstHeading = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      if (firstHeading === -1) firstHeading = i;
      if (heading[1] === version) {
        throw new ChangelogFragmentError(
          CHANGELOG_SOURCE_PATH,
          i + 1,
          `a "## ${version}" section already exists while ${CHANGELOG_FRAGMENTS_DIR}/ holds fragments for that version — bump the version to the next -dev first`,
        );
      }
    }
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
  const section = renderReleaseSection(version, dateLine, fragments).replace(/\n/g, eol);

  if (firstHeading === -1) {
    const separator = source === "" || source.endsWith(`${eol}${eol}`) ? "" : source.endsWith(eol) ? eol : eol + eol;
    return `${source}${separator}${section}`;
  }

  // Splice by line so the text before and after the section is kept byte for byte.
  const offset = lines.slice(0, firstHeading).reduce((sum, line) => sum + line.length + eol.length, 0);
  return `${source.slice(0, offset)}${section}${eol}${source.slice(offset)}`;
}

/**
 * Read everything a reader composes from: the MDX, every fragment (validated and
 * sorted) and the in-development version, which is the root `package.json`
 * version with any `-…` suffix stripped.
 *
 * @param {string} root - The repository root.
 * @returns {{ mdx: string, fragments: ChangelogFragment[], version: string }}
 * @throws {ChangelogFragmentError} on any file in `changelog.d/` other than a
 *   valid fragment or the README.
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
    if (entry === CHANGELOG_FRAGMENTS_README) continue;
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
