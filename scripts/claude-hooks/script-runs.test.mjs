import path from "node:path";
import { describe, expect, it } from "vitest";

import { deckFindings, shellQuote } from "./script-runs.mjs";
import { BASH, maskInert, POWERSHELL, shellWords } from "./shell-lexer.mjs";

// Built through `path`, not written as Windows literals: CI runs on Linux, where
// `C:\repo\master` is a RELATIVE path and every resolve lands under the runner's cwd.
const ROOT = path.resolve("/repo/ir-5");

/**
 * The injected context `deckFindings` reads, over one package.json at the
 * tree's root. The deck-host rule's own cases, through `checkBash`, are in
 * `rules-bash.test.mjs`; these pin the module's seam.
 */
function ctx(scripts, overrides = {}) {
  const isInside = (c, p) => c === p || c.startsWith(p + path.sep);
  return {
    linkTargets: () => [],
    scriptsAt: (dir) => (isInside(dir, ROOT) ? { dir: ROOT, name: "root", scripts } : undefined),
    workspaceDirs: () => [],
    toplevel: () => ROOT,
    isInside,
    ...overrides,
  };
}

describe("deckFindings", () => {
  it("names a restart script at command position", () => {
    expect(deckFindings("pnpm restart:stream-deck", ROOT, ctx({}), BASH)).toEqual([
      "`pnpm restart:stream-deck` restarts or relinks a deck host",
    ]);
  });

  it("follows a script to the restart it runs, and labels the path", () => {
    const found = deckFindings("pnpm swap", ROOT, ctx({ swap: "pnpm build && pnpm relink:mirabox" }), BASH);
    expect(found).toEqual(["`pnpm swap` → `pnpm relink:mirabox` restarts or relinks a deck host"]);
  });

  it("finds nothing in a build, under either shell", () => {
    const c = ctx({ build: "node scripts/build.mjs" });
    expect(deckFindings("pnpm build", ROOT, c, BASH)).toEqual([]);
    expect(deckFindings("pnpm build", ROOT, c, POWERSHELL)).toEqual([]);
  });

  it("judges a script by its name alone when the context cannot read scripts", () => {
    const c = ctx({ swap: "pnpm relink:mirabox" }, { scriptsAt: undefined });
    expect(deckFindings("pnpm swap", ROOT, c, BASH)).toEqual([]);
    expect(deckFindings("pnpm relink:mirabox", ROOT, c, BASH)).toHaveLength(1);
  });

  it("asks for dev:voices only where a host's link points into the tree", () => {
    const linked = { linkTargets: () => [{ host: "Stream Deck", target: path.join(ROOT, "packages", "plugin") }] };
    expect(deckFindings("pnpm dev:voices", ROOT, ctx({}), BASH)).toEqual([]);
    expect(deckFindings("pnpm dev:voices", ROOT, ctx({}, linked), BASH)).toEqual([
      `Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`,
    ]);
  });

  it("stops at a cycle and at the depth bound", () => {
    const loop = ctx({ "loop-a": "pnpm loop-b", "loop-b": "pnpm loop-a" });
    expect(deckFindings("pnpm loop-a", ROOT, loop, BASH)).toEqual([]);
    const chain = (n) =>
      ctx({
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`deep${i}`, `pnpm deep${i + 1}`])),
        [`deep${n}`]: "pnpm relink:ulanzi",
      });
    expect(deckFindings("pnpm deep0", ROOT, chain(7), BASH)).toHaveLength(1);
    expect(deckFindings("pnpm deep0", ROOT, chain(8), BASH)).toEqual([]);
  });
});

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
