import { describe, expect, it } from "vitest";

import { readSupportPartialConstants } from "./support-partial-constants.js";

/** A partial of the real one's shape: a comment, the scriptlet, then markup that uses it. */
function partial(scriptlet: string): string {
  return [
    "<%#",
    '  Each stays a one-line `var NAME = "…";`.',
    "%>",
    "<%",
    scriptlet,
    "-%>",
    '<a href="<%= SUPPORT_URL %>">Support</a>',
  ].join("\n");
}

const TWO = ['  var SUPPORT_URL = "https://example.com/a";', '  var IMAGE_URL = "https://example.com/i?a=1&b=2";'].join(
  "\n",
);

describe("readSupportPartialConstants", () => {
  it("reads every declaration in the leading scriptlet, as written", () => {
    expect(readSupportPartialConstants(partial(TWO))).toEqual({
      SUPPORT_URL: "https://example.com/a",
      IMAGE_URL: "https://example.com/i?a=1&b=2",
    });
  });

  it("reads the same from a file checked out with CRLF line endings", () => {
    expect(readSupportPartialConstants(partial(TWO).replaceAll("\n", "\r\n"), ["IMAGE_URL"]).IMAGE_URL).toBe(
      "https://example.com/i?a=1&b=2",
    );
  });

  it("reads past the comment that describes the shape, and other code in the scriptlet", () => {
    // The comment's own `var NAME = "…";` is prose, not a declaration.
    const constants = readSupportPartialConstants(partial(`${TWO}\n  // var OLD_URL = "https://example.com/old";`));

    expect(Object.keys(constants)).toEqual(["SUPPORT_URL", "IMAGE_URL"]);
  });

  it("accepts the whitespace-slurping delimiters", () => {
    const source = '<%_ var A = "1"; _%>\n<p><%= A %></p>';

    expect(readSupportPartialConstants(source, ["A"])).toEqual({ A: "1" });
  });

  it("throws, naming it, when a required name is not declared", () => {
    expect(() => readSupportPartialConstants(partial(TWO), ["SUPPORT_URL", "MEMBERSHIP_URL"])).toThrow(
      /does not declare MEMBERSHIP_URL/,
    );
  });

  it("throws when a name is declared twice", () => {
    const twice = `${TWO}\n  var SUPPORT_URL = "https://example.com/b";`;

    expect(() => readSupportPartialConstants(partial(twice))).toThrow(/declares SUPPORT_URL 2 times/);
  });

  it("throws when a name is declared again outside the leading scriptlet", () => {
    const source = `${partial(TWO)}\n<% var IMAGE_URL = other; %>`;

    expect(() => readSupportPartialConstants(source)).toThrow(/declares IMAGE_URL 2 times/);
  });

  it("does not take a longer name for a second declaration of a shorter one", () => {
    const source = partial(`${TWO}\n  var SUPPORT_URL_OLD = "https://example.com/old";`);

    expect(readSupportPartialConstants(source, ["SUPPORT_URL"]).SUPPORT_URL).toBe("https://example.com/a");
  });

  it.each([
    ["single quotes", "  var SUPPORT_URL = 'https://example.com/a';"],
    ["a value built from pieces", '  var SUPPORT_URL = "https://example.com/" + slug;'],
    ["a value over two lines", '  var SUPPORT_URL =\n    "https://example.com/a";'],
    ["an escape in the value", '  var SUPPORT_URL = "https://example.com/\\u0061";'],
    ["two declarations on a line", '  var SUPPORT_URL = "a"; var OTHER = "b";'],
  ])("throws on a declaration that is not the one-line shape: %s", (_what, line) => {
    expect(() => readSupportPartialConstants(partial(line))).toThrow(/not a one-line/);
  });

  it("throws when there is no scriptlet to read", () => {
    expect(() => readSupportPartialConstants("<%# only a comment %>\n<p><%= SUPPORT_URL %></p>")).toThrow(/no leading/);
  });
});
