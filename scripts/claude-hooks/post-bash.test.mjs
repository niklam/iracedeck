import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The post-hook's triggers, fired as the harness fires them (#1321). Only
// paths whose step needs no network are used, and the board helpers run dry.
const HOOK = path.join(import.meta.dirname, "post-bash.mjs");

function fire(command, stdout = "") {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout },
      cwd: import.meta.dirname,
    }),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, IRACEDECK_HOOKS_DRY_RUN: "1" },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

describe("post-bash.mjs triggers", () => {
  it("stays silent on a mention of every trigger", () => {
    for (const command of [
      `grep -rn "gh pr merge" scripts`,
      `git commit -q -F - <<'EOF'\nsubject\n\nafter gh pr merge 7 the card moves\nEOF`,
      `echo "gh issue create --title x"`,
      `printf '%s' 'sed -i s/a/b/ f'`,
      `grep -n 'git worktree add ../ir-5' notes.md`,
    ])
      expect(fire(command), command).toBeNull();
  });

  it("runs the issue step on a real `gh issue create`", () =>
    expect(fire("gh issue create --title x --body y", "")).toMatch(/no issue URL in the output/));

  it("runs the sed step on a real `sed -i`, even after a chain", () =>
    expect(fire("ls && sed -i s/a/b/ nothing.txt")).toMatch(/sed -i ran/));
});
