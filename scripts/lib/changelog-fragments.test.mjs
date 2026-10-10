import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHANGELOG_SOURCE_PATH } from "./changelog-data.mjs";
import {
  assertNoInDevelopmentSection,
  CHANGELOG_FRAGMENTS_DIR,
  ChangelogFragmentError,
  composeChangelog,
  composeChangelogParts,
  isFragmentDirLitter,
  loadChangelogSources,
  parseFragment,
  renderReleaseSection,
  sortFragments,
} from "./changelog-fragments.mjs";
import { CHANGELOG_CATEGORIES, parseChangelog } from "./changelog-parse.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/** A valid fragment's text. */
const fragmentText = ({ category = "Bug Fixes", weight = "50", body = "Something now works." } = {}) =>
  `---\ncategory: ${category}\nweight: ${weight}\n---\n\n${body}\n`;

/** A fragment object as parseFragment returns it, for the sort and render tests. */
const fragment = (fileName, category, weight, body = `Bullet of ${fileName}.`) => ({
  fileName,
  issue: Number(fileName.split("-")[0]),
  category,
  weight,
  body,
});

/** Assert `fn` throws a ChangelogFragmentError naming `file` and `line`, with `message` in it. */
function expectFragmentError(fn, { file, line, message }) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ChangelogFragmentError);
  expect(caught.file).toBe(file);
  expect(caught.line).toBe(line);
  expect(caught.message.startsWith(line === null ? `${file}: ` : `${file} line ${line}: `)).toBe(true);
  if (message) expect(caught.message).toMatch(message);
}

const PREAMBLE = `---
title: Changelog
description: Release notes.
---

import ChangelogLeadIn from "../../components/ChangelogLeadIn.astro";

<ChangelogLeadIn />

Release notes for each version of iRaceDeck. The newest release is listed first.

`;

const DATED = `## 1.2.0

_2026-01-02_

**Features**

- An old feature.

**Bug Fixes**

- An old fix.

## 1.1.0

_2025-12-01_

**Features**

- The first feature.
`;

