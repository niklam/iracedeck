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

// #1542: shapes `pre-bash.test.mjs` once spawned the hook for, two tools each.
// Every one of those spawns ran the same readers, so the hook test keeps one
// spawn per reader and the shapes are judged here, in-process, under both
// shells as before.
const SHELLS = [
  ["Bash", BASH],
  ["PowerShell", POWERSHELL],
];
/** The Stream Deck plugin's real `watch`: the restart sits in a quoted rollup option. */
const SD_WATCH = 'rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"';
const LINKED = { linkTargets: () => [{ host: "Stream Deck", target: path.join(ROOT, "plugin") }] };

describe("a script read from the package.json it runs from, under either shell (#1520, #1542)", () => {
  const at = (o) =>
    ctx(
      {
        hop: "pnpm relink:anything",
        voices: "pnpm dev:voices on",
        watch: SD_WATCH,
        wipe: "rimraf plugin/bin",
        quiet: "vitest run",
      },
      o,
    );

  it.each(SHELLS)("%s: labels each step from the script to the restart, linked or not", (_, shell) => {
    for (const o of [{}, LINKED]) {
      expect(deckFindings("pnpm hop", ROOT, at(o), shell)).toEqual([
        "`pnpm hop` → `pnpm relink:anything` restarts or relinks a deck host",
      ]);
      expect(deckFindings("pnpm watch", ROOT, at(o), shell)).toEqual([
        "`pnpm watch` → `rollup --watch.onEnd` → `streamdeck restart` restarts or relinks a deck host",
      ]);
    }
  });

  it.each(SHELLS)("%s: asks for a script that runs dev:voices only where a host is linked", (_, shell) => {
    expect(deckFindings("pnpm voices", ROOT, at(LINKED), shell)).toEqual([
      `\`pnpm voices\` → Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`,
    ]);
    expect(deckFindings("pnpm voices", ROOT, at(), shell)).toEqual([]);
  });

  // Positive control: scripts from the same package.json that restart nothing.
  it.each(SHELLS)("%s: finds nothing in a script that restarts nothing, linked or not", (_, shell) => {
    for (const o of [{}, LINKED])
      for (const c of ["pnpm wipe", "pnpm quiet"]) expect(deckFindings(c, ROOT, at(o), shell), c).toEqual([]);
  });
});

// #1526 review: the false accepts it found. `sd` carries the Stream Deck
// plugin's `watch`; the root carries no scripts, so a selector asks only by
// reaching that package.
describe("every package an unresolved selector may pick, a wrapper's string and node behind a runner (#1526, #1542)", () => {
  const SD = path.join(ROOT, "packages", "sd");
  const manifests = {
    [ROOT]: { name: "root", scripts: {} },
    [SD]: { name: "@fixture/sd", scripts: { build: "rollup -c", watch: SD_WATCH } },
  };
  const scriptsAt = (dir) => {
    for (let d = dir; ; d = path.dirname(d)) {
      if (manifests[d]) return { dir: d, ...manifests[d] };
      if (path.dirname(d) === d) return undefined;
    }
  };
  const c = ctx({}, { scriptsAt, workspaceDirs: () => [SD] });
  const restarting = [
    "pnpm -r watch",
    "pnpm --filter sd watch",
    "pnpm --filter ./packages/sd watch",
    "npm run watch -w packages/sd",
    `bash -c "pnpm restart:stream-deck"`,
    `cmd /c "pnpm restart:stream-deck"`,
    `pwsh -c "pnpm restart:stream-deck"`,
    "npx node scripts/host-app.mjs stop mirabox",
    "node scripts/integration-build.mjs $(echo --restart) fix/1-a",
  ];
  // Positive control: the same shapes over what restarts nothing.
  const harmless = ["pnpm -r build", "pnpm --filter sd build", `bash -c "pnpm build"`, "npx node scripts/build.mjs"];
  const cases = (cmds) => SHELLS.flatMap(([name, shell]) => cmds.map((cmd) => [name, cmd, shell]));

  it.each(cases(restarting))("%s finds a deck host in: %s", (_, cmd, shell) => {
    const found = deckFindings(cmd, ROOT, c, shell);
    expect(found).not.toEqual([]);
    for (const f of found) expect(f).toMatch(/deck host/);
  });
  it.each(cases(harmless))("%s finds nothing in: %s", (_, cmd, shell) =>
    expect(deckFindings(cmd, ROOT, c, shell)).toEqual([]),
  );
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
