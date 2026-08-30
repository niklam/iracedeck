import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import { GettingStartedParseError, parseGettingStarted } from "./getting-started-parse.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REAL_PAGE = path.resolve(__dirname, "../../packages/website/src/content/docs/docs/getting-started/first-steps.md");

/** The Starlight frontmatter every real page carries, which the parser must skip. */
const FRONTMATTER = `---
title: First Steps
description: What to do first.
---

`;

describe("parseGettingStarted", () => {
  it("skips the frontmatter and collects sections", () => {
    const { sections } = parseGettingStarted(`${FRONTMATTER}## One

First paragraph.

## Two

Second paragraph.
`);

    expect(sections.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(sections[0].blocks).toEqual([{ type: "paragraph", text: "First paragraph." }]);
  });

  it("parses a page with no frontmatter at all", () => {
    const { sections } = parseGettingStarted("## Only\n\nText.\n");

    expect(sections).toHaveLength(1);
  });

  it("folds consecutive prose lines into one paragraph", () => {
    const { sections } = parseGettingStarted(`## S

One line
and its continuation.

A second paragraph.
`);

    expect(sections[0].blocks).toEqual([
      { type: "paragraph", text: "One line and its continuation." },
      { type: "paragraph", text: "A second paragraph." },
    ]);
  });

  it("collects consecutive bullets into one list", () => {
    const { sections } = parseGettingStarted(`## S

- first
- second

- third
`);

    expect(sections[0].blocks).toEqual([
      { type: "list", items: ["first", "second"] },
      { type: "list", items: ["third"] },
    ]);
  });

  it("separates a list from prose that touches it, with no blank line between", () => {
    const { sections } = parseGettingStarted(`## S

Intro:
- first
More prose.
`);

    expect(sections[0].blocks).toEqual([
      { type: "paragraph", text: "Intro:" },
      { type: "list", items: ["first"] },
      { type: "paragraph", text: "More prose." },
    ]);
  });

  it("reads an action marker as its own block", () => {
    const { sections } = parseGettingStarted(`## S

Prose.

<!-- ird:action open-profiles-tab -->

More prose.
`);

    expect(sections[0].blocks[1]).toEqual({ type: "action", id: "open-profiles-tab" });
  });

  it("reads an action marker that directly abuts prose", () => {
    const { sections } = parseGettingStarted("## S\n\nProse.\n<!-- ird:action enable-race-engineer -->\n");

    expect(sections[0].blocks).toEqual([
      { type: "paragraph", text: "Prose." },
      { type: "action", id: "enable-race-engineer" },
    ]);
  });

  describe("rejects what the pane cannot render", () => {
    const cases = [
      ["a heading of another level", "### Too deep"],
      ["a heading of another level", "# Too shallow"],
      ["a blockquote", "> quoted"],
      ["a table", "| a | b |"],
      ["a code fence", "```js"],
      ["a numbered list", "1. first"],
      ["an image", "![alt](/x.png)"],
    ];

    it.each(cases)("%s", (_what, line) => {
      expect(() => parseGettingStarted(`## S\n\n${line}\n`)).toThrow(GettingStartedParseError);
    });

    it("names the line number", () => {
      expect(() => parseGettingStarted("## S\n\nfine\n\n> quoted\n")).toThrow(/line 5/);
    });
  });

  it("rejects a comment that is not an action marker", () => {
    // A typo'd marker is invisible on the website AND absent from the pane, so
    // it would never be noticed. That is the whole reason this throws.
    expect(() => parseGettingStarted("## S\n\n<!-- ird:actoin oops -->\n")).toThrow(/not an .*ird:action.* marker/);
  });

  it("rejects an action id that is not a plain slug", () => {
    expect(() => parseGettingStarted("## S\n\n<!-- ird:action Open_Profiles -->\n")).toThrow(GettingStartedParseError);
  });

  it("rejects content before the first heading", () => {
    expect(() => parseGettingStarted(`${FRONTMATTER}Stray prose.\n\n## S\n\nText.\n`)).toThrow(
      /content before the first/,
    );
  });

  it("rejects a page with no sections", () => {
    expect(() => parseGettingStarted(FRONTMATTER)).toThrow(/no .*sections/);
  });

  it("rejects an empty section, wherever it sits", () => {
    expect(() => parseGettingStarted("## Empty\n\n## Next\n\nText.\n")).toThrow(/section "Empty" has no content/);
    expect(() => parseGettingStarted("## First\n\nText.\n\n## Empty\n")).toThrow(/section "Empty" has no content/);
  });

  it("rejects frontmatter that is never closed", () => {
    expect(() => parseGettingStarted("---\ntitle: x\n\n## S\n\nText.\n")).toThrow(/never closed/);
  });

  it("tolerates CRLF line endings", () => {
    const { sections } = parseGettingStarted("## S\r\n\r\n- item\r\n");

    expect(sections[0].blocks).toEqual([{ type: "list", items: ["item"] }]);
  });
});

describe("the real Getting Started page", () => {
  // The point of this test: it makes the grammar a build gate rather than a
  // convention, exactly as changelog-parse.test.mjs does for the changelog.
  it("parses, and every section has content", () => {
    const { sections } = parseGettingStarted(readFileSync(REAL_PAGE, "utf-8"));

    expect(sections.length).toBeGreaterThan(0);

    for (const section of sections) {
      expect(section.blocks.length, `section "${section.title}" is empty`).toBeGreaterThan(0);
    }
  });

  it("never lets a sentence depend on a control", () => {
    // Action markers render as NOTHING on the website — they are HTML comments.
    // So a paragraph that introduces one ("press the button below") is a
    // dangling promise to every website reader. The rule is that a marker is
    // garnish after a paragraph that stands alone; this pins it, because the
    // failure is invisible on the surface where it happens.
    const { sections } = parseGettingStarted(readFileSync(REAL_PAGE, "utf-8"));
    const forwardReference = /\b(below|following|button below|here)\s*[:.]?\s*$/i;

    for (const section of sections) {
      section.blocks.forEach((block, i) => {
        const next = section.blocks[i + 1];

        if (block.type !== "paragraph" || next?.type !== "action") return;

        expect(forwardReference.test(block.text), `"${section.title}" leans on the control after it: ${block.text}`).toBe(
          false,
        );
      });
    }
  });
});
