import path from "node:path";
import { describe, expect, it } from "vitest";

import { deckFindings, FINDING_KINDS, repeated, shellQuote } from "./script-runs.mjs";
import { BASH, maskInert, POWERSHELL, powershellAsBash, shellWords } from "./shell-lexer.mjs";

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

const RESTART = FINDING_KINDS.restart;
const RELINK = FINDING_KINDS.relink;

describe("deckFindings", () => {
  it("names a restart script at command position, as a restart", () => {
    expect(deckFindings("pnpm restart:stream-deck", ROOT, ctx({}), BASH)).toEqual([
      { text: `\`pnpm restart:stream-deck\` ${RESTART}`, kind: "restart" },
    ]);
  });

  it("follows a script to the relink it runs, and labels the path", () => {
    const found = deckFindings("pnpm swap", ROOT, ctx({ swap: "pnpm build && pnpm relink:mirabox" }), BASH);
    expect(found).toEqual([{ text: `\`pnpm swap\` → \`pnpm relink:mirabox\` ${RELINK}`, kind: "relink" }]);
  });

  // #1737: every finding carries the kind the rule decides by.
  it.each([
    ["pnpm restart:stream-deck", "restart"],
    ["pnpm stop:mirabox", "restart"],
    ["pnpm start:ulanzi", "restart"],
    ["pnpm build:with-restart", "restart"],
    ["pnpm build:stream-deck", "restart"],
    ["node scripts/build-with-restart.mjs", "restart"],
    ["node scripts/integration-build.mjs --restart fix/1-a", "restart"],
    ["node scripts/integration-build.mjs $R fix/1-a", "restart"],
    ["node scripts/host-app.mjs stop stream-deck", "restart"],
    ["streamdeck restart com.iracedeck.sd.core", "restart"],
    ["streamdeck stop com.iracedeck.sd.core", "restart"],
    ["npx streamdeck restart com.iracedeck.sd.core", "restart"],
    ["taskkill /im StreamDeck.exe", "restart"],
    ["pnpm relink:stream-deck", "relink"],
    ["pnpm link:mirabox", "relink"],
    ["pnpm unlink:ulanzi", "relink"],
    ["pnpm switch-test-env", "relink"],
    ["pnpm switch-test-env:mirabox", "relink"],
    ["streamdeck link x", "relink"],
    ["streamdeck unlink -d x", "relink"],
    ["npx streamdeck link x", "relink"],
    ["node scripts/link-mirabox.mjs", "relink"],
    ["node scripts/unlink-ulanzi.mjs", "relink"],
    [`pnpm run "/[/"`, "relink"],
    ["pnpm watch:stream-deck", "watch"],
    [`rollup -c -w --watch.onEnd="streamdeck restart x"`, "watch"],
    [`rollup -c -w --watch.onEnd="pnpm relink:mirabox"`, "watch"],
    // #1737 review: what runs over and over is a watch, however it is repeated.
    ["watch -n 5 pnpm restart:stream-deck", "watch"],
    ["watch 'pnpm build && pnpm restart:stream-deck'", "watch"],
    ["watch pnpm relink:stream-deck", "watch"],
    ["turbo watch restart:x", "watch"],
    ["turbo run restart:x", "restart"],
    ["while true; do pnpm restart:stream-deck; done", "watch"],
    ["until false; do streamdeck stop x; done", "watch"],
    ["for h in a b; do pnpm restart:stream-deck; done", "restart"],
    ["while true; do sleep 1; done; pnpm restart:stream-deck", "restart"],
  ])("gives %s the kind %s", (command, kind) => {
    expect(deckFindings(command, ROOT, ctx({}), BASH).map((f) => f.kind)).toEqual([kind]);
  });

  it("gives a PowerShell while or do loop's restart the kind watch, and a foreach's restart", () => {
    const ps = (command) => deckFindings(powershellAsBash(command), ROOT, ctx({}), POWERSHELL).map((f) => f.kind);
    expect(ps("while ($true) { pnpm restart:stream-deck }")).toEqual(["watch"]);
    expect(ps("do { pnpm restart:stream-deck } until ($false)")).toEqual(["watch"]);
    expect(ps("foreach ($h in 'a','b') { pnpm restart:stream-deck }")).toEqual(["restart"]);
  });

  // #1737 review: an escalated finding says why it asks, once.
  it("says why a finding repeated over and over asks, once", () => {
    expect(repeated("`x` restarts", "restart", undefined)).toEqual({ text: "`x` restarts", kind: "restart" });
    expect(repeated("`x` restarts", "restart", "on every rebuild")).toEqual({
      text: "`x` restarts, on every rebuild",
      kind: "watch",
    });
    expect(repeated("`x` relinks", "relink", "again on every pass of its loop")).toEqual({
      text: "`x` relinks, again on every pass of its loop",
      kind: "watch",
    });
    expect(repeated("`x` restarts, on every rebuild", "watch", "again every time `watch` reruns it")).toEqual({
      text: "`x` restarts, on every rebuild",
      kind: "watch",
    });
  });

  it("gives dev:voices in a linked tree the kind relink", () => {
    const linked = { linkTargets: () => [{ host: "Stream Deck", target: path.join(ROOT, "plugin") }] };
    expect(deckFindings("pnpm dev:voices", ROOT, ctx({}, linked), BASH).map((f) => f.kind)).toEqual(["relink"]);
  });

  // #1737: a restart's name no longer ends the judgement, so what it runs is
  // read; its own restarts are not named twice, and anything else it reaches is.
  it("reads what a restart's name runs, naming a relink behind it and no restart twice", () => {
    const c = ctx({
      "restart:x": "pnpm build && pnpm relink:mirabox",
      "restart:stream-deck": "streamdeck restart com.iracedeck.sd.core",
      "build:stream-deck": "pnpm build:ts && pnpm restart:stream-deck",
      "stop:y": `rollup -c -w --watch.onEnd="streamdeck restart x"`,
    });
    expect(deckFindings("pnpm restart:x", ROOT, c, BASH)).toEqual([
      { text: `\`pnpm restart:x\` ${RESTART}`, kind: "restart" },
      { text: `\`pnpm restart:x\` → \`pnpm relink:mirabox\` ${RELINK}`, kind: "relink" },
    ]);
    expect(deckFindings("pnpm build:stream-deck", ROOT, c, BASH)).toEqual([
      { text: `\`pnpm build:stream-deck\` ${RESTART}`, kind: "restart" },
    ]);
    expect(deckFindings("pnpm stop:y", ROOT, c, BASH).map((f) => f.kind)).toEqual(["restart", "watch"]);
  });

  // A relink's name ends the judgement there, as before #1737: it asks already.
  it("does not read what a relink's name runs", () => {
    const c = ctx({ "relink:x": "pnpm relink:mirabox && pnpm restart:stream-deck" });
    expect(deckFindings("pnpm relink:x", ROOT, c, BASH)).toEqual([
      { text: `\`pnpm relink:x\` ${RELINK}`, kind: "relink" },
    ]);
  });

  it("finds nothing in a build, under either shell", () => {
    const c = ctx({ build: "node scripts/build.mjs" });
    expect(deckFindings("pnpm build", ROOT, c, BASH)).toEqual([]);
    expect(deckFindings("pnpm build", ROOT, c, POWERSHELL)).toEqual([]);
  });

  it("judges a script by its name alone when the context cannot read scripts", () => {
    const c = ctx({ swap: "pnpm relink:mirabox" }, { scriptsAt: undefined });
    expect(deckFindings("pnpm swap", ROOT, c, BASH)).toEqual([]);
    expect(deckFindings("pnpm restart:x", ROOT, c, BASH)).toHaveLength(1);
    expect(deckFindings("pnpm relink:mirabox", ROOT, c, BASH)).toHaveLength(1);
  });

  it("asks for dev:voices only where a host's link points into the tree", () => {
    const linked = { linkTargets: () => [{ host: "Stream Deck", target: path.join(ROOT, "packages", "plugin") }] };
    expect(deckFindings("pnpm dev:voices", ROOT, ctx({}), BASH)).toEqual([]);
    expect(deckFindings("pnpm dev:voices", ROOT, ctx({}, linked), BASH)).toEqual([
      {
        text: `Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`,
        kind: "relink",
      },
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
    // An ordinary name past the bound is judged by its name alone, and finds nothing, as before #1737.
    expect(deckFindings("pnpm deep0", ROOT, chain(8), BASH)).toEqual([]);
  });

  // #1737 CodeRabbit round: a restart's name no longer ends the judgement, so
  // a restart whose body the depth bound leaves unread may hide a relink. That
  // asks; one whose body is read within the bound is the restart it names.
  it("asks for a restart whose body lies past the depth bound", () => {
    const restarts = (n) =>
      ctx({
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`restart:d${i}`, `pnpm restart:d${i + 1}`])),
        [`restart:d${n}`]: "pnpm build",
      });
    expect(deckFindings("pnpm restart:d0", ROOT, restarts(7), BASH).map((f) => f.kind)).toEqual(["restart"]);
    const deep = deckFindings("pnpm restart:d0", ROOT, restarts(8), BASH);
    expect(deep.map((f) => f.kind)).toEqual(["restart", "watch"]);
    expect(deep[1].text).toMatch(
      /→ `pnpm restart:d8` runs scripts too deep to read, which may repeat a restart or relink a host$/,
    );
    // A restart past the bound with no body to read (no such script) is just its name.
    const bare = ctx(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`restart:d${i}`, `pnpm restart:d${i + 1}`])),
    );
    expect(deckFindings("pnpm restart:d0", ROOT, bare, BASH).map((f) => f.kind)).toEqual(["restart"]);
  });

  // #1737, second CodeRabbit CLI run: what the bound leaves unread anywhere
  // beneath a restart may relink, whatever the name at the bound is called.
  it("asks for a restart whose chain reaches a neutral alias at the depth bound", () => {
    // `restart:x` at depth 0, `hop1`…`hop7`, then `hop8` at the bound, whose body would relink.
    const chain = (last) =>
      ctx({
        "restart:x": "pnpm hop1",
        // A neutral name at the restart's depth, for the control below.
        top: "pnpm hop1",
        ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`hop${i + 1}`, `pnpm hop${i + 2}`])),
        hop8: last,
      });
    const deep = deckFindings("pnpm restart:x", ROOT, chain("pnpm relink:mirabox"), BASH);
    expect(deep.map((f) => f.kind)).toEqual(["restart", "watch"]);
    expect(deep[1].text).toMatch(
      /→ `pnpm hop8` runs scripts too deep to read, which may repeat a restart or relink a host$/,
    );
    // Control: the same chain readable to the end and ending in a build is the one restart.
    const shallow = ctx({
      "restart:x": "pnpm hop1",
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`hop${i + 1}`, `pnpm hop${i + 2}`])),
      hop7: "pnpm build",
    });
    expect(deckFindings("pnpm restart:x", ROOT, shallow, BASH).map((f) => f.kind)).toEqual(["restart"]);
    // With no restart above it, a neutral chain past the bound finds nothing, as before #1737.
    expect(deckFindings("pnpm top", ROOT, chain("pnpm relink:mirabox"), BASH)).toEqual([]);
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
/**
 * `deckFindings` over a command as `checkBash` hands it over: a PowerShell
 * command first goes through `powershellAsBash`, as it does in the hook.
 */
