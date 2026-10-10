// The changelog fold at a stable release (issue #1386): the fragments in
// `changelog.d/` become the dated `## X.Y.Z` section of `changelog.mdx`, and the
// fragments themselves are deleted, all in the release's version-bump commit.
//
// `planChangelogFold` decides and validates everything without writing; the
// caller (`scripts/release-hooks.mjs`) owns the writes, the deletions and the
// `git add`. Planning before writing is the whole point: a malformed fragment
// must abort the release with a clean tree, as a malformed section always has.
// It replaces `changelog-stamp.mjs` (#690), whose `_Unreleased_` line no longer
// exists once the in-development notes are fragments.
//
// Decided in `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`.
import { buildChangelogData } from "./changelog-data.mjs";
import {
  CHANGELOG_FRAGMENTS_DIR,
  composeChangelog,
  loadChangelogSources,
  renderReleaseSection,
} from "./changelog-fragments.mjs";

/**
 * Format a Date as a zero-padded `YYYY-MM-DD` string in local time — matching
 * how the release date is written by hand when cutting a release.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @typedef {{ fold: false, reason: string }} SkippedFold
 * @typedef {{
 *   fold: true,
 *   reason: string,
 *   content: string,
 *   section: string,
 *   fragmentPaths: string[],
 * }} PlannedFold
 */

/**
 * Decide what the fold writes for `version`, validating all of it.
 *
 * Pure: the caller loads the sources (`loadChangelogSources`, which already
 * validates every fragment) and supplies the date. A pre-release, or a stable
 * release with no fragments, is a skip with a reason. Otherwise the fragments
 * are composed with `_<date>_` and the result is run through `buildChangelogData`
 * — the same parser and inline renderer the What's New pane is built with — so
 * anything that would break a reader throws here, before the hook writes.
 *
 * @param {{ mdx: string, fragments: readonly import("./changelog-fragments.mjs").ChangelogFragment[] }} sources
 * @param {string} version - The release version, as release-it passes it.
 * @param {string} date - `YYYY-MM-DD`.
 * @returns {SkippedFold | PlannedFold}
 * @throws on an invalid composition (see `composeChangelog`) or a changelog the
 *   parser refuses.
 */
export function planChangelogFold({ mdx, fragments }, version, date) {
  if (version.includes("-")) {
    return {
      fold: false,
      reason: `Pre-release ${version} — the changelog fragments stay in ${CHANGELOG_FRAGMENTS_DIR}/`,
    };
  }
  if (fragments.length === 0) {
    return {
      fold: false,
      reason: `No fragments in ${CHANGELOG_FRAGMENTS_DIR}/ — ${version} gets no changelog section`,
    };
  }

  const dateLine = `_${date}_`;
  const content = composeChangelog(mdx, fragments, version, dateLine);
  buildChangelogData(content);

  return {
    fold: true,
    reason: `Folded ${fragments.length} fragment${fragments.length === 1 ? "" : "s"} into "## ${version}" → ${dateLine}`,
    content,
    section: renderReleaseSection(version, dateLine, fragments),
    fragmentPaths: fragments.map(({ fileName }) => `${CHANGELOG_FRAGMENTS_DIR}/${fileName}`),
  };
}

/**
 * Load the sources under `root` and plan the fold. A pre-release reads nothing,
 * so a fragment problem never blocks an `-rc` bump (its build still reports it).
 *
 * @param {string} root - The repository root.
 * @param {string} version - The release version.
 * @param {string} date - `YYYY-MM-DD`.
 * @returns {SkippedFold | PlannedFold}
 */
export function loadChangelogFold(root, version, date) {
  if (version.includes("-")) return planChangelogFold({ mdx: "", fragments: [] }, version, date);
  return planChangelogFold(loadChangelogSources(root), version, date);
}
