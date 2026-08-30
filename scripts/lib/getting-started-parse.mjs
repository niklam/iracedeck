// Parses the Getting Started source page
// (`packages/website/src/content/docs/docs/getting-started/first-steps.md`) into
// the structure the plugin's own Getting Started tab is built from (issue #1061).
//
// Pure and dependency-free: it takes the Markdown text and returns data. File
// I/O, inline-markdown rendering and JSON writing live either side of it, in
// `getting-started-data.mjs` and `scripts/generate-getting-started-data.mjs`.
//
// It is a SIBLING of `changelog-parse.mjs`, not a reuse of it: that parser knows
// a release/category grammar this page does not have. What the two do share is
// the discipline — a deliberately tiny grammar, and an error naming the line for
// anything it cannot place. The page is read offline by somebody who has just
// installed iRaceDeck, so a block the pane silently drops is a block nobody ever
// finds out is missing.
//
// The grammar, in full:
//
//   ## Heading            starts a section
//   any other text        a paragraph (consecutive lines fold into one)
//   - item                a list item (consecutive lines form one list)
//   <!-- ird:action id -->  an interactive control, rendered by the pane only

/** Thrown for any line the pane could not render. Carries the 1-based line number. */
export class GettingStartedParseError extends Error {
  /**
   * @param {string} message
   * @param {number} line - 1-based line number in the source.
   */
  constructor(message, line) {
    super(`first-steps.md line ${line}: ${message}`);
    this.name = "GettingStartedParseError";
    this.line = line;
  }
}

const FRONTMATTER_FENCE = /^---[ \t]*$/;
const SECTION_HEADING = /^##[ \t]+(.*\S)[ \t]*$/;
const BULLET_LINE = /^-[ \t]+(.*\S)[ \t]*$/;
const ACTION_MARKER = /^<!--[ \t]*ird:action[ \t]+([a-z][a-z0-9-]*)[ \t]*-->[ \t]*$/;
const ANY_COMMENT = /^<!--/;

/**
 * Constructs the pane cannot render, matched so the failure names the construct
 * rather than the generic "could not place this line". Each of these renders
 * perfectly well on the website, which is exactly why they need catching here:
 * the two surfaces would otherwise disagree silently.
 *
 * @type {ReadonlyArray<{ pattern: RegExp, what: string }>}
 */
const UNSUPPORTED = Object.freeze([
  { pattern: /^#(?!#[ \t])#*[ \t]/, what: "a heading of another level — the page has one level, `##`" },
  { pattern: /^>[ \t]?/, what: "a blockquote" },
  { pattern: /^\|/, what: "a table" },
  { pattern: /^(?:```|~~~)/, what: "a code fence" },
  { pattern: /^\d+\.[ \t]/, what: "a numbered list — use `-` bullets" },
  { pattern: /^!\[/, what: "an image — the pane serves no assets" },
]);

/**
 * Skip the Starlight frontmatter and return where the body starts.
 *
 * The frontmatter is deliberately NOT parsed: nothing downstream needs `title`
 * or `description` (the tab carries its own label), and a hand-rolled YAML
 * reader would break the first time the page grows a `sidebar:` key it does not
 * care about.
 *
 * @param {string[]} lines
 * @returns {number} index of the first body line.
 */
function skipFrontmatter(lines) {
  if (!FRONTMATTER_FENCE.test(lines[0] ?? "")) return 0;

  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i])) return i + 1;
  }

  throw new GettingStartedParseError("frontmatter is never closed", 1);
}

/**
 * @typedef {{ type: "paragraph", text: string }} ParagraphBlock
 * @typedef {{ type: "list", items: string[] }} ListBlock
 * @typedef {{ type: "action", id: string }} ActionBlock
 * @typedef {ParagraphBlock | ListBlock | ActionBlock} GettingStartedBlock
 * @typedef {{ title: string, blocks: GettingStartedBlock[] }} GettingStartedSection
 */

/**
 * Parse the Getting Started page into sections of blocks.
 *
 * @param {string} source - The full contents of first-steps.md.
 * @returns {{ sections: GettingStartedSection[] }}
 */
export function parseGettingStarted(source) {
  const lines = String(source).split(/\r?\n/);
  const start = skipFrontmatter(lines);

  /** @type {GettingStartedSection[]} */
  const sections = [];
  /** @type {string[] | null} */
  let paragraph = null;
  /** @type {string[] | null} */
  let list = null;

  const current = () => sections[sections.length - 1];

  const flush = () => {
    if (paragraph) {
      current().blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = null;
    }

    if (list) {
      current().blocks.push({ type: "list", items: list });
      list = null;
    }
  };

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const text = raw.trim();

    if (text === "") {
      flush();
      continue;
    }

    const heading = SECTION_HEADING.exec(text);

    if (heading) {
      if (sections.length > 0) {
        flush();

        if (current().blocks.length === 0) {
          throw new GettingStartedParseError(`section "${current().title}" has no content`, lineNo);
        }
      }

      sections.push({ title: heading[1], blocks: [] });
      continue;
    }

    for (const { pattern, what } of UNSUPPORTED) {
      if (pattern.test(text)) {
        throw new GettingStartedParseError(`the settings window cannot render ${what}`, lineNo);
      }
    }

    if (sections.length === 0) {
      throw new GettingStartedParseError("content before the first `## ` heading would not appear in the pane", lineNo);
    }

    const action = ACTION_MARKER.exec(text);

    if (action) {
      flush();
      current().blocks.push({ type: "action", id: action[1] });
      continue;
    }

    if (ANY_COMMENT.test(text)) {
      // A typo'd marker is invisible on the website AND absent from the pane,
      // so it would never be noticed. Anything comment-shaped must be a marker.
      throw new GettingStartedParseError(
        "an HTML comment that is not an `<!-- ird:action <id> -->` marker on a line of its own",
        lineNo,
      );
    }

    const bullet = BULLET_LINE.exec(text);

    if (bullet) {
      if (paragraph) flush();

      list ??= [];
      list.push(bullet[1]);
      continue;
    }

    if (list) flush();

    paragraph ??= [];
    paragraph.push(text);
  }

  if (sections.length === 0) throw new GettingStartedParseError("the page has no `## ` sections", lines.length);

  flush();

  if (current().blocks.length === 0) {
    throw new GettingStartedParseError(`section "${current().title}" has no content`, lines.length);
  }

  return { sections };
}
