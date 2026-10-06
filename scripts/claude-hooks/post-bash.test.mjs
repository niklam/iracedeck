import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function fire(command, { stdout = "", withoutGh = false, cwd = ROOT } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !withoutGh || k.toLowerCase() !== "path"));
  if (withoutGh) env.PATH = NO_GH;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
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
});
