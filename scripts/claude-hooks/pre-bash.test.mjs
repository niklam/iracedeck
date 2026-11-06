import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// This file proves the WIRING around the rules, not the rules: the stdin
// payload, `ctx.shell` from `tool_name`, the real context readers in
// `pre-bash.mjs` (the workspace's packages, the nearest package.json, the
// package directories, the deck hosts' plugin links) and the verdict JSON — by
// running the entry point the harness runs (`.claude/rules/hooks.md` rule 6,
// #1307 review). Only commands whose verdict needs no network are used, so it
// runs anywhere.
//
// Each wiring path is spawned once, with the positive control it needs, and no
// more (#1542). A spawn is a fresh Node process, about 0.1 s on an idle machine
// and up to 0.55 s under the full suite, and every spawn of the same path runs
// the same reader; the 58 spawns this file once made took single tests past
// Vitest's 5 s default under load. Which commands ask, deny or pass is the
// rules' business and is tested in-process: `rules-bash.test.mjs` through
// `checkBash`, `script-runs.test.mjs` through `deckFindings`. A new shape goes
// there; a new spawn here only for a new reader or a new field of the payload.
const HOOK = path.join(import.meta.dirname, "pre-bash.mjs");

// Each describe below spawns the hook, at most three to a test (measured on
// #1542: a spawn up to 0.55 s under the full suite), so 30 s is headroom for a
// loaded machine, not a budget anything here should approach.
const SPAWNS = { timeout: 30_000 };

function fire(command, { tool = "Bash", cwd = import.meta.dirname, env } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    encoding: "utf8",
    timeout: 60_000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

describe("pre-bash.mjs, fired as the harness fires it", SPAWNS, () => {
  it("denies a trapped shape with the rule's reason", () => {
    const v = fire("pnpm exec vitest run");
    expect(v.hookEventName).toBe("PreToolUse");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/vitest/);
  });

  // Judged against the manifests of the checkout the command runs in — this
  // one — so it holds in a worktree whose scripts differ from master's (#1021).
  // The reason names the script, so the package was found and its scripts read:
  // an unread workspace says "No workspace package" instead.
  it("reads the workspace's packages, refusing a script the package lacks", () => {
    const v = fire("pnpm --filter @iracedeck/iracing-plugin-mirabox test");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/no "test" script/);
    // Positive control: a package that has the script passes, so the reader
    // returns real scripts rather than none for every package.
    expect(fire("pnpm --filter @iracedeck/logger test")).toBeNull();
  });

  it("refuses two merges in one command before asking GitHub anything", () => {
    const v = fire("gh pr merge 7 --squash & gh pr merge 8 --squash");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/One `gh pr merge` per command/);
  });

  it("prints nothing for a command no rule names", () => expect(fire("git status")).toBeNull());
});

