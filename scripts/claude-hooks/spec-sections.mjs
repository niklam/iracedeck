/**
 * The spec-heading grammar the spec-commit rule in `rules-bash.mjs` reads a
 * committed spec with (#1193, #1391): the header block, and the Out of scope
 * and Testing/Verification sections as headings that ARE the section. Pure;
 * the rule and its accepted spellings are documented in
 * `.claude/rules/spec-sections.md` (#1659).
 */

/**
 * What a spec must carry beyond its header block (#1193). Measured over all
 * 106 specs: since the #621 policy, "Out of scope" fell from 50 % to 17 % and
 * a Testing/Verification section from 88 % to 70 % — because no rule had ever
 * named either. The only surviving prescription was a pre-#621 template in a
 * planning agent's definition (retired in #1520) that had produced zero specs.
 *
 * The spellings are the ones ALREADY in the corpus, deliberately: the house
 * style has never been uniform, and forcing one would rewrite 45 compliant
 * specs' habits for nothing. Matched against section headings plus the bold
 * pseudo-headings the specs use, never against body prose — a passing mention
 * of a test is not a test plan.
 *
 * A heading counts only when it IS the section (#1391): an accepted name,
 * after an optional number (`5. Testing`), with at most a qualifier after it
 * (`Testing (TDD)`, `Verification — results`, `Unit tests, one per rule`) or a
 * second name joined to it (`Testing & verification`, `Code and tests`,
 * `Out of scope / non-goals`). Until then a section passed when ANY heading
 * merely contained the word, the spec's own title included, so `# The
 * Background Test plays a frame` satisfied the Testing check by itself.
 * Measured over the 183 specs carrying the header block (2026-11-04): the
 * anchoring drops no Out-of-scope pass, and five Testing passes, every one a
 * heading about something else (`Test position`, `Amended after hardware
 * testing: …`, `The verification is the hard part, …`) in a spec that has no
 * Out of scope section either. The check is forward-only, so none of them is
 * re-read.
 */
const SECTION_NAMES = {
  scope: [
    String.raw`out\s+of\s+scope`,
    String.raw`non-goals?`,
    String.raw`not\s+in\s+scope`,
    // `What this deliberately does not do`, and `What this change does not
    // cover`, `What we deliberately do not do`.
    String.raw`what\s+(?:this(?:\s+[\w-]+)?|it|we)\s+(?:deliberately\s+)?(?:does|do)\s+not\s+(?:do|cover|include|ship|change)`,
  ],
  testing: [
    String.raw`(?:(?:manual|unit|integration|build|regression|acceptance|end-to-end|e2e|hardware|device|sim|in-sim)\s+)?(?:tests?|testing|verification)(?:\s+(?:plan|strategy|approach|steps|cases|matrix|checklist|results))?`,
    String.raw`verify`,
    // The PR template's own section name, and its past-tense forms.
    String.raw`how\s+to\s+(?:test|verify)`,
    String.raw`how\s+it\s+(?:is|was)\s+(?:tested|verified)`,
  ],
};

// `5. ` / `8.1 ` ahead of the name; a word or another section's name joined to
// it (`Code and tests`, `Out of scope and testing`), or a second name after
// it; then at most a parenthetical (one level of nesting), an issue reference
// and one tail — a dash, or a comma, colon, semicolon or full stop that ends
// the heading or is followed by a space. `Test position` and `test.ts is
// replaced` are not the section, so a bare word after the name is not either,
// beyond the closed list of nouns a test section is named with (`Test cases`,
// `Testing approach`). The punctuation tail is free on purpose: the corpus's
// real sections use it (`Unit tests, one per rule`, `Verification — results`),
// and a heading that OPENS with the section's name and a stop reads as that
// section to the spec's reader too.
const ANY_SECTION_NAME = `(?:${[...SECTION_NAMES.scope, ...SECTION_NAMES.testing].join("|")})`;
const SECTION_NUMBER = String.raw`(?:\d+(?:\.\d+)*\.?\s+)?`;
const SECTION_JOINER = String.raw`\s+(?:and|&|\/)\s+`;
const SECTION_TAIL = String.raw`(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\s+#\d+)?(?:\s*[—–]\s*\S.*|\s+-\s+\S.*|\s*[,:;.](?:\s+\S.*)?)?`;
const sectionHeading = (names) =>
  new RegExp(
    `^${SECTION_NUMBER}(?:(?:[\\w-]+|${ANY_SECTION_NAME})${SECTION_JOINER})?(?:${names.join("|")})(?:${SECTION_JOINER}${ANY_SECTION_NAME})?${SECTION_TAIL}$`,
    "i",
  );

const SPEC_SECTIONS = [
  { what: "an Out of scope section", re: sectionHeading(SECTION_NAMES.scope) },
  { what: "a Testing or Verification section", re: sectionHeading(SECTION_NAMES.testing) },
];

/** The `> **Issue:** … **Supersedes:** … **Superseded by:** …` block. */
const SPEC_HEADER = /^>\s*\*\*Issue:\*\*.*\*\*Supersedes:\*\*.*\*\*Superseded by:\*\*/m;

/** A line's leading spaces, its list markers (`- `, `1. `, `- 1. `) and what follows. */
const LINE_LEAD = /^( *)((?:(?:[-+*]|\d{1,9}[.)]) +)*)(.*)$/;

