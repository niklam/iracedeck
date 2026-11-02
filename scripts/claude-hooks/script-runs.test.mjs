import { describe, expect, it } from "vitest";

import { shellQuote } from "./script-runs.mjs";
import { maskInert, shellWords } from "./shell-lexer.mjs";

describe("helpers", () => {
  // A runner's forwarded words are appended to a script's line through
  // shellQuote and read back through shellWords; each must come back whole
  // (#1526 review: a word with both quote kinds came back unbalanced).
  it.each(["plain", "two words", "it's", 'say "hi"', `a"b'c`, `'"'"'`, "$R", "`x`", "a\\b", "", "--restart"])(
    "shellQuote quotes a word so the deck rule reads it back as that one word: %s",
    (w) => {
      const quoted = shellQuote(w);
      expect(shellWords(quoted)).toEqual([w]);
      expect(maskInert(quoted).sure).toBe(true);
      expect(shellWords(`${quoted} --restart`)).toEqual([w, "--restart"]);
    },
  );
});
