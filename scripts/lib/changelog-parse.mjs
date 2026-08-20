// Parses the public changelog (`packages/website/src/content/docs/changelog.mdx`)
// into the structure the plugin's own What's New pane is built from (issue #1011).
//
// Pure and dependency-free: it takes the MDX text and returns data. The file I/O,
// the inline-markdown rendering and the JSON writing live in
// `scripts/generate-changelog-data.mjs`.
//
// The parser is deliberately STRICT. Before #1011 a malformed entry rendered
// slightly oddly on the website; now it would drop a whole release from the pane a
// user reads offline. So anything this parser cannot place is an error naming the
// line, and `changelog-parse.test.mjs` runs it over the real changelog — which is
// what turns the format documented in `.claude/rules/changelog.md` into a build
// gate rather than a convention.

/** The category headers a release may carry, in the order they must appear. */
export const CHANGELOG_CATEGORIES = Object.freeze([
  "Features",
  "Improvements",
  "Bug Fixes",
  "Breaking changes",
  "Maintenance",
]);

/** Thrown for any line the pane could not render. Carries the 1-based line number. */
export class ChangelogParseError extends Error {
  /**
   * @param {string} message
   * @param {number} line - 1-based line number in the source.
   */
  constructor(message, line) {
    super(`changelog.mdx line ${line}: ${message}`);
    this.name = "ChangelogParseError";
    this.line = line;
  }
}

const VERSION_HEADING = /^##[ \t]+(.*?)[ \t]*$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const DATE_LINE = /^_(\d{4}-\d{2}-\d{2})_[ \t]*$/;
const UNRELEASED_LINE = /^_Unreleased_[ \t]*$/;
const CATEGORY_LINE = /^\*\*(.+?)\*\*[ \t]*$/;
const BULLET_LINE = /^-[ \t]+(.*\S)[ \t]*$/;

/**
 * Compare two plain `X.Y.Z` versions numerically. Both are known to match
 * PLAIN_VERSION by the time this is called, so no parse guard is needed.
 *
 * @returns {number} negative when `a` is older than `b`, positive when newer.
 */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }

  return 0;
}

/**
 * @typedef {{ title: string, items: string[] }} ChangelogCategory
 * @typedef {{ version: string, date: string | null, categories: ChangelogCategory[] }} ChangelogRelease
 */

/**
 * Parse changelog MDX into releases, newest first.
 *
 * Everything before the first `## <version>` heading — frontmatter, the `import`
 * line, `<ChangelogLeadIn />` and the intro paragraph — is skipped. Bullet text is
 * returned verbatim (still markdown); rendering it is a separate concern.
 *
 * @param {string} source - The full contents of changelog.mdx.
 * @returns {{ releases: ChangelogRelease[] }}
 * @throws {ChangelogParseError} on any line that cannot be placed.
 */
export function parseChangelog(source) {
  const lines = String(source).split(/\r?\n/);

  /** @type {ChangelogRelease[]} */
  const releases = [];
  const seenVersions = new Set();

  /** @type {ChangelogRelease | null} */
  let release = null;
  /** @type {ChangelogCategory | null} */
  let category = null;
  let highestCategoryIndex = -1;
  let sawDateLine = false;

  // A category header with nothing under it renders as an empty bullet list in the
  // pane, and the format allows a header "only when they have content" — so the
  // open category is checked whenever we are about to leave it.
  const closeCategory = (lineNumber) => {
    if (category !== null && category.items.length === 0) {
      throw new ChangelogParseError(
        `category "${category.title}" in release ${release.version} has no bullets`,
        lineNumber,
      );
    }
  };

  // And a release with no categories at all — a heading and perhaps a date, and
  // nothing else — renders as a card with a version and a blank body. Same rule
  // one level up, checked whenever we are about to leave the release.
  const closeRelease = (lineNumber) => {
    closeCategory(lineNumber);
    if (release !== null && release.categories.length === 0) {
      throw new ChangelogParseError(`release ${release.version} has no categories`, lineNumber);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (line.trim() === "") continue;

    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      const version = heading[1];
      if (!PLAIN_VERSION.test(version)) {
        throw new ChangelogParseError(`heading "## ${version}" is not a version number (expected e.g. "## 1.2.3")`, lineNumber);
      }
      if (seenVersions.has(version)) {
        throw new ChangelogParseError(`version ${version} appears twice`, lineNumber);
      }
      // The pane leans on the list being strictly newest-first: it renders in file
      // order and calls the top entry the in-development one, so a section filed in
      // the wrong place would show the running version buried mid-list.
      const above = releases[releases.length - 1];
      if (above && compareVersions(version, above.version) > 0) {
        throw new ChangelogParseError(
          `release ${version} is newer than ${above.version} above it — the list must be strictly newest-first`,
          lineNumber,
        );
      }
      closeRelease(lineNumber);
      seenVersions.add(version);

      release = { version, date: null, categories: [] };
      releases.push(release);
      category = null;
      highestCategoryIndex = -1;
      sawDateLine = false;
      continue;
    }

    // Everything before the first release heading is preamble the pane never shows.
    if (release === null) continue;

    if (DATE_LINE.test(line) || UNRELEASED_LINE.test(line)) {
      if (sawDateLine) {
        throw new ChangelogParseError(`release ${release.version} has more than one date line`, lineNumber);
      }
      if (release.categories.length > 0) {
        throw new ChangelogParseError(`date line of release ${release.version} follows its categories`, lineNumber);
      }
      sawDateLine = true;
      const dated = DATE_LINE.exec(line);
      // `_Unreleased_` stays null: the pane says "Unreleased" rather than
      // inventing a date, and the release tooling stamps the real one later.
      release.date = dated ? dated[1] : null;
      continue;
    }

    const categoryMatch = CATEGORY_LINE.exec(line);
    if (categoryMatch) {
      const title = categoryMatch[1];
      const index = CHANGELOG_CATEGORIES.indexOf(title);
      if (index === -1) {
        throw new ChangelogParseError(
          `Unknown category "${title}" in release ${release.version} (expected one of: ${CHANGELOG_CATEGORIES.join(", ")})`,
          lineNumber,
        );
      }
      if (release.categories.some((c) => c.title === title)) {
        throw new ChangelogParseError(`category "${title}" appears twice in release ${release.version}`, lineNumber);
      }
      if (index <= highestCategoryIndex) {
        throw new ChangelogParseError(
          `category "${title}" is out of order in release ${release.version} (expected order: ${CHANGELOG_CATEGORIES.join(", ")})`,
          lineNumber,
        );
      }
      closeCategory(lineNumber);
      highestCategoryIndex = index;
      category = { title, items: [] };
      release.categories.push(category);
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      if (category === null) {
        throw new ChangelogParseError(`bullet in release ${release.version} appears before any category header`, lineNumber);
      }
      category.items.push(bullet[1]);
      continue;
    }

    throw new ChangelogParseError(`Unrecognised line in release ${release.version}: ${JSON.stringify(line)}`, lineNumber);
  }

  closeRelease(lines.length);

  return { releases };
}
