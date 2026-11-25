import { describe, expect, it } from "vitest";

import { missingSpecParts } from "./spec-sections.mjs";

describe("the required sections", () => {
  const HEADER = "> **Issue:** [#9](u) · **Supersedes:** _none_ · **Superseded by:** _none_";

  // #1391: a heading counts when it IS the section, not when it mentions the word.
  describe("a heading counts only when it is the section", () => {
    it("accepts every Testing spelling, with a number, a qualifier or a second name", () => {
      for (const h of [
        "## Testing",
        "## Tests",
        "## Test",
        "## Verification",
        "## Verify",
        "## Manual verification",
        "## Manual testing",
        "## Manual test plan",
        "## Testing strategy",
        "### Unit tests",
        "### Integration tests",
        "### Build verification",
        "## 5. Testing",
        "## 7 Testing",
        "## 8.1. Tests",
        "## Testing (TDD)",
        "## Tests (`car-control.test.ts`)",
        "## Verification — results (2026-07-09)",
        "## Verification – results",
        "## Testing - by hand",
        "## Testing & verification",
        "## Testing and Verification",
        "## Unit and integration tests",
        "## Code and tests",
        "## Testing:",
        "## Testing ##",
        "## **Testing**",
        "## _Verification_",
        "**Manual verification**",
        "**Testing:**",
        "**Unit tests, one per rule:**",
        "**Manual test, per slice, by the maintainer:**",
        "## TESTING",
      ])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", h, "y"].join("\n\n")), h).toEqual([]);
    });
    it("accepts every Out of scope spelling, with a number, a qualifier or a second name", () => {
      for (const h of [
        "## Out of scope",
        "## Out of Scope",
        "## Non-goals",
        "## Non-goal",
        "## Not in scope",
        "## What this deliberately does not do",
        "### What this deliberately does not cover",
        "### 8. Out of scope",
        "## Out of scope / non-goals",
        "## Notes / non-goals",
        "## Out of scope (for now)",
        "## Out of scope — tracked separately",
        "**Out of scope:**",
      ])
        expect(missingSpecParts([HEADER, "# T", h, "x", "## Testing", "y"].join("\n\n")), h).toEqual([]);
    });
    it("accepts the other names a test section goes by", () => {
      for (const h of [
        "## How to test",
        "## How to verify",
        "## How it was verified",
        "## Regression tests",
        "## Hardware testing",
        "## Sim testing",
        "## In-sim verification",
        "## End-to-end tests",
        "## Acceptance tests",
        "## Testing #1391",
        "## Tests (`f(x)` and `g(y)`)",
        "## ***Testing***",
        "   ## Testing",
      ])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", h, "y"].join("\n\n")), h).toEqual([]);
    });
    it("accepts the variants of What this deliberately does not do", () => {
      for (const h of [
        "## What this change deliberately does not do",
        "## What this spec does not cover",
        "## What we deliberately do not do",
        "## What it does not change",
      ])
        expect(missingSpecParts([HEADER, "# T", h, "x", "## Testing", "y"].join("\n\n")), h).toEqual([]);
    });
    it("counts a heading that names both sections as both", () => {
      for (const h of ["## Out of scope and testing", "## Testing / non-goals"])
        expect(missingSpecParts([HEADER, "# T", h, "x"].join("\n\n")), h).toEqual([]);
    });
    it("does not read a heading inside an HTML comment, closed or not", () => {
      for (const tail of ["<!--\n## Testing\n-->", "<!-- placeholder\n\n## Testing", "  <!--\n## Testing\n-->"])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", tail].join("\n\n")), tail).toEqual([
          "a Testing or Verification section",
        ]);
      expect(
        missingSpecParts([HEADER, "# T", "## Out of scope", "<!-- note -->", "## Testing", "y"].join("\n\n")),
      ).toEqual([]);
    });
    it("does not read a heading inside a fence that never closes, or one closed only by an info-string line", () => {
      for (const tail of [
        "```bash\npnpm build\n\n## Testing",
        "```\ncode\n```js\n## Testing\n```",
        "   ~~~\n## Testing",
      ])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", tail].join("\n\n")), tail).toEqual([
          "a Testing or Verification section",
        ]);
    });
    // The second read of #1391: each is text CommonMark does not render as a heading.
    it("does not read the rest of a comment's closing line, or a fence or comment opened in a list item", () => {
      for (const tail of [
        "<!-- TODO --> ## Testing",
        "<!--\ndraft\n--> ## Testing",
        "<!-- x -->**Testing**",
        "- ```markdown\n  ## Testing\n  ```",
        "1. <!--\n   ## Testing\n   -->",
        "```bash\n```~\n## Testing\n```",
      ])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", tail].join("\n\n")), tail).toEqual([
          "a Testing or Verification section",
        ]);
    });
    // CodeRabbit on PR #1610: indentation is judged against the container.
    it("takes a top-level fence indented four spaces for indented code, in either direction", () => {
      expect(missingSpecParts([HEADER, "# T", "## Out of scope", "    ```", "## Testing", "y"].join("\n\n"))).toEqual(
        [],
      );
      expect(
        missingSpecParts([HEADER, "# T", "## Out of scope", "```\n    ```\n## Testing\n```"].join("\n\n")),
      ).toEqual(["a Testing or Verification section"]);
    });
    it("opens and closes a fence indented to its list item", () => {
      expect(
        missingSpecParts(
          [HEADER, "# T", "## Out of scope", "1. Build:", "    ```bash\n    ## Testing\n    ```"].join("\n\n"),
        ),
      ).toEqual(["a Testing or Verification section"]);
      expect(
        missingSpecParts(
          [HEADER, "# T", "## Out of scope", "1. Build:", "    ```bash\n    pnpm build\n    ```", "## Testing"].join(
            "\n\n",
          ),
        ),
      ).toEqual([]);
      expect(
        missingSpecParts([HEADER, "# T", "## Out of scope", "- item", "x", "    ```", "## Testing"].join("\n\n")),
      ).toEqual([]);
    });
    // CodeRabbit on PR #1610 (and the second read, upheld as a decline before the scanner made it cheap).
    it("ends a fence or comment opened in a list item when the item ends, closed or not", () => {
      for (const block of ["- ```\n  example", "1. Build:\n\n   ```bash\n   pnpm build", "- <!--\n  note"])
        expect(
          missingSpecParts([HEADER, "# T", "## Out of scope", "x", `${block}\n## Testing`, "y"].join("\n\n")),
          block,
        ).toEqual([]);
      // Still inside the item: a blank line and a line indented to it are the block's.
      expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", "- ```\n\n  ## Testing\n"].join("\n\n"))).toEqual(
        ["a Testing or Verification section"],
      );
      // A top-level fence never ends early.
      expect(
        missingSpecParts([HEADER, "# T", "## Out of scope", "x", "```\nexample\n## Testing"].join("\n\n")),
      ).toEqual(["a Testing or Verification section"]);
    });
    it("ends a comment at an empty <!--> and takes a backtick line with a backtick in it for prose", () => {
      for (const before of ["<!-->", "<!--->", "```js``` is inline"])
        expect(
          missingSpecParts([HEADER, "# T", "## Out of scope", before, "## Testing", "y"].join("\n\n")),
          before,
        ).toEqual([]);
    });
    it("accepts a test section named with a closing noun or carrying inline HTML", () => {
      for (const h of [
        "## Testing approach",
        "## Verification steps",
        "## Test cases",
        "## Testing <!-- TODO -->",
        '## Testing <a id="testing"></a>',
      ])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", h, "y"].join("\n\n")), h).toEqual([]);
    });
    it("reads line endings as CommonMark does: a bare CR ends a line, a line separator does not", () => {
      expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", "## Testing", "y"].join("\r\r"))).toEqual([]);
      expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", "```\r## Testing\r```"].join("\r\r"))).toEqual([
        "a Testing or Verification section",
      ]);
      for (const sep of [String.fromCharCode(0x2028), String.fromCharCode(0x2029)])
        expect(missingSpecParts([HEADER, "# T", "## Out of scope", `x${sep}## Testing`].join("\n\n"))).toEqual([
          "a Testing or Verification section",
        ]);
    });
    it("reads a heading with CRLF line endings", () =>
      expect(missingSpecParts([HEADER, "# T", "## Out of scope ", "x", "## Testing", "y"].join("\r\n\r\n"))).toEqual(
        [],
      ));
    it("does not read a heading across a line break", () =>
      expect(missingSpecParts([HEADER, "# T", "## Out of scope", "x", "##\nTesting"].join("\n\n"))).toEqual([
        "a Testing or Verification section",
      ]));
  });
});