const judge = (command, c, shell) =>
  deckFindings(shell === POWERSHELL ? powershellAsBash(command) : command, ROOT, c, shell).map((f) => f.text);
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
      expect(judge("pnpm hop", at(o), shell)).toEqual([`\`pnpm hop\` → \`pnpm relink:anything\` ${RELINK}`]);
      expect(judge("pnpm watch", at(o), shell)).toEqual([
        `\`pnpm watch\` → \`rollup --watch.onEnd\` → \`streamdeck restart\` ${RESTART}, on every rebuild`,
      ]);
    }
  });

  it.each(SHELLS)("%s: asks for a script that runs dev:voices only where a host is linked", (_, shell) => {
    expect(judge("pnpm voices", at(LINKED), shell)).toEqual([
      `\`pnpm voices\` → Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`,
    ]);
    expect(judge("pnpm voices", at(), shell)).toEqual([]);
  });

  // Positive control: scripts from the same package.json that restart nothing.
  it.each(SHELLS)("%s: finds nothing in a script that restarts nothing, linked or not", (_, shell) => {
    for (const o of [{}, LINKED])
      for (const c of ["pnpm wipe", "pnpm quiet"]) expect(judge(c, at(o), shell), c).toEqual([]);
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
  // Each shape with the exact finding it must give, so one that asks for the
  // wrong reason (a selector that stopped resolving, say) fails.
  const SD_RESTART = `\`rollup --watch.onEnd\` → \`streamdeck restart\` ${RESTART}, on every rebuild`;
  const WRAPPED = `\`pnpm restart:stream-deck\` ${RESTART}`;
  const restarting = [
    ["pnpm -r watch", `\`pnpm watch\` → ${SD_RESTART}`],
    ["pnpm --filter sd watch", `\`pnpm watch\` → ${SD_RESTART}`],
    ["pnpm --filter ./packages/sd watch", `\`pnpm watch\` → ${SD_RESTART}`],
    ["npm run watch -w packages/sd", `\`npm run watch\` → ${SD_RESTART}`],
    [`bash -c "pnpm restart:stream-deck"`, `\`bash -c\` → ${WRAPPED}`],
    [`cmd /c "pnpm restart:stream-deck"`, `\`cmd /c\` → ${WRAPPED}`],
    [`pwsh -c "pnpm restart:stream-deck"`, `\`pwsh -Command\` → ${WRAPPED}`],
    ["npx node scripts/host-app.mjs stop mirabox", "`node scripts/host-app.mjs stop` stops or starts a deck host app"],
    [`bash -c "pnpm relink:stream-deck"`, `\`bash -c\` → \`pnpm relink:stream-deck\` ${RELINK}`],
    [
      "node scripts/integration-build.mjs $(echo --restart) fix/1-a",
      "`node scripts/integration-build.mjs $(…)` may stop and start the deck hosts linked to its tree: its flags could not be read",
    ],
  ];
  // Positive control: the same shapes over what restarts nothing.
  const harmless = ["pnpm -r build", "pnpm --filter sd build", `bash -c "pnpm build"`, "npx node scripts/build.mjs"];

  it.each(SHELLS.flatMap(([name, shell]) => restarting.map(([cmd, finding]) => [name, cmd, shell, finding])))(
    "%s finds a deck host in: %s",
    (_, cmd, shell, finding) => expect(judge(cmd, c, shell)).toEqual([finding]),
  );
  it.each(SHELLS.flatMap(([name, shell]) => harmless.map((cmd) => [name, cmd, shell])))(
    "%s finds nothing in: %s",
    (_, cmd, shell) => expect(judge(cmd, c, shell)).toEqual([]),
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

// #1634, CodeRabbit CLI round 5: the string a runner hands a shell is read
// whole, with its own `cd`s, and the lexer's match inside it is left to this reader.
describe("a shell wrapper's string is judged whole, with its own cds (#1634)", () => {
  const MASTER = path.resolve("/repo/master");
  const isInside = (c, p) => c === p || c.startsWith(p + path.sep);
  const trees = ctx({}, { ...LINKED, toplevel: (d) => (isInside(d, ROOT) ? ROOT : MASTER) });
  const inner = `\`sh -c\` → Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`;

  it.each([
    "sh -c 'cd ../ir-5 && pnpm dev:voices'",
    "pnpm exec sh -c 'cd ../ir-5 && pnpm dev:voices'",
    "npx sh -c 'cd ../ir-5; pnpm dev:voices'",
    "sh -c $'cd ../ir-5\\npnpm dev:voices'",
    "sh -c 'cd ../ir-5 && pnpm dev:voices | tee log'",
  ])("names the tree the inner cd reaches once, from the session cwd: %s", (c) => {
    expect(deckFindings(c, MASTER, trees, BASH)).toEqual([{ text: inner, kind: "relink" }]);
  });

  it("finds nothing where the inner cd reaches an unlinked tree, and reads a stdin script at the cwd", () => {
    expect(deckFindings("pnpm exec sh -c 'cd ../ir-7 && pnpm dev:voices'", MASTER, trees, BASH)).toEqual([]);
    expect(deckFindings("echo 'pnpm dev:voices' | bash", ROOT, trees, BASH)).toEqual([
      {
        text: `Stream Deck plugin link points into ${ROOT}: \`pnpm dev:voices\` there relinks the running plugin`,
        kind: "relink",
      },
    ]);
  });
});
