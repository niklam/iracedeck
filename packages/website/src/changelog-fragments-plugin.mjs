// Shows the in-development release notes on the changelog page (issue #1386).
//
// Those notes are fragments in `changelog.d/`, one file per bullet, not a section
// of changelog.mdx; the release fold writes them into the file only when a stable
// version is cut. This Sätteri mdast plugin renders them as that version's
// `_Unreleased_` section through the same `renderReleaseSection` the fold and the
// plugin's What's New data use, and splices it into the page before the first
// `##` heading. Injecting at the mdast stage, rather than rendering a component,
// is what keeps the section in Starlight's table of contents with the anchor a
// hand-written one had: heading ids and the TOC are collected later, from hast.
//
// The section is handed over as raw Markdown, so the page's own parser reads it
// with the page's own features (smart punctuation, GFM) and it renders exactly as
// the same text written into changelog.mdx would.
//
// Sätteri, not remark: Astro 7's default Markdown processor, which this site
// uses for `.md` and `.mdx` alike, runs Sätteri plugins only. A remark plugin
// would need the whole site switched to `@astrojs/markdown-remark`.
//
// Every compose-time check runs on the way, so a malformed fragment, a
// hand-written `_Unreleased_` section or a bullet that repeats a dated one fails
// the website build, naming the file.
import path from "node:path";
import url from "node:url";

import { CHANGELOG_SOURCE_PATH } from "../../../scripts/lib/changelog-data.mjs";
import {
  composeChangelogParts,
  loadChangelogSources,
  UNRELEASED_DATE_LINE,
} from "../../../scripts/lib/changelog-fragments.mjs";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");

/**
 * The in-development section as changelog markdown, or `null` when there are no
 * fragments.
 *
 * @param {string} root - The repository root.
 * @returns {string | null}
 */
export function changelogFragmentSection(root) {
  const { mdx, fragments, version } = loadChangelogSources(root);
  // The section comes out of the same composition the generator runs, so the
  // page refuses exactly what the generator refuses.
  return composeChangelogParts(mdx, fragments, version, UNRELEASED_DATE_LINE).section;
}

/**
 * The plugin entry for `satteri({ mdastPlugins })`: a factory that joins the
 * pipeline for `changelog.mdx` only, and only while there are fragments.
 *
 * @param {{ root?: string }} [options] - `root` defaults to this repository.
 * @returns {(ctx: { fileURL: URL | undefined }) => object | undefined}
 */
export function changelogFragmentsPlugin(options = {}) {
  const root = options.root ?? REPO_ROOT;

  return ({ fileURL }) => {
    if (!fileURL) return undefined;
    const relative = path.relative(root, url.fileURLToPath(fileURL)).split(path.sep).join("/");
    if (relative !== CHANGELOG_SOURCE_PATH) return undefined;

    const section = changelogFragmentSection(root);
    if (section === null) return undefined;

    return {
      name: "iracedeck-changelog-fragments",
      before(tree, ctx) {
        const first = tree.children.findIndex((node) => node.type === "heading" && node.depth === 2);
        // Fragments may not contain `<` or `{` outside a code span, so nothing in
        // the section is JSX or an expression; keep any brace in code literal.
        ctx.insertChildAt(tree, first === -1 ? tree.children.length : first, {
          raw: section,
          mdxExpressions: false,
        });
      },
    };
  };
}
