// Builds the changelog artifact the plugin ships and its What's New pane renders
// (issue #1011).
//
// Pure composition of the two halves either side of it: `changelog-parse.mjs`
// turns the MDX into releases, `changelog-inline-html.mjs` turns each bullet into
// safe HTML. This module owns only the artifact's shape and its serialisation, so
// the generator script is left with nothing but file I/O.

import { renderInlineMarkdown } from "./changelog-inline-html.mjs";
import { parseChangelog } from "./changelog-parse.mjs";

/** Where the artifact is written, relative to the repository root. */
export const CHANGELOG_DATA_PATH = "packages/iracing-actions/src/actions/data/changelog.json";

/** The authoring source, relative to the repository root. */
export const CHANGELOG_SOURCE_PATH = "packages/website/src/content/docs/changelog.mdx";

/** The command that regenerates the artifact, named in the freshness test's failure. */
export const CHANGELOG_GENERATE_COMMAND = "pnpm generate:changelog-data";

/**
 * @typedef {{ title: string, items: string[] }} RenderedCategory
 * @typedef {{ version: string, date: string | null, categories: RenderedCategory[] }} RenderedRelease
 * @typedef {{ _meta: Record<string, string>, releases: RenderedRelease[] }} ChangelogData
 */

/**
 * Build the shippable changelog data from the authoring source.
 *
 * Bullet `items` come out as HTML, already escaped by `renderInlineMarkdown` —
 * the settings window emits them raw, so the escaping must happen here, once, at
 * build time rather than in the browser.
 *
 * @param {string} mdxSource - The full contents of changelog.mdx.
 * @returns {ChangelogData}
 */
export function buildChangelogData(mdxSource) {
  const { releases } = parseChangelog(mdxSource);

  return {
    _meta: {
      generatedFrom: CHANGELOG_SOURCE_PATH,
      generatedBy: CHANGELOG_GENERATE_COMMAND,
      note: "Generated file — edit the source above, then regenerate. Bullet items are pre-escaped HTML.",
    },
    releases: releases.map((release) => ({
      version: release.version,
      date: release.date,
      categories: release.categories.map((category) => ({
        title: category.title,
        // The renderer sees one bullet at a time and has no idea where it came
        // from; a bare "must start with /" against a 700-line changelog is a
        // search. Name the release, the category and the bullet, so the failure
        // points at the entry the way ChangelogParseError points at the line.
        items: category.items.map((item) => {
          try {
            return renderInlineMarkdown(item);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`changelog ${release.version} / ${category.title}: ${message}\n  bullet: ${item}`, {
              cause: error,
            });
          }
        }),
      })),
    })),
  };
}

/**
 * Serialise the artifact exactly as it is committed, so the freshness test can
 * compare file text rather than re-deriving the formatting.
 *
 * @param {ChangelogData} data
 * @returns {string}
 */
export function serializeChangelogData(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}
