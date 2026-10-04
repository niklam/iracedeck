import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The rule modules are tested directly; this proves the wiring around them —
// stdin payload, context, verdict JSON — by running the entry point the
// harness runs (`.claude/rules/hooks.md` rule 6, #1307 review). Only commands whose
// verdict needs no network are used, so it runs anywhere.
const HOOK = path.join(import.meta.dirname, "pre-bash.mjs");

function fire(command) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: import.meta.dirname }),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

describe("pre-bash.mjs, fired as the harness fires it", () => {
  it("denies a trapped shape with the rule's reason", () => {
    const v = fire("pnpm exec vitest run");
    expect(v.hookEventName).toBe("PreToolUse");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/vitest/);
  });

  // Judged against the manifests of the checkout the command runs in — this
  // one — so it holds in a worktree whose scripts differ from master's (#1021).
  it("lets a package's own test script run, and refuses one the package lacks", () => {
    expect(fire("pnpm --filter @iracedeck/logger test")).toBeNull();
    const v = fire("pnpm --filter @iracedeck/iracing-plugin-mirabox test");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/no "test" script/);
  });

  it("refuses two merges in one command before asking GitHub anything", () => {
    const v = fire("gh pr merge 7 --squash & gh pr merge 8 --squash");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/One `gh pr merge` per command/);
  });

  it("prints nothing for a command no rule names", () => expect(fire("git status")).toBeNull());
});