describe("parseFragment", () => {
  it("reads the issue, category, weight and body of a valid fragment", () => {
    expect(
      parseFragment(
        "1345-session-info-cpu.md",
        fragmentText({ category: "Bug Fixes", weight: "60", body: "**Session Info** keys use less CPU." }),
      ),
    ).toEqual({
      fileName: "1345-session-info-cpu.md",
      issue: 1345,
      category: "Bug Fixes",
      weight: 60,
      body: "**Session Info** keys use less CPU.",
    });
  });

  it("accepts CRLF line endings and returns the body without the CR", () => {
    const parsed = parseFragment("12-crlf.md", fragmentText().replace(/\n/g, "\r\n"));
    expect(parsed.body).toBe("Something now works.");
    expect(parsed.weight).toBe(50);
  });

  it("accepts every category and both ends of the weight range", () => {
    for (const category of CHANGELOG_CATEGORIES) {
      expect(parseFragment("1-a.md", fragmentText({ category })).category).toBe(category);
    }
    expect(parseFragment("1-a.md", fragmentText({ weight: "1" })).weight).toBe(1);
    expect(parseFragment("1-a.md", fragmentText({ weight: "100" })).weight).toBe(100);
  });

  it("accepts blank lines around the body and trailing whitespace on it", () => {
    const parsed = parseFragment("1-a.md", "---\ncategory: Features\nweight: 5\n---\n\n\nThe text.  \n\n\n");
    expect(parsed.body).toBe("The text.");
  });

  it("allows < and { inside a code span", () => {
    const body = "Use `{{= empty(x) ? '--' : x }}` or `<name>` freely.";
    expect(parseFragment("1-a.md", fragmentText({ body })).body).toBe(body);
  });

  describe("refuses a bad file name, naming the file", () => {
    for (const name of [
      "1345.md",
      "1345-Session-Info.md",
      "1345-session_info.md",
      "1345-session--info.md",
      "1345-session-info-.md",
      "01345-session-info.md",
      "session-info.md",
      "1345-session-info.txt",
      "1345-session-info.MD",
      "1345.bugfix.md",
    ]) {
      it(name, () => {
        expectFragmentError(() => parseFragment(name, fragmentText()), {
          file: `${CHANGELOG_FRAGMENTS_DIR}/${name}`,
          line: null,
          message: /<number>-<slug>\.md/,
        });
      });
    }
  });

  it("allows digits in the slug", () => {
    expect(parseFragment("7-fix-2x-speed.md", fragmentText()).issue).toBe(7);
  });

  const file = `${CHANGELOG_FRAGMENTS_DIR}/1-a.md`;

  it("refuses a missing opening fence", () => {
    expectFragmentError(() => parseFragment("1-a.md", "category: Features\nweight: 5\n---\n\nText.\n"), {
      file,
      line: 1,
      message: /open with a "---"/,
    });
  });

  it("refuses a frontmatter that is never closed", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\nweight: 5\n"), {
      file,
      line: 3,
      message: /never closed/,
    });
  });

  it("refuses an unknown key", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\nweight: 5\nissue: 1\n---\n\nT.\n"), {
      file,
      line: 4,
      message: /unknown frontmatter key "issue"/,
    });
  });

  it("refuses a duplicated key, naming both lines", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\nweight: 5\ncategory: Features\nweight: 6\n---\n\nT.\n"), {
      file,
      line: 4,
      message: /"weight" appears twice \(first on line 2\)/,
    });
  });

  it("refuses a missing key, at the closing fence", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\n---\n\nT.\n"), {
      file,
      line: 3,
      message: /no "weight"/,
    });
    expectFragmentError(() => parseFragment("1-a.md", "---\nweight: 5\n---\n\nT.\n"), {
      file,
      line: 3,
      message: /no "category"/,
    });
  });

  it("refuses a line in the frontmatter that is not key: value, a blank line included", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\n\nweight: 5\n---\n\nT.\n"), {
      file,
      line: 3,
      message: /expected "key: value"/,
    });
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\n# a comment\nweight: 5\n---\n\nT.\n"), {
      file,
      line: 3,
      message: /expected "key: value"/,
    });
  });

  describe("refuses a category not spelled exactly as one of the five", () => {
    for (const category of ["Bug fixes", "bugfix", "Feature", "Breaking Changes", '"Features"', " "]) {
      it(JSON.stringify(category), () => {
        expectFragmentError(() => parseFragment("1-a.md", fragmentText({ category })), {
          file,
          line: 2,
          message: /unknown category/,
        });
      });
    }
  });

  describe("refuses a weight outside 1-100 or not a plain integer", () => {
    for (const weight of ["0", "101", "-5", "+5", "05", "5.0", "5.5", "1e1", "five", "", "1000"]) {
      it(JSON.stringify(weight), () => {
        expectFragmentError(() => parseFragment("1-a.md", fragmentText({ weight })), {
          file,
          line: 3,
          message: /whole number from 1 to 100/,
        });
      });
    }
  });

  it("refuses an empty body", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\nweight: 5\n---\n\n\n"), {
      file,
      line: null,
      message: /no body/,
    });
  });

  it("refuses a body of more than one line, naming the second", () => {
    expectFragmentError(() => parseFragment("1-a.md", "---\ncategory: Features\nweight: 5\n---\n\nOne.\n\nTwo.\n"), {
      file,
      line: 8,
      message: /must be one line.*after line 6/,
    });
  });

  describe("refuses a body that starts with a list marker", () => {
    for (const body of ["- Text.", "* Text.", "+ Text.", "1. Text.", "2) Text.", "-"]) {
      it(JSON.stringify(body), () => {
        expectFragmentError(() => parseFragment("1-a.md", fragmentText({ body })), {
          file,
          line: 6,
          message: /without its list marker/,
        });
      });
    }
  });

  describe("refuses a body that opens with block syntax, naming the opener", () => {
    for (const [body, opener, what] of [
      ["# Heading.", "#", "a heading"],
      ["### Heading.", "###", "a heading"],
      ["###### Heading.", "######", "a heading"],
      ["#", "#", "a heading"],
      ["> Quoted.", ">", "a blockquote"],
      [">Quoted.", ">", "a blockquote"],
      ["```", "```", "a fenced code block"],
      ["```js", "```", "a fenced code block"],
      ["````", "````", "a fenced code block"],
      ["~~~", "~~~", "a fenced code block"],
      ["~~~~ text", "~~~~", "a fenced code block"],
      ["***", "***", "a thematic break"],
      ["---", "---", "a thematic break"],
      ["___", "___", "a thematic break"],
      ["* * *", "* * *", "a thematic break"],
      ["- - -", "- - -", "a thematic break"],
      ["_ _ _", "_ _ _", "a thematic break"],
      ["-  -\t-  -", "-  -\t-  -", "a thematic break"],
      ["**********", "**********", "a thematic break"],
      ["[label]: /docs/actions/", "[label]:", "a link reference definition"],
      ["[Replay Control]:/docs/x", "[Replay Control]:", "a link reference definition"],
      ["[a\\]b]: /x", "[a\\]b]:", "a link reference definition"],
    ]) {
      it(JSON.stringify(body), () => {
        let caught;
        try {
          parseFragment("1-a.md", fragmentText({ body }));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ChangelogFragmentError);
        expect(caught.line).toBe(6);
        expect(caught.message).toContain(`must not open with "${opener}": ${what} cannot sit in a bullet`);
      });
    }
  });

  describe("accepts a body that only resembles block syntax", () => {
    for (const body of [
      "**Session Info** keys use less CPU.",
      "***Bold italic*** at the start.",
      "[Replay Control](/docs/actions/replay-control/) now seeks smoothly.",
      "[Replay Control](/docs/actions/replay-control/): now seeks smoothly.",
      "`code` first, then text.",
      "``two backticks`` are a code span.",
      "--- is not alone on this line.",
      "~~ two tildes are text.",
      "-- two dashes are text.",
      "__Strong__ start.",
      "#1234 is fixed.",
    ]) {
      it(JSON.stringify(body), () => {
        expect(parseFragment("1-a.md", fragmentText({ body })).body).toBe(body);
      });
    }
  });

  it("does not mistake an issue reference or seven hashes for a heading", () => {
    expect(parseFragment("1-a.md", fragmentText({ body: "#1234 is fixed." })).body).toBe("#1234 is fixed.");
    expect(parseFragment("1-a.md", fragmentText({ body: "####### Not a heading." })).body).toBe(
      "####### Not a heading.",
    );
  });

  it("does not mistake bold or a decimal for a list marker", () => {
    expect(parseFragment("1-a.md", fragmentText({ body: "**Bold** start." })).body).toBe("**Bold** start.");
    expect(parseFragment("1-a.md", fragmentText({ body: "1.5x speed now works." })).body).toBe("1.5x speed now works.");
  });

  it("refuses a body that starts with whitespace", () => {
    expectFragmentError(() => parseFragment("1-a.md", fragmentText({ body: "  Indented." })), {
      file,
      line: 6,
      message: /must not start with whitespace/,
    });
  });

  describe("refuses a bare < or { outside a code span", () => {
    for (const body of [
      "Set <name> here.",
      "Use {x} here.",
      "Both `ok` and <bad>.",
      "An unclosed `span <here.",
      "Bare { after `code`.",
    ]) {
      it(JSON.stringify(body), () => {
        expectFragmentError(() => parseFragment("1-a.md", fragmentText({ body })), {
          file,
          line: 6,
          message: /breaks the MDX build: wrap it in backticks/,
        });
      });
    }
  });

  // `CODE_SPAN` ignores backslash escapes, so without this refusal the `{name}`
  // below reads as code here while MDX reads it as a live expression (second read).
  it("refuses an escaped backtick, which would hide a bare { from the check above", () => {
    const body = `Press ${String.fromCharCode(92)}\`{name}\` now.`;
    expectFragmentError(() => parseFragment("1-a.md", fragmentText({ body })), {
      file,
      line: 6,
      message: /escaped backtick/,
    });
  });

  it("refuses inline markdown the pane cannot render, with renderInlineMarkdown's reason", () => {
    expectFragmentError(() => parseFragment("1-a.md", fragmentText({ body: "See [the docs](docs/page/)." })), {
      file,
      line: 6,
      message: /must start with "\/"/,
    });
  });
});

