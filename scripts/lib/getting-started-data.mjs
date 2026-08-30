// Builds the Getting Started artifact the plugin ships and its Getting Started
// tab renders (issue #1061).
//
// Pure composition of the two halves either side of it: `getting-started-parse.mjs`
// turns the Markdown into sections, `changelog-inline-html.mjs` turns each run of
// prose into safe HTML. That renderer is reused verbatim rather than reimplemented:
// the two pages want exactly the same inline subset, and its link discipline —
// site-absolute `/docs/…` rebased onto iracedeck.com, anything else throwing — is
// what keeps a link the settings window could not open out of the artifact.
//
// This module owns only the artifact's shape and its serialisation, so the
// generator script is left with nothing but file I/O.

import { renderInlineMarkdown } from "./changelog-inline-html.mjs";
import { parseGettingStarted } from "./getting-started-parse.mjs";

/** Where the artifact is written, relative to the repository root. */
export const GETTING_STARTED_DATA_PATH = "packages/iracing-actions/src/actions/data/getting-started.json";

/** The authoring source, relative to the repository root. */
export const GETTING_STARTED_SOURCE_PATH = "packages/website/src/content/docs/docs/getting-started/first-steps.md";

/** The command that regenerates the artifact, named in the freshness test's failure. */
export const GETTING_STARTED_GENERATE_COMMAND = "pnpm generate:getting-started-data";

/**
 * @typedef {{ type: "paragraph", html: string }} RenderedParagraph
 * @typedef {{ type: "list", items: string[] }} RenderedList
 * @typedef {{ type: "action", id: string }} RenderedAction
 * @typedef {RenderedParagraph | RenderedList | RenderedAction} RenderedBlock
 * @typedef {{ title: string, blocks: RenderedBlock[] }} RenderedSection
 * @typedef {{ _meta: Record<string, string>, sections: RenderedSection[] }} GettingStartedData
 */

/**
 * Render one run of prose, naming where it came from when the renderer refuses it.
 *
 * The renderer sees one string at a time and has no idea where it sits, so a bare
 * "must start with /" against a page of prose is a search. Name the section, the
 * way `GettingStartedParseError` names the line.
 *
 * @param {string} text
 * @param {string} section
 * @returns {string}
 */
function render(text, section) {
  try {
    return renderInlineMarkdown(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`getting started / ${section}: ${message}\n  text: ${text}`, { cause: error });
  }
}

/**
 * Build the shippable Getting Started data from the authoring source.
 *
 * Prose comes out as HTML, already escaped by `renderInlineMarkdown` — the
 * settings window emits it raw, so the escaping happens here, once, at build
 * time rather than in the browser.
 *
 * Action blocks carry only their id. What each one renders — and whether it
 * renders at all, since the Profiles control exists only where the `profiles`
 * platform flag is on — is the pane's business, not the artifact's. The website
 * renders the same source with no controls at all, which is why no sentence in
 * the source may depend on one.
 *
 * @param {string} markdownSource - The full contents of first-steps.md.
 * @returns {GettingStartedData}
 */
export function buildGettingStartedData(markdownSource) {
  const { sections } = parseGettingStarted(markdownSource);

  return {
    _meta: {
      generatedFrom: GETTING_STARTED_SOURCE_PATH,
      generatedBy: GETTING_STARTED_GENERATE_COMMAND,
      note: "Generated file — edit the source above, then regenerate. Prose is pre-escaped HTML.",
    },
    sections: sections.map((section) => ({
      title: section.title,
      blocks: section.blocks.map((block) => {
        if (block.type === "paragraph") return { type: "paragraph", html: render(block.text, section.title) };

        if (block.type === "list") {
          return { type: "list", items: block.items.map((item) => render(item, section.title)) };
        }

        return { type: "action", id: block.id };
      }),
    })),
  };
}

/**
 * Serialise the artifact exactly as it is committed, so the freshness test can
 * compare file text rather than re-deriving the formatting.
 *
 * @param {GettingStartedData} data
 * @returns {string}
 */
export function serializeGettingStartedData(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}
