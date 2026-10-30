import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The post-hook's triggers, fired as the harness fires them (#1321). Only
// paths whose step needs no network are used, and the board helpers run dry.
const HOOK = path.join(import.meta.dirname, "post-bash.mjs");

// A PATH with no `gh` on it, so a step that asks gh fails at once — offline
// and deterministic — and reports that it could not, which proves it ran.
const NO_GH = mkdtempSync(path.join(os.tmpdir(), "post-bash-no-gh-"));

// Scratch for paths the hook resolves. Removed after the suite: a temp dir
// left holding `ir-<n>` directories is the very shape these hooks key on.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "post-bash-tree-"));
afterAll(() => {
  for (const dir of [NO_GH, SCRATCH]) rmSync(dir, { recursive: true, force: true });
});

// The repo root: the cwd a session hands the hook, which is where an add of
// `../ir-<n>` is meant to run from (#1358).
const ROOT = path.resolve(import.meta.dirname, "../..");

function fire(command, { stdout = "", withoutGh = false, cwd = ROOT, tool = "Bash" } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !withoutGh || k.toLowerCase() !== "path"));
  if (withoutGh) env.PATH = NO_GH;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: tool,
      tool_input: { command },
      tool_response: { stdout },
      cwd,
    }),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...env, IRACEDECK_HOOKS_DRY_RUN: "1" },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