// #1520: the PowerShell tool's commands go through the same hook, with the
// rules that are not bash syntax.
describe("pre-bash.mjs, fired for the PowerShell tool", SPAWNS, () => {
  // A deck link of our own: APPDATA points at a temp folder whose Stream Deck
  // plugin link is a junction into a temp "tree", so the ask does not hinge on
  // where this machine's real hosts are linked. Neither folder is a git repo,
  // so the tree is the directory itself.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pre-bash-ps-"));
  const linkedTree = path.join(tmp, "linked");
  const otherTree = path.join(tmp, "other");
  const appdata = path.join(tmp, "appdata");
  const plugins = path.join(appdata, "Elgato", "StreamDeck", "Plugins");
  for (const d of [path.join(linkedTree, "plugin"), otherTree, plugins]) mkdirSync(d, { recursive: true });
  symlinkSync(path.join(linkedTree, "plugin"), path.join(plugins, "com.iracedeck.sd.core.sdPlugin"), "junction");
  const env = {
    APPDATA: appdata,
    MIRABOX_PLUGINS_DIR: path.join(tmp, "none"),
    ULANZI_PLUGINS_DIR: path.join(tmp, "none"),
  };
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // The bypass itself: the harness only runs this hook for the tools its matcher names.
  it("is wired for both tools in .claude/settings.json", () => {
    const settings = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "..", ".claude", "settings.json"), "utf8"),
    );
    const entries = settings.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes("pre-bash.mjs")));
    expect(entries).toHaveLength(1);
    const matcher = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const tool of ["Bash", "PowerShell"]) expect(matcher.test(tool), tool).toBe(true);
    expect(matcher.test("Edit")).toBe(false);
  });

  // The link reader, through APPDATA and a junction: `dev:voices` relinks the
  // hosts linked to its tree, so it asks there and nowhere else (#1526).
  it("reads the deck hosts' links: asks for dev:voices in the linked tree, and passes it elsewhere", () => {
    const v = fire("pnpm dev:voices on", { tool: "PowerShell", cwd: linkedTree, env });
    expect(v.permissionDecision).toBe("ask");
    expect(v.permissionDecisionReason).toMatch(/Stream Deck plugin link points into/);
    // The same payload from the Bash tool reads the same links.
    expect(fire("pnpm dev:voices on", { cwd: linkedTree, env }).permissionDecision).toBe("ask");
    // Positive control: the same payload from an unlinked tree passes.
    expect(fire("pnpm dev:voices on", { tool: "PowerShell", cwd: otherTree, env })).toBeNull();
  });

  // Its control is the unlinked run above: the same command from the same cwd passes.
  it("follows a Set-Location into the linked tree", () =>
    expect(
      fire(`Set-Location '${linkedTree}'; pnpm dev:voices on`, { tool: "PowerShell", cwd: otherTree, env })
        .permissionDecision,
    ).toBe("ask"));

  // The two readers together: the script is read from the linked tree's own
  // package.json, and only the link makes what it runs ask. Its control is the
  // unlinked run of `dev:voices` above. The manifest is removed afterwards so
  // the tests that run a bare `dev:voices` there do not depend on the order.
  it("reads a linked tree's own script before judging its link", () => {
    const manifest = path.join(linkedTree, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "fixture", scripts: { voices: "pnpm dev:voices on" } }));
    try {
      const v = fire("pnpm voices", { cwd: linkedTree, env });
      expect(v.permissionDecision).toBe("ask");
      expect(v.permissionDecisionReason).toMatch(/`pnpm voices` → .*`pnpm dev:voices` there relinks/);
    } finally {
      rmSync(manifest, { force: true });
    }
  });

  // #1520 second read, #1526 review: a script is judged by the command line its
  // package.json gives it, and a selector the hook cannot resolve exactly reads
  // every package it may pick. `sd` carries the Stream Deck plugin's real
  // `watch`: the restart sits in a quoted rollup option, escaped once more by
  // the JSON it is read from. The shapes themselves, under both shells, are in
  // `script-runs.test.mjs`; these prove the two filesystem readers behind them.
  describe("reads the package directories and the package.json each holds", () => {
    const sd = path.join(otherTree, "packages", "sd");
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      path.join(sd, "package.json"),
      JSON.stringify({
        name: "@fixture/sd",
        scripts: { build: "rollup -c", watch: 'rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"' },
      }),
    );

    // A name selector: every package directory is listed, and each one's
    // package.json read for its name and scripts.
    it("asks for a package's watch picked by name, and passes its build", () => {
      expect(fire("pnpm --filter sd watch", { cwd: otherTree, env }).permissionDecisionReason).toMatch(
        /`pnpm watch` → `rollup --watch\.onEnd` → `streamdeck restart`/,
      );
      // Positive control: the same package, over a script that restarts nothing.
      expect(fire("pnpm --filter sd build", { cwd: otherTree, env })).toBeNull();
    });

    it("asks for a package's watch picked by path, from the PowerShell tool", () =>
      expect(
        fire("pnpm --filter ./packages/sd watch", { tool: "PowerShell", cwd: otherTree, env }).permissionDecision,
      ).toBe("ask"));

    // No selector: the script is read from the package.json at the command's own cwd.
    it("asks for a bare script run from the package's own directory", () =>
      expect(fire("pnpm watch", { cwd: sd, env }).permissionDecisionReason).toMatch(
        /`pnpm watch` → `rollup --watch\.onEnd` → `streamdeck restart`/,
      ));
  });

  // The tool decides the shell: a heredoc is bash syntax only.
  it("does not judge a heredoc-shaped string, which only bash would read as one", () => {
    const heredoc = "Write-Output 'x' <<EOF C:\\\\Users";
    expect(fire(heredoc, { tool: "PowerShell" })).toBeNull();
    expect(fire(heredoc).permissionDecision).toBe("deny");
  });
});
