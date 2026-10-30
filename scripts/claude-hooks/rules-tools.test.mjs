import path from "node:path";
import { describe, expect, it } from "vitest";

import { firstMerge } from "./rules-bash.mjs";
import {
  assignedGhRepo,
  boardIssues,
  createdIssues,
  generatorReport,
  generatorsFor,
  isHomeRepo,
  issueCreateRepos,
  JUST_CREATED_MS,
  mergeRepo,
  missingWorkflows,
  pickCreated,
  remindersFor,
  repoOfUrl,
} from "./rules-post.mjs";
import { checkAgent, checkAsk, checkEdit, checkSkill } from "./rules-tools.mjs";

const MASTER = "C:\\repo\\iRaceDeck\\master";
const TREE = "C:/repo/iRaceDeck/ir-1100";

describe("checkSkill (/code-review)", () => {
  it("ignores other skills", () => expect(checkSkill({ skill: "website", args: "--fix" })).toBeNull());
  it("matches the plugin-qualified name", () =>
    expect(checkSkill({ skill: "code-review:code-review", args: "high --fix" }, MASTER)).toMatch(/--fix/));
  it("refuses --fix", () =>
    expect(checkSkill({ skill: "code-review", args: `high ${TREE} --fix` }, MASTER)).toMatch(/--fix/));
  it("requires a level", () =>
    expect(checkSkill({ skill: "code-review", args: TREE }, MASTER)).toMatch(/effort level/));
  it("refuses max, even with a path and scope block", () =>
    expect(checkSkill({ skill: "code-review", args: `max ${TREE}\n\nSCOPE:\n- x` }, MASTER)).toMatch(
      /xhigh is the top/,
    ));
  it("accepts xhigh as the top level", () =>
    expect(checkSkill({ skill: "code-review", args: `xhigh ${TREE}` }, MASTER)).toBeNull());
  it("does not list max among the levels it asks for", () =>
    expect(checkSkill({ skill: "code-review", args: TREE }, MASTER)).not.toMatch(/max/));
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

describe("checkEdit (raw control bytes)", () => {
  // Built with fromCharCode so this file carries no raw control byte itself.
  const NUL = String.fromCharCode(0);
  const ETX = String.fromCharCode(3);
  const DEL = String.fromCharCode(0x7f);

  it("refuses a NUL in a Write's content, naming the byte and line", () =>
    expect(checkEdit({ content: `a\nconst re = /[^${NUL}-x]/;\n` })).toMatch(/0x00 on line 2/));
  it("refuses one in an Edit's new_string", () =>
    expect(checkEdit({ old_string: "x", new_string: `"PK${ETX}"` })).toMatch(/0x03 on line 1/));
  it("refuses DEL", () => expect(checkEdit({ content: DEL })).toMatch(/0x7f/));
  it("ignores the old_string, which only has to match what is already there", () =>
    expect(checkEdit({ old_string: NUL, new_string: "clean" })).toBeNull());
  it("accepts tab, LF, CR and escapes written as text", () =>
    expect(checkEdit({ content: "a\tb\r\nc /[\\x00-\\x1f]/ – ✓\n" })).toBeNull());
  it("tolerates missing fields", () => expect(checkEdit({})).toBeNull());
});

describe("post rules", () => {
  it("maps generator sources", () => {
    expect(generatorsFor("packages/website/src/content/docs/changelog.mdx").map((g) => g.args[0])).toEqual([
      "scripts/generate-changelog-data.mjs",
    ]);
    expect(generatorsFor("changelog.d/1386-changelog-fragments.md").map((g) => g.args[0])).toEqual([
      "scripts/generate-changelog-data.mjs",
    ]);
    expect(generatorsFor("changelog.d/README.md")).toEqual([]);
    expect(generatorsFor("changelog.d/nested/1386-x.md")).toEqual([]);
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
  it("never calls a gitignored output fresh: the changelog data is reported as run and passed", () => {
    const [changelog] = generatorsFor("changelog.d/1386-changelog-fragments.md");
    const said = generatorReport(changelog, { ok: true, out: "", err: "" }, []);
    expect(said).toBe(
      "Ran changelog data (What's New pane) (node scripts/generate-changelog-data.mjs); it passed (its output is gitignored, so not listed).",
    );
    expect(said).not.toMatch(/fresh/);
    expect(generatorReport(changelog, { ok: false, out: "", err: "bad fragment\n" }, [])).toMatch(
      /^changelog data \(What's New pane\) FAILED \(node scripts\/generate-changelog-data\.mjs\):\nbad fragment$/,
    );
  });
  it("keeps the git-status report for a generator whose output is committed", () => {
    const [previews] = generatorsFor("packages/icons/black-box/fuel.svg");
    expect(previews.outputIgnored).toBeUndefined();
    expect(generatorReport(previews, { ok: true }, [])).toBe(
      "Ran icon previews (node scripts/generate-icon-previews.mjs); output already fresh.",
    );
    expect(generatorReport(previews, { ok: true }, [" M packages/icons/preview/a.svg"])).toBe(
      "Ran icon previews (node scripts/generate-icon-previews.mjs); it changed: packages/icons/preview/a.svg.",
    );
    expect(generatorsFor("packages/website/src/content/docs/changelog.mdx")[0].outputIgnored).toBe(true);
  });
  it("maps reminders", () => {
    expect(remindersFor("packages/settings/src/global-settings.ts")[0]).toMatch(/build:force/);
    expect(remindersFor("packages/deck-core/src/global-settings.ts")).toEqual([]);
    expect(remindersFor(".claude/rules/testing.md")[0]).toMatch(/needs no draft approval.*claude-rules-frontmatter/);
    expect(remindersFor("packages/deck-core/src/types.ts")).toEqual([]);
  });
  it("names the CI workflows a run list is missing", () => {
    expect(missingWorkflows([{ workflowName: "Format" }, { workflowName: "Lint" }])).toEqual(["Tests", "Typecheck"]);
    expect(missingWorkflows(undefined)).toHaveLength(4);
  });

  describe("repository scoping (#1527)", () => {
    it("reads the repository of an issue or PR URL, any case, and nothing else", () => {
      expect(repoOfUrl("https://github.com/niklam/iracedeck/issues/1527")).toBe("niklam/iracedeck");
      expect(repoOfUrl("https://github.com/Other/Repo/pull/5/files")).toBe("Other/Repo");
      expect(repoOfUrl("5")).toBeUndefined();
      expect(repoOfUrl("feature/5-x")).toBeUndefined();
      expect(repoOfUrl(undefined)).toBeUndefined();
      expect(isHomeRepo("NiklaM/iRaceDeck")).toBe(true);
      expect(isHomeRepo("niklam/iracedeck-fork")).toBe(false);
      expect(isHomeRepo(undefined)).toBe(false);
    });

    it("finds the issues gh issue create printed: a URL alone on its line", () => {
      const twelve = { url: "https://github.com/a/b/issues/12", repo: "a/b", number: 12 };
      expect(createdIssues("Creating issue in a/b\n\nhttps://github.com/a/b/issues/12\n")).toEqual([twelve]);
      expect(createdIssues("https://github.com/a/b/issues/12\r\n")).toEqual([twelve]);
      expect(createdIssues("")).toEqual([]);
      // A comment's URL, one in a sentence, or a PR's is not a created issue (#1527).
      expect(
        createdIssues(
          [
            "https://github.com/a/b/issues/5#issuecomment-123",
            "View this issue on GitHub: https://github.com/a/b/issues/6",
            "https://github.com/a/b/pull/7",
            "https://github.com/a/b/issues/12",
            "https://github.com/a/b/issues/12",
          ].join("\n"),
        ),
      ).toEqual([twelve]);
    });

    it("picks only the just-created issues, checking every one", () => {
      const [a, b, c] = [1, 2, 3].map((number) => ({ url: `u${number}`, repo: "a/b", number }));
      expect(pickCreated([], () => 0)).toEqual({ picked: [], unsure: [] });
      const ages = new Map([
        [1, 3 * 24 * 3600_000],
        [2, 30_000],
        [3, undefined],
      ]);
      expect(pickCreated([a, b, c], (i) => ages.get(i.number))).toEqual({ picked: [b], unsure: [c] });
      // One URL is not enough on its own: a `--web` create prints none, so it may be a view's.
      expect(pickCreated([a], (i) => ages.get(i.number))).toEqual({ picked: [], unsure: [] });
      expect(pickCreated([a, b], () => JUST_CREATED_MS)).toEqual({ picked: [], unsure: [] });
    });

    it("reads a GH_REPO the command assigns, in bash or PowerShell", () => {
      expect(assignedGhRepo("GH_REPO=a/b gh pr merge 5")).toBe("a/b");
      expect(assignedGhRepo(`export GH_REPO="a/b"; gh pr merge 5`)).toBe("a/b");
      expect(assignedGhRepo("$env:GH_REPO = 'a/b'; gh pr merge 5")).toBe("a/b");
      expect(assignedGhRepo("GH_REPO=$R gh pr merge 5")).toBeNull();
      expect(assignedGhRepo(`GH_REPO="$R" gh pr merge 5`)).toBeNull();
      expect(assignedGhRepo("gh pr merge 5")).toBeUndefined();
      expect(assignedGhRepo("export GH_REPO=a/b; export GH_REPO=c/d; ")).toBe("c/d");
      expect(assignedGhRepo("export GH_REPO=a/b && env GH_REPO=c/d ")).toBe("c/d");
      expect(assignedGhRepo("(cd x && GH_REPO=a/b ")).toBe("a/b");
      // Neither a prefix of another command nor an unexported assignment reaches the merge.
      expect(assignedGhRepo("GH_REPO=a/b gh pr view 3 && ")).toBeUndefined();
      expect(assignedGhRepo("GH_REPO=a/b; ")).toBeUndefined();
      expect(assignedGhRepo("$(GH_REPO=a/b gh pr view 3) ")).toBeUndefined();
      // The masked twin hides a quoted mention; the value is read from the raw text.
      const raw = `echo "GH_REPO=x/y"; GH_REPO='a/b' `;
      expect(
        assignedGhRepo(
          raw,
          raw.replace(/"[^"]*"|'[^']*'/g, (q) => q[0] + "_".repeat(q.length - 2) + q[0]),
        ),
      ).toBe("a/b");
      expect(assignedGhRepo(`echo "GH_REPO=x/y"`, `echo "__________"`)).toBeUndefined();
    });

    it("reads the repository each gh issue create names", () => {
      expect(issueCreateRepos("gh issue create -R a/b --title x")).toEqual(["a/b"]);
      expect(issueCreateRepos("gh issue create --repo=git@github.com:a/b.git")).toEqual(["a/b"]);
      expect(issueCreateRepos("gh issue create -Ra/b --web")).toEqual(["a/b"]);
      expect(issueCreateRepos("GH_REPO=a/b gh issue create --web")).toEqual(["a/b"]);
      // The flag beats the environment; an unexported or another command's assignment does not reach it.
      expect(issueCreateRepos("GH_REPO=c/d gh issue create -R a/b")).toEqual(["a/b"]);
      expect(issueCreateRepos("GH_REPO=c/d; gh issue create --web")).toEqual([undefined]);
      expect(issueCreateRepos("gh issue create -R $R")).toEqual([null]);
      expect(issueCreateRepos("gh issue create --title x")).toEqual([undefined]);
      expect(issueCreateRepos("gh issue create -R a/b --web && gh issue create --web")).toEqual(["a/b", undefined]);
      // The masked twin hides a flag inside a quoted body.
      const raw = `gh issue create --body "-R x/y" --web`;
      expect(issueCreateRepos(raw, `gh issue create --body "______" --web`)).toEqual([undefined]);
      expect(issueCreateRepos("echo nothing")).toEqual([]);
    });

    it("picks a merge's repository in gh's order: URL, flag, environment", () => {
      expect(mergeRepo({ ref: "https://github.com/a/b/pull/5", repo: "c/d" }, "e/f")).toBe("a/b");
      expect(mergeRepo({ ref: "5", repo: "c/d" }, "e/f")).toBe("c/d");
      expect(mergeRepo({ ref: "5" }, "e/f")).toBe("e/f");
      expect(mergeRepo({ ref: "5" }, undefined)).toBeUndefined();
      expect(mergeRepo({ ref: "5", repo: null }, "e/f")).toBeNull();
      expect(mergeRepo({ ref: "5" }, null)).toBeNull();
      expect(mergeRepo({ repo: "github.com/c/d" })).toBe("c/d");
      expect(mergeRepo({ repo: "https://github.com/c/d.git" })).toBe("c/d");
      expect(mergeRepo({ repo: "git@github.com:niklam/iracedeck.git" })).toBe("niklam/iracedeck");
      expect(mergeRepo({ repo: "ssh://git@github.com/niklam/iracedeck.git" })).toBe("niklam/iracedeck");
      expect(mergeRepo({ repo: "git@ghe.example.com:niklam/iracedeck.git" })).toBe("ghe.example.com/niklam/iracedeck");
      expect(mergeRepo({ repo: "ghe.example.com/niklam/iracedeck" })).toBe("ghe.example.com/niklam/iracedeck");
    });

    it("moves only the closing issues of the home repository", () => {
      const ref = (owner, name, number) => ({
        number,
        url: `https://github.com/${owner}/${name}/issues/${number}`,
        repository: { name, owner: { login: owner } },
      });
      const title = "fix(x): y (#1527)";
      expect(
        boardIssues({
          title,
          closingIssuesReferences: [ref("niklam", "iracedeck", 1527), ref("lint-staged", "lint-staged", 1865)],
        }),
      ).toEqual({ issues: [1527], foreign: ["lint-staged/lint-staged#1865"] });
      // Only foreign closing issues: the title's own (#n) is the card, as with none.
      expect(boardIssues({ title, closingIssuesReferences: [ref("a", "b", 9)] })).toEqual({
        issues: [1527],
        foreign: ["a/b#9"],
      });
      expect(boardIssues({ title: "chore: x", closingIssuesReferences: [] })).toEqual({ issues: [], foreign: [] });
      // The repository object alone is enough when the URL is missing.
      expect(
        boardIssues({
          title: "x",
          closingIssuesReferences: [{ number: 3, repository: { name: "IRaceDeck", owner: { login: "niklam" } } }],
        }),
      ).toEqual({ issues: [3], foreign: [] });
    });
  });

  it("parses the --repo of a gh pr merge (#1527)", () => {
    expect(firstMerge("gh pr merge 5 -R a/b --squash").repo).toBe("a/b");
    expect(firstMerge("gh pr merge 5 --repo=a/b").repo).toBe("a/b");
    expect(firstMerge("gh pr merge 5 -Ra/b").repo).toBe("a/b");
    expect(firstMerge(`gh pr merge 5 --repo "a/b"`).repo).toBe("a/b");
    expect(firstMerge(`gh pr merge 5 -R "$R"`)).toMatchObject({ repo: null, ref: "5", readable: true });
    expect(firstMerge("gh pr merge 5 -R")).toMatchObject({ repo: null });
    // The mask leaves a bare variable as it is: it is still not a literal.
    for (const command of [
      "gh pr merge 5 --repo $R",
      "gh pr merge 5 --repo=$R",
      "gh pr merge 5 -R$R",
      "gh pr merge 5 -R `r`",
    ])
      expect(firstMerge(command).repo, command).toBeNull();
    expect(firstMerge("gh pr merge 5 --squash").repo).toBeUndefined();
    // A body that mentions the flag is not the merge's own.
    expect(firstMerge(`gh pr merge 5 --body "-R a/b"`).repo).toBeUndefined();
    expect(firstMerge("gh pr merge 5 -R a/b -R c/d").repo).toBe("c/d");
  });
});