describe("post-bash.mjs triggers", () => {
  it("stays silent on a mention of every trigger", () => {
    for (const command of [
      `grep -rn "gh pr merge" scripts`,
      `git commit -q -F - <<'EOF'\nsubject\n\nafter gh pr merge 7 the card moves\nEOF`,
      `git commit -m "$(cat <<'EOF'\nsubject\n\ngit worktree add ../ir-77 -b fix/77-x\nEOF\n)"`,
      `echo "gh issue create --title x"`,
      `printf '%s' 'sed -i s/a/b/ f'`,
      `grep -n 'git worktree add ../ir-5' notes.md`,
    ])
      expect(fire(command), command).toBeNull();
  });

  it("runs the issue step on a real `gh issue create`, behind a wrapper too", () => {
    expect(fire("gh issue create --title x --body y")).toMatch(/no issue URL in the output/);
    expect(fire("timeout 60 gh issue create --title x --body y")).toMatch(/no issue URL in the output/);
  });

  it("runs the sed step on a real `sed -i`, after a chain or through xargs", () => {
    expect(fire("ls && sed -i s/a/b/ nothing.txt")).toMatch(/sed -i ran/);
    expect(fire("git ls-files '*.nothing' | xargs sed -i 's/a/b/'")).toMatch(/sed -i ran/);
  });

  it("runs the merge step on a real `gh pr merge`, behind a wrapper too", () => {
    for (const command of ["gh pr merge 7 --squash", "timeout 120 gh pr merge 7 --squash"])
      expect(fire(command, { withoutGh: true }), command).toMatch(/could not read the PR back/);
    expect(fire(`gh pr merge "7" --squash`)).toMatch(/its PR argument could not be read/);
  });

  it("moves the card of the tree the add created, not of one a comment names", () => {
    const note = fire("# superseded: git worktree add ../ir-1400\ngit worktree add ../ir-1321 -b fix/1321-x", {
      withoutGh: true,
    });
    expect(note).toMatch(/Worktree for #1321 created/);
    expect(note).not.toMatch(/1400/);
  });

  it("moves the card of the tree the add created when an ancestor is named ir-<n> too (#1358)", () => {
    // Every checkout of this suite run from an ir-* worktree has that shape:
    // the first ir- segment in the path is the ancestor, the last is the add.
    const repo = path.join(SCRATCH, "ir-1325", "repo", "master");
    mkdirSync(repo, { recursive: true });
    const note = fire("git worktree add ../ir-1321 -b fix/1321-x", { withoutGh: true, cwd: repo });
    expect(note).toMatch(/Worktree for #1321 created/);
    expect(note).not.toMatch(/1325/);
  });

  // #1520 second read: the PowerShell tool's commands reached the pre-hook
  // only, so a merge, a worktree or a filing there moved no card, silently.
  it("is wired for both tools in .claude/settings.json", () => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks.PostToolUse.filter((e) => e.hooks.some((h) => h.command.includes("post-bash.mjs")));
    expect(entries).toHaveLength(1);
    const matcher = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const tool of ["Bash", "PowerShell"]) expect(matcher.test(tool), tool).toBe(true);
    expect(matcher.test("Edit")).toBe(false);
  });

  it("runs the merge, issue and worktree steps on a PowerShell command too", () => {
    const tool = "PowerShell";
    expect(fire("gh pr merge 7 --squash", { withoutGh: true, tool })).toMatch(/could not read the PR back/);
    expect(fire("gh issue create --title x --body y", { tool })).toMatch(/no issue URL in the output/);
    expect(fire("git worktree add ..\\ir-1321 -b fix/1321-x", { withoutGh: true, tool })).toMatch(
      /Worktree for #1321 created/,
    );
    // Read as PowerShell reads it: a backtick continues the line, which bash
    // would take for a command substitution and lose the path behind.
    const continued = "git worktree add `\n  ..\\ir-1323 -b fix/1323-x";
    expect(fire(continued, { withoutGh: true, tool })).toMatch(/Worktree for #1323 created/);
    expect(fire(continued, { withoutGh: true })).toBeNull();
    expect(fire("Write-Output 'gh pr merge 7'", { tool })).toBeNull();
  });
});

// #1527: a card is found by issue number alone, so a filing or a merge in
// another repository moved the iRaceDeck card that shares its number.
describe("post-bash.mjs acts on niklam/iracedeck only (#1527)", () => {
  const FOREIGN = "https://github.com/lint-staged/lint-staged/issues/1865";

  it("adds an iRaceDeck issue to the board and moves its card — the positive control", () => {
    for (const url of [
      "https://github.com/niklam/iracedeck/issues/1527",
      "https://github.com/Niklam/iRaceDeck/issues/1527",
    ]) {
      // Dry run: the add reports an item, and the lane move then asks gh for
      // the card, which fails without gh — proof the move was attempted.
      const note = fire("gh issue create --title x --body y", { stdout: `${url}\n`, withoutGh: true });
      expect(note, url).toContain(`Added ${url} to the Roadmap board`);
      expect(note, url).toMatch(/board: #1527 /);
    }
  });

  it("leaves the board alone for an issue filed in another repository", () => {
    for (const command of [
      "gh issue create -R lint-staged/lint-staged --title x --body y",
      "gh issue create --title x --body y", // gh resolved another checkout's repository
    ]) {
      const note = fire(command, { stdout: `Creating issue in lint-staged/lint-staged\n\n${FOREIGN}\n` });
      expect(note, command).toBe(
        `[hook] Filed ${FOREIGN} in lint-staged/lint-staged, not niklam/iracedeck: the Roadmap board is left alone.`,
      );
    }
    const ps = fire("gh issue create -R lint-staged/lint-staged --title x --body y", {
      stdout: FOREIGN,
      tool: "PowerShell",
    });
    expect(ps).toMatch(/left alone/);
  });

  it("reads a merge in another repository from its arguments, before asking gh anything", () => {
    for (const command of [
      "gh pr merge 5 -R other/repo --squash",
      "gh pr merge 5 --repo=Other/Repo --squash",
      "gh pr merge 5 -Rother/repo --squash",
      "gh pr merge 5 --repo 'other/repo' --squash",
      "gh pr merge 5 --repo github.com/other/repo --squash",
      "gh pr merge https://github.com/other/repo/pull/5 --squash",
      "GH_REPO=other/repo gh pr merge 5 --squash",
      "export GH_REPO=other/repo && gh pr merge 5 --squash",
    ]) {
      // Without gh on PATH a read-back would say "could not read the PR back".
      const note = fire(command, { withoutGh: true });
      expect(note, command).toMatch(/gh pr merge ran in other\/repo, not niklam\/iracedeck: no Roadmap card moved/i);
    }
    expect(fire("gh pr merge 5 --repo ghe.example.com/niklam/iracedeck --squash", { withoutGh: true })).toMatch(
      /ran in ghe\.example\.com\/niklam\/iracedeck, not niklam\/iracedeck/,
    );
    expect(
      fire("$env:GH_REPO = 'other/repo'; gh pr merge 5 --squash", { withoutGh: true, tool: "PowerShell" }),
    ).toMatch(/ran in other\/repo/);
  });

  it("still reads an iRaceDeck merge back, however it names the repository", () => {
    for (const command of [
      "gh pr merge 5 --squash",
      "gh pr merge 5 -R niklam/iracedeck --squash",
      "gh pr merge 5 --repo NIKLAM/IRACEDECK --squash",
      "gh pr merge https://github.com/niklam/iracedeck/pull/5 --squash",
      "GH_REPO=niklam/iracedeck gh pr merge 5 --squash",
      // The flag beats the environment, as in gh.
      "GH_REPO=other/repo gh pr merge 5 -R niklam/iracedeck --squash",
    ])
      expect(fire(command, { withoutGh: true }), command).toMatch(/could not read the PR back/);
  });

  it("says so when the repository a merge names cannot be read", () => {
    for (const command of [`gh pr merge 5 -R "$REPO" --squash`, "GH_REPO=$REPO gh pr merge 5 --squash"])
      expect(fire(command, { withoutGh: true }), command).toMatch(/a --repo or GH_REPO the hook cannot read/);
  });
});