/**
 * The spec's lines without the ones no heading can come from, as CommonMark
 * reads them: a fenced code block, from its opening run of backticks or tildes
 * to a closing run of the same character, at least as long, with nothing after
 * it — or to the end of the spec when it never closes — and an HTML comment
 * block, which hides what it holds the same way, through the whole line that
 * closes it (`-->`, or the empty `<!-->` and `<!--->`). A backtick opener
 * carries no backtick in its info string (```` ```js``` is inline ```` is
 * prose). One pass, so whichever opens first wins: a fence inside a comment,
 * or a comment opener inside a fence, is just text.
 *
 * Indentation is judged against the container, which a regex cannot track
 * (#1391, CodeRabbit on PR #1610): an opener or closer is indented at most
 * three spaces past the column its container's content starts at — 0 at the
 * top level, or the column after the list marker of the item it sits in, on
 * the marker's own line (`- ```markdown`) or on a line indented to the item.
 * So a top-level `    ```` is indented code, not a fence, and inside a fence
 * opened at the top level a `    ```` is content, not its close. A fence or
 * comment opened in a list item ends with the item, closed or not. The list
 * tracking is the minimum that needs: the last item's content column, dropped
 * when a line indented less than it follows a blank line, is a heading, or
 * ends a block the item held.
 * Until #1391's reviews an unclosed fence, a closing line with an info string
 * (` ```js `) or the other fence character, a commented-out `## Testing`, the
 * text after a `-->` and a fence opened in a list item all left a heading the
 * spec does not render.
 */
function withoutInertBlocks(text) {
  const kept = [];
  // The open fence or comment, with the content column of the list item it
  // sits in (0 at the top level).
  let block = null;
  let listColumn = null;
  let previousBlank = true;
  for (const line of text.split("\n")) {
    const blank = /^\s*$/.test(line);
    // A block inside a list item ends with the item, closed or not: a line
    // indented less than the item's content is no part of it, since neither
    // fenced code nor an HTML block continues lazily (CodeRabbit on PR #1610).
    if (block && block.container > 0 && !blank && line.match(/^ */)[0].length < block.container) {
      block = null;
      listColumn = null;
    }
    if (block?.kind === "comment") {
      if (line.includes("-->")) block = null;
    } else if (block) {
      const close = line.match(/^( *)(`{3,}|~{3,}) *$/);
      if (
        close &&
        close[2][0] === block.char &&
        close[2].length >= block.length &&
        close[1].length <= block.container + 3
      )
        block = null;
    } else {
      const [, indent, markers, rest] = line.match(LINE_LEAD);
      if (markers) listColumn = indent.length + markers.length;
      else if (!blank && listColumn !== null && indent.length < listColumn && (previousBlank || rest.startsWith("#")))
        listColumn = null;
      const container = markers ? listColumn : listColumn !== null && indent.length >= listColumn ? listColumn : 0;
      const relative = markers ? 0 : indent.length - container;
      const opener = relative <= 3 ? rest.match(/^(`{3,})[^`]*$|^(~{3,})/) : null;
      if (opener) {
        const run = opener[1] ?? opener[2];
        block = { kind: "fence", char: run[0], length: run.length, container };
      } else if (relative <= 3 && rest.startsWith("<!--")) {
        if (!/^<!--(?:-?>|.*-->)/.test(rest)) block = { kind: "comment", container };
      } else kept.push(line);
    }
    previousBlank = blank;
  }
  return kept.join("\n");
}

/**
 * A heading's name: its text without inline HTML (`## Testing <!-- TODO -->`,
 * an `<a id>` anchor) and without emphasis wrapping the whole of it
 * (`**Testing**`, `***Testing***`).
 */
function headingName(text) {
  let name = text.replace(/<!--.*?-->|<\/?[A-Za-z][^<>]*>/g, "").trim();
  for (let was; was !== name;) {
    was = name;
    name = name.replace(/^(\*\*|__|\*|_)(.+)\1$/, "$2").trim();
  }
  return name;
}

/**
 * Section headings — levels 2 to 6, indented up to three spaces — plus the
 * lines the specs make headings of by bolding the WHOLE line (`**Manual
 * verification**`, optionally with a trailing colon). The level-1 heading is
 * the spec's title, never one of its sections, so it is left out (#1391): no
 * spec in the corpus puts a section at level 1. Code fences and comments are
 * dropped first, since a `# verify the build` comment in a bash block is not a
 * heading. A paragraph that merely OPENS in bold is body prose, and does not
 * count: the one post-policy spec that passed on such a line (`**Tests assert
 * structure, not pixels.**`, inside #1145's Decisions) has no test section,
 * and is already in HEAD, so it is never re-checked. An ATX closing run
 * (`## Testing ##`) is markup, not the name. Setext headings (a line
 * underlined with `---`) are not read: no spec uses them.
 */
function specHeadings(text) {
  // Line endings as CommonMark has them: CRLF and a bare CR end a line, and
  // U+2028 / U+2029 do not, though a JavaScript `^` would start a line there.
  // A tab indents to the next multiple of four; specs indent with spaces, so
  // four spaces is close enough for the column a fence is judged at.
  const normalised = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\t/g, "    ");
  const body = withoutInertBlocks(normalised);
  return [
    ...[...body.matchAll(/^ {0,3}#{2,6}[ \t]+(.+)$/gm)].map((m) => m[1].replace(/\s+#+\s*$/, "")),
    ...[...body.matchAll(/^\*\*([^*\n]+?)\*\*[:.]?\s*$/gm)].map((m) => m[1]),
  ].map(headingName);
}

/** What a committed spec is missing, in the order a reader would fix it. */
export function missingSpecParts(text) {
  const missing = [];
  if (!SPEC_HEADER.test(text)) missing.push("the header block (Issue · Supersedes · Superseded by)");
  const heads = specHeadings(text);
  for (const s of SPEC_SECTIONS) if (!heads.some((h) => s.re.test(h))) missing.push(s.what);
  return missing;
}

/** A spec is named for its issue; the date and the topic around it are free. */
export const specExistsFor = (files, issue) => files.some((f) => new RegExp(`-issue-${issue}-`).test(f));
