import path from "node:path";
import { describe, expect, it } from "vitest";

import { generatorsFor, issueFromWorktreePath, missingWorkflows, prRefFrom, remindersFor } from "./rules-post.mjs";
import { checkAgent, checkAsk, checkSkill } from "./rules-tools.mjs";

const MASTER = "C:\\Users\\Niklas\\Projects\\iRaceDeck\\master";
const TREE = "C:/Users/Niklas/Projects/iRaceDeck/ir-1100";

describe("checkSkill (/code-review)", () => {
  it("ignores other skills", () => expect(checkSkill({ skill: "website", args: "--fix" })).toBeNull());
  it("matches the plugin-qualified name", () =>
    expect(checkSkill({ skill: "code-review:code-review", args: "high --fix" }, MASTER)).toMatch(/--fix/));
  it("refuses --fix", () =>
    expect(checkSkill({ skill: "code-review", args: `high ${TREE} --fix` }, MASTER)).toMatch(/--fix/));
  it("requires a level", () =>
    expect(checkSkill({ skill: "code-review", args: TREE }, MASTER)).toMatch(/effort level/));
  it("requires the worktree when the cwd is master", () =>
    expect(checkSkill({ skill: "code-review", args: "high" }, MASTER)).toMatch(/worktree/));
  it("accepts a cwd that is itself an ir-<issue> tree", () =>
    expect(checkSkill({ skill: "code-review", args: "high" }, path.resolve("/x/ir-1100"))).toBeNull());
  it("accepts level + path + scope block", () =>
    expect(checkSkill({ skill: "code-review", args: `high ${TREE}\n\nSCOPE:\n- x` }, MASTER)).toBeNull());
  it("leaves the cloud review alone", () =>
    expect(checkSkill({ skill: "code-review", args: "ultra" }, MASTER)).toBeNull());
});

describe("checkAgent", () => {
  it("requires a model", () => expect(checkAgent({ subagent_type: "general-purpose" })).toMatch(/model/));
  it("exempts fork", () => expect(checkAgent({ subagent_type: "fork" })).toBeNull());
  it("refuses per-agent worktrees even with a model", () =>
    expect(checkAgent({ model: "sonnet", isolation: "worktree" })).toMatch(/per ISSUE/));
  it("passes with a model", () => expect(checkAgent({ model: "opus", subagent_type: "Explore" })).toBeNull());
});

describe("checkAsk", () => {
  const q = (label, description = "", question = "Who does it?") => ({
    questions: [{ question, options: [{ label, description }] }],
  });
  it("refuses a first-person actor in a label", () => expect(checkAsk(q("I run it"))).toMatch(/Claude/));
  it("refuses it in a description", () => expect(checkAsk(q("Run", "I'll push it"))).toMatch(/never "I/));
  it("refuses it in the question", () => expect(checkAsk(q("A", "", "Should I merge now?"))).toBeTruthy());
  it("accepts Claude/You actors", () =>
    expect(
      checkAsk({ questions: [{ question: "Who?", options: [{ label: "Claude runs it" }, { label: "You run it" }] }] }),
    ).toBeNull());
  it("does not trip on the word I inside other words or on lower-case i", () =>
    expect(checkAsk(q("Install it", "with iRacing running"))).toBeNull());
  it("tolerates a missing questions array", () => expect(checkAsk({})).toBeNull());
});

describe("post rules", () => {
  it("maps generator sources", () => {
    expect(generatorsFor("packages/website/src/content/docs/changelog.mdx").map((g) => g.args[0])).toEqual([
      "scripts/generate-changelog-data.mjs",
    ]);
    expect(generatorsFor("packages/icons/black-box/fuel.svg").map((g) => g.label)).toEqual([
      "icon previews",
      "icon defaults (PI colour/border defaults)",
    ]);
    expect(generatorsFor("packages/icons/preview/black-box/fuel.svg")).toEqual([]);
    expect(generatorsFor("packages/iracing-actions/src/actions/comms-catalog.ts").map((g) => g.args)).toEqual([
      ["generate:action-comms"],
    ]);
    expect(generatorsFor("packages/audio-assets/configs/default.voice.json").map((g) => g.args)).toEqual([
      ["generate:callout-scripts"],
    ]);
    expect(generatorsFor("packages/deck-core/src/types.ts")).toEqual([]);
  });
  it("maps reminders", () => {
    expect(remindersFor("packages/deck-core/src/global-settings.ts")[0]).toMatch(/build:force/);
    expect(remindersFor(".claude/rules/testing.md")[0]).toMatch(/show the drafted text/);
    expect(remindersFor("packages/deck-core/src/types.ts")).toEqual([]);
  });
  it("reads the issue off a worktree path", () => {
    expect(issueFromWorktreePath("C:\\x\\ir-1100")).toBe(1100);
    expect(issueFromWorktreePath("../ir-42")).toBe(42);
    expect(issueFromWorktreePath("C:\\x\\master")).toBeUndefined();
  });
  it("reads the PR ref off a gh pr command", () => {
    expect(prRefFrom("gh pr merge 12 --squash", "merge")).toBe("12");
    expect(prRefFrom("gh pr merge --squash", "merge")).toBeUndefined();
    expect(prRefFrom("gh pr merge --squash https://github.com/a/b/pull/3", "merge")).toBe(
      "https://github.com/a/b/pull/3",
    );
  });
  it("names the CI workflows a run list is missing", () => {
    expect(missingWorkflows([{ workflowName: "Format" }, { workflowName: "Lint" }])).toEqual(["Tests", "Typecheck"]);
    expect(missingWorkflows(undefined)).toHaveLength(4);
  });
});