describe("sortFragments", () => {
  it("orders by category, then weight descending, then issue ascending, then file name by code unit", () => {
    const sorted = sortFragments([
      fragment("5-z.md", "Bug Fixes", 50),
      fragment("9-a.md", "Maintenance", 100),
      fragment("20-a.md", "Features", 10),
      fragment("3-b.md", "Features", 10),
      fragment("3-a.md", "Features", 10),
      fragment("3-B.md", "Features", 10),
      fragment("8-a.md", "Features", 90),
      fragment("1-a.md", "Improvements", 1),
    ]);

    expect(sorted.map((f) => f.fileName)).toEqual([
      "8-a.md", // Features, weight 90
      "3-B.md", // Features, weight 10, issue 3; "B" < "a" < "b" by code unit
      "3-a.md",
      "3-b.md",
      "20-a.md", // issue 20 after issue 3, although "20-a.md" < "3-a.md" as a string
      "1-a.md", // Improvements
      "5-z.md", // Bug Fixes
      "9-a.md", // Maintenance
    ]);
  });

  it("breaks a weight tie on the issue number before the file name", () => {
    // "20-…" sorts before "3-…" as a string, so only the issue tie-break puts 3 first.
    const sorted = sortFragments([fragment("20-a.md", "Features", 50), fragment("3-z.md", "Features", 50)]);
    expect(sorted.map((f) => f.issue)).toEqual([3, 20]);
  });

  it("does not use a locale-aware comparison for the file name", () => {
    // localeCompare puts "1-a.md" before "1-B.md"; code-unit order puts "B" first.
    const sorted = sortFragments([fragment("1-a.md", "Features", 50), fragment("1-B.md", "Features", 50)]);
    expect(sorted.map((f) => f.fileName)).toEqual(["1-B.md", "1-a.md"]);
  });

  it("gives the same order for every shuffle of the input", () => {
    const input = [];
    let n = 0;
    for (const category of CHANGELOG_CATEGORIES) {
      for (const weight of [100, 50, 50, 1]) {
        for (const issue of [7, 7, 30]) {
          n++;
          input.push(fragment(`${issue}-f${n}.md`, category, weight));
        }
      }
    }
    const expected = sortFragments(input).map((f) => f.fileName);

    // A small deterministic PRNG, so a failure reproduces.
    let seed = 1386;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 50; round++) {
      const shuffled = [...input];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(sortFragments(shuffled).map((f) => f.fileName)).toEqual(expected);
    }
  });

  it("returns a new array and leaves the input alone", () => {
    const input = [fragment("2-a.md", "Features", 1), fragment("1-a.md", "Features", 100)];
    const before = [...input];
    const sorted = sortFragments(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual(before);
  });

  it("refuses an unknown category, naming the fragment", () => {
    expectFragmentError(() => sortFragments([fragment("1-a.md", "Fixes", 1), fragment("2-a.md", "Features", 1)]), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/1-a.md`,
      line: null,
      message: /unknown category "Fixes"/,
    });
  });
});

describe("renderReleaseSection", () => {
  it("writes the heading, the date line, and each category with fragments in the fixed order", () => {
    const section = renderReleaseSection("2.0.0", "_Unreleased_", [
      fragment("4-fix.md", "Bug Fixes", 10, "A fix."),
      fragment("2-feat.md", "Features", 10, "A feature."),
      fragment("3-fix.md", "Bug Fixes", 90, "A bigger fix."),
    ]);

    expect(section).toBe(`## 2.0.0

_Unreleased_

**Features**

- A feature.

**Bug Fixes**

- A bigger fix.
- A fix.
`);
  });

  it("parses cleanly with the real changelog parser", () => {
    const fragments = CHANGELOG_CATEGORIES.map((category, i) => fragment(`${i + 1}-x.md`, category, 50));
    const { releases } = parseChangelog(`${PREAMBLE}${renderReleaseSection("2.0.0", "_2026-10-10_", fragments)}`);

    expect(releases).toEqual([
      {
        version: "2.0.0",
        date: "2026-10-10",
        categories: CHANGELOG_CATEGORIES.map((title, i) => ({ title, items: [`Bullet of ${i + 1}-x.md.`] })),
      },
    ]);
  });

  it("refuses an empty fragment list, a non-plain version and a malformed date line", () => {
    expect(() => renderReleaseSection("2.0.0", "_Unreleased_", [])).toThrow(/no fragments/);
    expect(() => renderReleaseSection("2.0.0-dev.0", "_Unreleased_", [fragment("1-a.md", "Features", 1)])).toThrow(
      /plain X\.Y\.Z/,
    );
    expect(() => renderReleaseSection("2.0.0", "2026-10-10", [fragment("1-a.md", "Features", 1)])).toThrow(/date line/);
  });
});

describe("composeChangelog", () => {
  const mdx = `${PREAMBLE}${DATED}`;
  const fragments = [fragment("10-feat.md", "Features", 50, "A new feature."), fragment("11-fix.md", "Bug Fixes", 50)];

  it("inserts the section before the first ## heading, leaving the rest byte for byte", () => {
    const composed = composeChangelog(mdx, fragments, "1.3.0", "_Unreleased_");

    expect(composed).toBe(`${PREAMBLE}${renderReleaseSection("1.3.0", "_Unreleased_", fragments)}\n${DATED}`);
    expect(parseChangelog(composed).releases.map((r) => [r.version, r.date])).toEqual([
      ["1.3.0", null],
      ["1.2.0", "2026-01-02"],
      ["1.1.0", "2025-12-01"],
    ]);
  });

  it("writes the real date when folding", () => {
    const composed = composeChangelog(mdx, fragments, "1.3.0", "_2026-10-10_");
    expect(parseChangelog(composed).releases[0]).toMatchObject({ version: "1.3.0", date: "2026-10-10" });
  });

  it("returns the MDX unchanged when there are no fragments", () => {
    expect(composeChangelog(mdx, [], "1.3.0", "_Unreleased_")).toBe(mdx);
  });

  it("keeps CRLF line endings when the MDX has them", () => {
    const crlf = mdx.replace(/\n/g, "\r\n");
    const composed = composeChangelog(crlf, fragments, "1.3.0", "_Unreleased_");
    expect(composed).toBe(composeChangelog(mdx, fragments, "1.3.0", "_Unreleased_").replace(/\n/g, "\r\n"));
  });

  describe("refuses a leftover _Unreleased_ line in changelog.mdx", () => {
    const withUnreleased = mdx.replace("_2026-01-02_", "_Unreleased_");
    const expected = {
      file: CHANGELOG_SOURCE_PATH,
      line: PREAMBLE.split("\n").length + 2,
      message: /"_Unreleased_" left in changelog\.mdx/,
    };

    it("while fragments exist", () => {
      expectFragmentError(() => composeChangelog(withUnreleased, fragments, "1.3.0", "_Unreleased_"), expected);
    });

    it("with no fragments, where a hand-written section would otherwise pass silently", () => {
      expectFragmentError(() => composeChangelog(withUnreleased, [], "1.3.0", "_Unreleased_"), expected);
    });

    it("through its own export, for a reader with nothing to compose", () => {
      expectFragmentError(() => assertNoInDevelopmentSection(withUnreleased), expected);
      expect(() => assertNoInDevelopmentSection(mdx)).not.toThrow();
    });
  });

  it("allows the version's own dated section when there are no fragments, as on a release commit", () => {
    expect(composeChangelog(mdx, [], "1.2.0", "_Unreleased_")).toBe(mdx);
  });

  it("refuses an existing section for the in-development version while fragments exist", () => {
    expectFragmentError(() => composeChangelog(mdx, fragments, "1.2.0", "_Unreleased_"), {
      file: CHANGELOG_SOURCE_PATH,
      line: PREAMBLE.split("\n").length,
      message: /"## 1\.2\.0" section already exists/,
    });
  });

  it("refuses a fragment whose bullet repeats a dated bullet, naming the fragment and the dated line", () => {
    const duplicate = [...fragments, fragment("12-cherry-pick.md", "Bug Fixes", 50, "An old fix.")];
    expectFragmentError(() => composeChangelog(mdx, duplicate, "1.3.0", "_Unreleased_"), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/12-cherry-pick.md`,
      line: null,
      message: new RegExp(
        `already in a released section \\(.*changelog\\.mdx line ${PREAMBLE.split("\n").length + 10}\\)`,
      ),
    });
  });

  it("refuses two fragments with the same bullet, naming both files", () => {
    const twins = [
      fragment("10-feat.md", "Features", 50, "A new feature."),
      fragment("14-copy.md", "Bug Fixes", 20, "A new feature."),
    ];
    expectFragmentError(() => composeChangelog(mdx, twins, "1.3.0", "_Unreleased_"), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/14-copy.md`,
      line: null,
      message: new RegExp(`same as ${CHANGELOG_FRAGMENTS_DIR}/10-feat\\.md`),
    });
    // Positive control: the same two files with different bullets compose.
    expect(() =>
      composeChangelog(mdx, [twins[0], { ...twins[1], body: "A different fix." }], "1.3.0", "_Unreleased_"),
    ).not.toThrow();
  });

  it("does not count the preamble's text as a dated bullet", () => {
    const composed = composeChangelog(
      mdx,
      [fragment("13-a.md", "Features", 1, "Release notes for each version of iRaceDeck.")],
      "1.3.0",
      "_Unreleased_",
    );
    expect(parseChangelog(composed).releases[0].version).toBe("1.3.0");
  });
});

describe("composeChangelogParts", () => {
  const mdx = `${PREAMBLE}${DATED}`;
  const fragments = [fragment("10-feat.md", "Features", 50, "A new feature."), fragment("11-fix.md", "Bug Fixes", 50)];

  it("returns composeChangelog's content and the section renderReleaseSection writes", () => {
    expect(composeChangelogParts(mdx, fragments, "1.3.0", "_Unreleased_")).toEqual({
      content: composeChangelog(mdx, fragments, "1.3.0", "_Unreleased_"),
      section: renderReleaseSection("1.3.0", "_Unreleased_", fragments),
    });
  });

  it("keeps the section in LF when the MDX is CRLF", () => {
    const parts = composeChangelogParts(mdx.replace(/\n/g, "\r\n"), fragments, "1.3.0", "_Unreleased_");
    expect(parts.section).toBe(renderReleaseSection("1.3.0", "_Unreleased_", fragments));
    expect(parts.content).toContain(parts.section.replace(/\n/g, "\r\n"));
  });

  it("returns the MDX and a null section with no fragments", () => {
    expect(composeChangelogParts(mdx, [], "1.3.0", "_Unreleased_")).toEqual({ content: mdx, section: null });
  });

  it("runs every compose-time check", () => {
    expect(() => composeChangelogParts(mdx, fragments, "1.2.0", "_Unreleased_")).toThrow(/already exists/);
    expect(() =>
      composeChangelogParts(mdx.replace("_2026-01-02_", "_Unreleased_"), [], "1.3.0", "_Unreleased_"),
    ).toThrow(/"_Unreleased_" left/);
  });
});

describe("the real changelog", () => {
  const realMdx = readFileSync(path.join(REPO_ROOT, CHANGELOG_SOURCE_PATH), "utf8");
  const { releases } = parseChangelog(realMdx);
  const headingOffsets = [...realMdx.matchAll(/^## .*$/gm)].map((match) => match.index);

  /** The text of release `i`, from its heading up to the next one. */
  const sectionText = (i) => realMdx.slice(headingOffsets[i], headingOffsets[i + 1] ?? realMdx.length);

  /** Turn a parsed release into fragment files, weights descending in the present order, and parse them. */
  const toFragments = (release) => {
    let n = 0;
    return release.categories.flatMap((category) =>
      category.items.map((item, index) => {
        n++;
        return parseFragment(
          `${n}-${release.version.replace(/\./g, "-")}.md`,
          `---\ncategory: ${category.title}\nweight: ${100 - index}\n---\n\n${item}\n`,
        );
      }),
    );
  };

  // Two old sections predate the layout the composer writes; nothing will ever
  // re-render them (the spec leaves past releases alone).
  const IRREGULAR = new Map([
    ["3.1.0", "a stray blank line inside its Bug Fixes list and none before Maintenance"],
    ["0.13.0", "no date line"],
  ]);

  it("has one heading per parsed release", () => {
    expect(headingOffsets).toHaveLength(releases.length);
  });

  it("every regular section, turned into fragments in its present order, re-renders byte for byte", () => {
    let checked = 0;
    releases.forEach((release, i) => {
      if (IRREGULAR.has(release.version)) return;
      const dateLine = release.date === null ? "_Unreleased_" : `_${release.date}_`;
      const expected = sectionText(i);
      // Every section but the last is followed by the blank line before the next heading.
      const rendered = renderReleaseSection(release.version, dateLine, toFragments(release));
      expect(i + 1 < releases.length ? `${rendered}\n` : rendered, release.version).toBe(expected);
      checked++;
    });
    expect(checked).toBe(releases.length - IRREGULAR.size);
  });

  it("the top section, taken out and composed back from fragments, gives the file byte for byte", () => {
    // Today this is the in-development 3.6.0 section the migration turns into
    // fragments; after the migration it is the newest dated release.
    const top = releases[0];
    const dateLine = top.date === null ? "_Unreleased_" : `_${top.date}_`;
    const withoutTop = realMdx.slice(0, headingOffsets[0]) + realMdx.slice(headingOffsets[1]);

    expect(composeChangelog(withoutTop, toFragments(top), top.version, dateLine)).toBe(realMdx);
  });

  it("the real tree loads, composes and parses", () => {
    const { mdx, fragments, version } = loadChangelogSources(REPO_ROOT);
    const composed = composeChangelog(mdx, fragments, version, "_Unreleased_");
    const parsed = parseChangelog(composed);

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    if (fragments.length > 0) expect(parsed.releases[0].version).toBe(version);
  });
});

describe("loadChangelogSources", () => {
  let root;

  const write = (relative, text) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "changelog-fragments-"));
    write(CHANGELOG_SOURCE_PATH, `${PREAMBLE}${DATED}`);
    write("package.json", JSON.stringify({ version: "1.3.0-dev.2" }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/README.md`, "# Not a fragment\n\nAnything goes here: <b>{x}</b>\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the MDX, the sorted fragments and the version with its suffix stripped, skipping the README", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/20-later.md`, fragmentText({ category: "Features", weight: "10", body: "B." }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/3-earlier.md`, fragmentText({ category: "Features", weight: "10", body: "A." }));
    write(`${CHANGELOG_FRAGMENTS_DIR}/7-fix.md`, fragmentText({ category: "Bug Fixes", weight: "99", body: "C." }));

    const sources = loadChangelogSources(root);

    expect(sources.mdx).toBe(`${PREAMBLE}${DATED}`);
    expect(sources.version).toBe("1.3.0");
    expect(sources.fragments.map((f) => f.fileName)).toEqual(["3-earlier.md", "20-later.md", "7-fix.md"]);
  });

  it("reads a stable version as it is, and an empty directory as no fragments", () => {
    write("package.json", JSON.stringify({ version: "1.3.0" }));
    const sources = loadChangelogSources(root);
    expect(sources.version).toBe("1.3.0");
    expect(sources.fragments).toEqual([]);
  });

  it("refuses a mis-named fragment", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/1345.bugfix.md`, fragmentText());
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/1345.bugfix.md`,
      line: null,
      message: /<number>-<slug>\.md/,
    });
  });

  describe("skips editor and OS litter", () => {
    for (const name of [".1345-x.md.swp", "1345-x.md~", ".DS_Store", "Thumbs.db", "desktop.ini", "Desktop.ini"]) {
      it(name, () => {
        write(`${CHANGELOG_FRAGMENTS_DIR}/7-fix.md`, fragmentText({ body: "C." }));
        // Not a fragment's text, so reading it as one would fail.
        write(`${CHANGELOG_FRAGMENTS_DIR}/${name}`, "\u0000 binary-ish litter <{");

        expect(loadChangelogSources(root).fragments.map((f) => f.fileName)).toEqual(["7-fix.md"]);
      });
    }

    it("skips a dot-directory too", () => {
      mkdirSync(path.join(root, CHANGELOG_FRAGMENTS_DIR, ".vscode"));
      expect(loadChangelogSources(root).fragments).toEqual([]);
    });
  });

  it("isFragmentDirLitter recognises only the litter shapes", () => {
    for (const name of [".x", ".DS_Store", "x~", "THUMBS.DB", "desktop.ini"])
      expect(isFragmentDirLitter(name)).toBe(true);
    for (const name of ["README.md", "1-a.md", "1345.bugfix.md", "notes.txt", "Thumbs.db.md", "a~b.md"]) {
      expect(isFragmentDirLitter(name)).toBe(false);
    }
  });

  it("still refuses a mis-named .md beside the litter", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/.DS_Store`, "litter");
    write(`${CHANGELOG_FRAGMENTS_DIR}/Session-Info.md`, fragmentText());
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/Session-Info.md`,
      line: null,
      message: /<number>-<slug>\.md/,
    });
  });

  it("refuses a stray file that is not a fragment", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/notes.txt`, "scratch");
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/notes.txt`,
      line: null,
    });
  });

  it("refuses a subdirectory", () => {
    mkdirSync(path.join(root, CHANGELOG_FRAGMENTS_DIR, "1-dir.md"));
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/1-dir.md`,
      line: null,
      message: /only fragments and README\.md/,
    });
  });

  it("refuses an invalid fragment, naming its line", () => {
    write(`${CHANGELOG_FRAGMENTS_DIR}/4-bad.md`, fragmentText({ weight: "0" }));
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/4-bad.md`,
      line: 3,
      message: /whole number from 1 to 100/,
    });
  });

  it("refuses a missing fragment directory", () => {
    rmSync(path.join(root, CHANGELOG_FRAGMENTS_DIR), { recursive: true });
    expectFragmentError(() => loadChangelogSources(root), {
      file: `${CHANGELOG_FRAGMENTS_DIR}/`,
      line: null,
      message: /cannot read the fragment directory/,
    });
  });

  it("refuses a root version that is not X.Y.Z", () => {
    write("package.json", JSON.stringify({ version: "next" }));
    expectFragmentError(() => loadChangelogSources(root), { file: "package.json", line: null });
  });
});
