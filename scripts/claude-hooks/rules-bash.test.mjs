import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkBash, classifyCheck, cmd, gitCwd, words } from "./rules-bash.mjs";

// Built through `path`, not written as Windows literals: CI runs on Linux, where
// `C:\repo\master` is a RELATIVE path and every resolve lands under the runner's cwd.
const REPO = path.resolve("/repo");
const MASTER = path.join(REPO, "master");
const tree = (...parts) => path.join(REPO, ...parts);

/** A context where every git/gh fact is injectable; defaults describe a clean master checkout. */
function ctx(overrides = {}) {
  return {
    cwd: MASTER,
    branch: () => "master",
    staged: () => [],
    modified: () => [],
    untracked: () => [],
    mainRoot: () => MASTER,
    originFresh: () => ({ fresh: true, local: "aaaaaaaaa", remote: "aaaaaaaaa" }),
    // The default describes issues that ALREADY have their spec, so the
    // worktree cases below test placement and freshness as they always did;
    // the spec-gate cases override with `specFiles: () => []`. `specText`
    // returning undefined is the fail-open contract the commit rule rests on
    // — a spec whose bytes the hook cannot read must still commit.
    specFiles: () => ["2026-01-01-issue-1-topic.md", "2026-01-01-issue-5-topic.md", "2026-01-01-issue-6-topic.md"],
    specText: () => undefined,
    tracked: () => false,
    issueLabels: () => undefined,
    linkTargets: () => [],
    packages: () => ({ "@iracedeck/logger": { dir: "x", scripts: ["build", "typecheck"] } }),
    isInside: (c, p) => c.toLowerCase() === p.toLowerCase() || c.toLowerCase().startsWith(p.toLowerCase() + path.sep),
    prView: () => undefined,
    // Unanswerable by default, so a merge case that does not set them up fails
    // closed exactly as a real git or gh failure would (#1307).
    replayRebase: () => undefined,
    baseChangedSince: () => undefined,
    ...overrides,
  };
}

const deny = (cmd, c = ctx()) => {
  const v = checkBash(cmd, c);
  expect(typeof v, `expected a deny for: ${cmd}`).toBe("string");
  return v;
};
const asks = (cmd, c = ctx()) => {
  const v = checkBash(cmd, c);
  expect(v && v.ask, `expected an ask for: ${cmd}`).toBeTruthy();
  return v.ask;
};
const passes = (cmd, c = ctx()) => expect(checkBash(cmd, c), `expected a pass for: ${cmd}`).toBeNull();

describe("helpers", () => {
  it("gitCwd honours -C", () => {
    expect(gitCwd("git -C ../ir-5 status", MASTER)).toBe(tree("ir-5"));
    expect(gitCwd("git status", MASTER)).toBe(MASTER);
  });
  it("gitCwd scopes -C to the segment the rule matched, not to a later chained git", () => {
    const add = cmd(/git\s+(?:-C\s+\S+\s+)?worktree\s+add\b/);
    expect(gitCwd("git worktree add ../ir-5 -b ir-5 && git -C ../ir-5 log -1", MASTER, add)).toBe(MASTER);
    expect(gitCwd("git fetch origin; git -C ../ir-5 worktree add ../ir-6", MASTER, add)).toBe(tree("ir-5"));
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd("git -C ../ir-5 status | cat", MASTER, status)).toBe(tree("ir-5"));
  });
  it("gitCwd walks the `cd`s chained ahead of the matched command", () => {
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd("cd ../ir-5 && git status", MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd(`cd "${tree("ir-5")}" && git status`, MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd("cd ../ir-5 && cd ../ir-6 && git status", MASTER, status)).toBe(tree("ir-6"));
    expect(gitCwd("cd ../ir-5 && git -C ../ir-6 status", MASTER, status)).toBe(tree("ir-6"));
    expect(gitCwd("git status && cd ../ir-5", MASTER, status)).toBe(MASTER); // a later cd moves nothing
    expect(gitCwd("cd - && git status", MASTER, status)).toBe(MASTER); // unknowable, stays put
  });
  it("words respects quotes", () => {
    expect(words(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
  });
});

describe("harmless commands pass", () => {
  it.each([
    "ls",
    "git status",
    "pnpm build",
    "pnpm build && pnpm test",
    "set -o pipefail; pnpm build 2>&1 | tail",
    "gh pr view 1",
    "git diff origin/master...HEAD",
  ])("%s", (c) => passes(c));
});

describe("a trapped shape merely MENTIONED is not a hit", () => {
  it.each([
    "grep -rn 'pnpm exec vitest' .claude",
    "echo 'never run pnpm build --force'",
    "grep -n 'git push' file.md",
    "rg 'gh pr merge' scripts",
    "grep 'git diff master..HEAD' docs",
    "echo IRACEDECK_MOCK=0",
    "python x.py 'jq . file'",
  ])("%s", (c) => passes(c));
  it("still catches the shape at command position after a chain, a pipe, a subshell or an env prefix", () => {
    deny("cd x && pnpm build --force");
    deny("true; pnpm exec vitest run");
    deny("(npx vitest)");
    deny("FOO=1 pnpm build --force");
    deny("echo x | jq .");
  });
});

// #1193 review: `checkBash` used to return the FIRST verdict, so an ask rule
// placed early in the list swallowed a deny rule placed later whenever one
// chained command matched both — and confirming the ask ran the denied shape.
describe("a deny anywhere beats an ask anywhere, whatever the rule order", () => {
  const noSpec = ctx({ specFiles: () => [] });
  it("denies a spec-less worktree add chained ahead of a denied shape", () =>
    expect(deny("git worktree add ../ir-42 -b ir-42 origin/master && jq . x.json", noSpec)).toMatch(/jq/));
  it("denies a tag push chained ahead of a denied shape", () =>
    expect(deny("git push origin v9.9.9 && pnpm build --force")).toMatch(/--force/));
  it("still asks when nothing denies", () =>
    expect(asks("git worktree add ../ir-42 -b ir-42 origin/master && git -C ../ir-42 log -1", noSpec)).toMatch(
      /No spec/,
    ));
  it("reports the first of two asks", () =>
    expect(asks("git push origin v9.9.9 && git worktree add ../ir-42 -b ir-42 origin/master", noSpec)).toMatch(
      /release/,
    ));
});

describe("code review", () => {
  it("refuses --fix", () => expect(deny("claude /code-review high --fix")).toMatch(/--fix/));
});

describe("git push", () => {
  // The plain-push ask was dropped on 2026-09-08 (see hooks.md): the hook
  // cannot see whether the maintainer asked for the push, so it prompted
  // regardless. Only a tag push asks.
  it("lets a plain push through", () => {
    passes("git push origin master");
    passes("git push -u origin ir-1:ir-1 2>&1 | tail -2", ctx({ branch: () => "ir-1" }));
    passes("cd ../ir-1143 && git push -u origin ir-1143:ir-1143", ctx({ branch: () => "ir-1143" }));
  });
  it("lets the spec workflow's add + commit -- <spec> + push through", () =>
    passes(
      [
        `cd ${MASTER} && git add docs/superpowers/specs/a.md && git commit -q -m "docs(specs): title (#1147)`,
        "",
        `Claude-Session: https://claude.ai/code/session_x" -- docs/superpowers/specs/a.md && git push origin HEAD:master 2>&1 | tail -1`,
      ].join("\n"),
    ));
  it("asks on a tag push", () => {
    expect(asks("git push origin v3.2.0")).toMatch(/release/);
    expect(asks("git push --tags")).toMatch(/release/);
  });
  it("ignores --dry-run", () => passes("git push --dry-run origin v3.2.0"));
});

describe("gh pr create", () => {
  it("passes with a well-formed title", () => passes(`gh pr create --title "feat(x): thing (#12)" --body-file -`));
  it("passes with no title (gh prompts for one)", () => passes("gh pr create --fill"));
  it("denies a title without the issue number", () =>
    expect(deny(`gh pr create --title "feat(x): thing"`)).toMatch(/#<issue>/));
  it("denies a title without a type", () => deny(`gh pr create -t "thing (#12)"`));
  it("denies --body @-", () => expect(deny(`gh pr create --title "fix: x (#1)" --body @-`)).toMatch(/--body-file/));
});

describe("gh pr merge", () => {
  const head = "1111111111111111111111111111111111111111";
  const green = () => ({
    number: 7,
    state: "OPEN",
    headRefOid: head,
    headRefName: "ir-7",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
    ],
    reviews: [{ author: { login: "coderabbitai" }, state: "APPROVED", commit: { oid: head } }],
  });
  it("passes a green, approved-at-head squash merge", () => passes("gh pr merge 7 --squash", ctx({ prView: green })));
  it("refuses when gh cannot read the PR", () =>
    expect(deny("gh pr merge 7 --squash")).toMatch(/refusing to merge blind/));
  it("refuses a non-open PR", () =>
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => ({ ...green(), state: "MERGED" }) }))).toMatch(/MERGED/));
  it("refuses a feature PR without --squash", () =>
    expect(deny("gh pr merge 7", ctx({ prView: green }))).toMatch(/squash/));
  it("refuses a release back-merge with --squash", () =>
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => ({ ...green(), headRefName: "release/3.2" }) }))).toMatch(
      /regular merge/,
    ));
  it("passes a release back-merge with --merge", () =>
    passes("gh pr merge 7 --merge", ctx({ prView: () => ({ ...green(), headRefName: "release/3.2" }) })));
  it("refuses a stale approval (no CodeRabbit review at head)", () => {
    const pr = green();
    pr.reviews = [
      {
        author: { login: "coderabbitai" },
        state: "APPROVED",
        commit: { oid: "0000000000000000000000000000000000000000" },
      },
    ];
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/previous head/);
  });
  it("accepts a standing approval plus an incremental review at head", () => {
    const pr = green();
    pr.reviews = [
      {
        author: { login: "coderabbitai" },
        state: "APPROVED",
        commit: { oid: "0000000000000000000000000000000000000000" },
      },
      {
        author: { login: "coderabbitai" },
        state: "COMMENTED",
        body: "Actionable comments posted: 0",
        commit: { oid: head },
      },
    ];
    passes("gh pr merge 7 --squash", ctx({ prView: () => pr }));
  });
  it("ignores the maintainer's own thread replies when looking for the reviewer", () => {
    const pr = green();
    pr.reviews = [{ author: { login: "niklam" }, state: "COMMENTED", commit: { oid: head } }];
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/no CodeRabbit review/);
  });
  // #1307: a head that is a pure rebase of the commit CodeRabbit last reviewed.
  describe("a pure rebase of the reviewed head", () => {
    const reviewedOid = "2222222222222222222222222222222222222222";
    const olderOid = "3333333333333333333333333333333333333333";
    const baseOid = "4444444444444444444444444444444444444444";
    const pinned = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const rebased = () => {
      const pr = green();
      pr.baseRefOid = baseOid;
      pr.reviews = [
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          commit: { oid: reviewedOid },
          submittedAt: "2026-10-03T10:00:00Z",
        },
      ];
      return pr;
    };
    const clean = { ok: true, differing: [], conflicted: [], lineMismatch: [] };
    /** A context whose replay answers `result`, recording every git and gh question asked. */
    const arrange = (result, opts = {}) => {
      const prView = opts.prView ?? rebased;
      // Read by `in`, not a destructuring default: the gh-failure case passes `undefined` on purpose.
      const retargeted = "retargeted" in opts ? opts.retargeted : false;
      const calls = { replay: [], timeline: [] };
      const c = ctx({
        prView,
        replayRebase: (args) => {
          calls.replay.push(args);
          return result;
        },
        baseChangedSince: (...args) => {
          calls.timeline.push(args);
          return retargeted;
        },
      });
      return { c, calls };
    };

    it("passes a clean replay, handing it the reviewed commit, the head and the PR's own base sha", () => {
      const { c, calls } = arrange(clean);
      passes(pinned, c);
      expect(calls.replay).toEqual([{ reviewed: reviewedOid, head, base: baseOid, dir: MASTER }]);
      expect(calls.timeline).toEqual([[7, "2026-10-03T10:00:00Z", MASTER]]);
    });

    it("refuses a short --match-head-commit prefix — GitHub takes only a full sha", () =>
      expect(deny(`gh pr merge 7 --squash --match-head-commit ${head.slice(0, 9)}`, arrange(clean).c)).toMatch(
        /pin it/,
      ));

    it("reads the pin from the merge's own arguments, wherever it sits among them", () => {
      passes(`gh pr merge --match-head-commit ${head} 7 --squash`, arrange(clean).c);
      passes(`gh pr merge 7 --squash --match-head-commit=${head}`, arrange(clean).c);
    });

    it("refuses a pin that is not the merge's own: in another command, a comment or a body text", () => {
      for (const command of [
        `echo --match-head-commit ${head}; gh pr merge 7 --squash`,
        `gh pr merge 7 --squash # --match-head-commit ${head}`,
        `gh pr merge 7 --squash --body "--match-head-commit ${head}"`,
      ])
        expect(deny(command, arrange(clean).c)).toMatch(/pin it/);
    });

    it("takes the LAST --match-head-commit, as gh does", () =>
      expect(
        deny(`gh pr merge 7 --squash --match-head-commit ${head} --match-head-commit ${olderOid}`, arrange(clean).c),
      ).toMatch(/pin it/));

    it("refuses an unpinned merge before any git work, naming the flag to add", () => {
      const { c, calls } = arrange(clean);
      expect(deny("gh pr merge 7 --squash", c)).toMatch(new RegExp(`--match-head-commit ${head}`));
      expect(calls.replay).toHaveLength(0);
    });

    it("refuses a pin to another commit", () =>
      expect(deny(`gh pr merge 7 --squash --match-head-commit ${olderOid}`, arrange(clean).c)).toMatch(/pin it/));

    it("refuses a head whose replayed tree differs, naming the file", () => {
      const why = deny(pinned, arrange({ ...clean, differing: ["src/a.ts"] }).c);
      expect(why).toMatch(/not a pure rebase of it \(changed: src\/a\.ts\)/);
      expect(why).toMatch(/@coderabbitai review/);
    });

    it("asks, naming the files, when only conflicted files differ and their lines match", () => {
      const v = asks(pinned, arrange({ ok: true, differing: ["c.json"], conflicted: ["c.json"], lineMismatch: [] }).c);
      expect(v).toMatch(/conflicted in c\.json/);
      expect(v).toMatch(/maintainer confirms/);
    });

    it("refuses a conflicted file whose lines differ, marking it conflicted", () =>
      expect(
        deny(pinned, arrange({ ok: true, differing: ["c.json"], conflicted: ["c.json"], lineMismatch: ["c.json"] }).c),
      ).toMatch(/changed: c\.json \(conflicted\)/));

    it("refuses when a clean file differs even though the conflicted ones match", () =>
      expect(
        deny(pinned, arrange({ ok: true, differing: ["a.ts", "c.json"], conflicted: ["c.json"], lineMismatch: [] }).c),
      ).toMatch(/changed: a\.ts\)/));

    it("refuses a conflicted file the head did NOT change from the replay — a marker-free conflict is still unreviewed", () =>
      expect(
        deny(pinned, arrange({ ok: true, differing: [], conflicted: ["old.sh"], lineMismatch: ["old.sh"] }).c),
      ).toMatch(/changed: old\.sh \(conflicted\)/));

    it("asks about a conflicted file whose lines match even when its tree entry equals the replay's", () =>
      expect(asks(pinned, arrange({ ok: true, differing: [], conflicted: ["old.sh"], lineMismatch: [] }).c)).toMatch(
        /conflicted in old\.sh/,
      ));

    it("names at most five differing files", () => {
      const many = Array.from({ length: 7 }, (_, i) => `f${i}.ts`);
      expect(deny(pinned, arrange({ ...clean, differing: many }).c)).toMatch(
        /changed: f0\.ts, f1\.ts, f2\.ts, f3\.ts, f4\.ts, and 2 more/,
      );
    });

    it("refuses a follow-up push on top of the reviewed commit", () =>
      expect(
        deny(pinned, arrange({ ok: true, followUp: 2, differing: [], conflicted: [], lineMismatch: [] }).c),
      ).toMatch(/adds 2 commit\(s\) after it/));

    it("refuses with the replay's reason when it could not run, and when there is no replay at all", () => {
      expect(deny(pinned, arrange({ ok: false, reason: "git could not fetch every commit" }).c)).toMatch(
        /and git could not fetch every commit\./,
      );
      expect(deny(pinned, arrange(undefined).c)).toMatch(/could not run/);
    });

    it("refuses a PR whose base branch changed after the review, before any replay", () => {
      const { c, calls } = arrange(clean, { retargeted: true });
      expect(deny(pinned, c)).toMatch(/base branch was retargeted or force-pushed after that review/);
      expect(calls.replay).toHaveLength(0);
    });

    it("refuses when gh cannot say whether the base changed", () =>
      expect(deny(pinned, arrange(clean, { retargeted: undefined }).c)).toMatch(
        /could not read whether the base branch moved/,
      ));

    it("refuses a release back-merge on this path, before any gh or git work", () => {
      const { c, calls } = arrange(clean, { prView: () => ({ ...rebased(), headRefName: "release/3.5" }) });
      expect(deny(`gh pr merge 7 --merge --match-head-commit ${head}`, c)).toMatch(/back-merge lands its commits/);
      expect(calls.replay).toHaveLength(0);
      expect(calls.timeline).toHaveLength(0);
    });

    it("compares the NEWEST review, not an older approval it would reach past", () => {
      const pr = rebased();
      pr.reviews = [
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          commit: { oid: olderOid },
          submittedAt: "2026-10-03T09:00:00Z",
        },
        {
          author: { login: "coderabbitai" },
          state: "COMMENTED",
          body: "Actionable comments posted: 1",
          commit: { oid: reviewedOid },
          submittedAt: "2026-10-03T10:00:00Z",
        },
      ];
      const { c, calls } = arrange(clean, { prView: () => pr });
      passes(pinned, c);
      expect(calls.replay[0].reviewed).toBe(reviewedOid);
    });

    it("finds the newest review by submittedAt whatever the list order", () => {
      const pr = rebased();
      pr.reviews = [
        {
          author: { login: "coderabbitai" },
          state: "COMMENTED",
          body: "Actionable comments posted: 1",
          commit: { oid: reviewedOid },
          submittedAt: "2026-10-03T10:00:00Z",
        },
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          commit: { oid: olderOid },
          submittedAt: "2026-10-03T09:00:00Z",
        },
      ];
      const { c, calls } = arrange(clean, { prView: () => pr });
      passes(pinned, c);
      expect(calls.replay[0].reviewed).toBe(reviewedOid);
    });

    it("runs no git or gh work while a cheap check already refuses, and says the rebase check is pending", () => {
      const pr = rebased();
      pr.statusCheckRollup[0] = { __typename: "CheckRun", name: "Tests", status: "IN_PROGRESS" };
      const { c, calls } = arrange(clean, { prView: () => pr });
      expect(deny(pinned, c)).toMatch(/pending: Tests; the head has no CodeRabbit review of its own/);
      expect(calls.replay).toHaveLength(0);
      expect(calls.timeline).toHaveLength(0);
    });

    it("still requires CodeRabbit to have approved at some point", () => {
      const pr = rebased();
      pr.reviews[0].state = "COMMENTED";
      pr.reviews[0].body = "Actionable comments posted: 1";
      expect(deny(pinned, arrange(clean, { prView: () => pr }).c)).toMatch(/never approved/);
    });

    it("does not let a look-alike login stand in for CodeRabbit", () => {
      const pr = rebased();
      pr.reviews.push({ author: { login: "coderabbit-fan" }, state: "COMMENTED", commit: { oid: head } });
      const { c, calls } = arrange({ ...clean, differing: ["a.ts"] }, { prView: () => pr });
      expect(deny(pinned, c)).toMatch(/not a pure rebase/);
      expect(calls.replay).toHaveLength(1);
    });

    it("ignores CodeRabbit's thread replies — an empty-body COMMENTED review at whatever the head was", () => {
      const pr = rebased();
      pr.reviews.push({
        author: { login: "coderabbitai" },
        state: "COMMENTED",
        body: "",
        commit: { oid: head },
        submittedAt: "2026-10-03T11:00:00Z",
      });
      const { c, calls } = arrange({ ...clean, differing: ["a.ts"] }, { prView: () => pr });
      expect(deny(pinned, c)).toMatch(/previous head 222222222/);
      expect(calls.replay[0].reviewed).toBe(reviewedOid);
      expect(calls.timeline[0][1]).toBe("2026-10-03T10:00:00Z");
    });

    it("accepts the bot's [bot]-suffixed login", () => {
      const pr = green();
      pr.reviews = [{ author: { login: "coderabbitai[bot]" }, state: "APPROVED", commit: { oid: head } }];
      passes("gh pr merge 7 --squash", ctx({ prView: () => pr }));
    });

    it("does no rebase work, and needs no pin, when a review sits at head", () => {
      const { c, calls } = arrange(clean, { prView: green });
      passes("gh pr merge 7 --squash", c);
      expect(calls.replay).toHaveLength(0);
    });

    it("does not honour an --admin that is not the merge's own", () => {
      const { c } = arrange({ ...clean, differing: ["a.ts"] });
      expect(deny(`gh pr merge 7 --squash --body "never use --admin" --match-head-commit ${head}`, c)).toMatch(
        /not a pure rebase/,
      );
    });

    it("--admin skips the rebase check with the other review checks", () => {
      const { c, calls } = arrange({ ...clean, differing: ["a.ts"] });
      passes("gh pr merge 7 --squash --admin", c);
      expect(calls.replay).toHaveLength(0);
    });
  });

  it("refuses when reviewDecision is not APPROVED", () =>
    expect(
      deny("gh pr merge 7 --squash", ctx({ prView: () => ({ ...green(), reviewDecision: "REVIEW_REQUIRED" }) })),
    ).toMatch(/REVIEW_REQUIRED/));
  it("refuses while a CodeRabbit review is running (pending StatusContext)", () => {
    const pr = green();
    pr.statusCheckRollup[1] = { __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" };
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/pending: CodeRabbit/);
  });
  it("refuses a red check", () => {
    const pr = green();
    pr.statusCheckRollup[0] = { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "FAILURE" };
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/not green: Tests/);
  });
  it("refuses an unknown rollup node type (fails closed)", () => {
    const pr = green();
    pr.statusCheckRollup.push({ __typename: "Mystery" });
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/not green: Mystery/);
  });
  it("refuses BLOCKED", () =>
    expect(
      deny("gh pr merge 7 --squash", ctx({ prView: () => ({ ...green(), mergeStateStatus: "BLOCKED" }) })),
    ).toMatch(/BLOCKED/));
  it("--admin skips the review checks but not the checks", () => {
    passes(
      "gh pr merge 7 --squash --admin",
      ctx({ prView: () => ({ ...green(), reviewDecision: "REVIEW_REQUIRED", reviews: [] }) }),
    );
    const pr = {
      ...green(),
      reviews: [],
      statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", status: "IN_PROGRESS" }],
    };
    deny("gh pr merge 7 --squash --admin", ctx({ prView: () => pr }));
  });
  it("refuses more than one merge in a command — each is checked on its own", () =>
    expect(deny("gh pr merge 7 --squash && gh pr merge 8 --squash", ctx({ prView: green }))).toMatch(
      /One `gh pr merge` per command/,
    ));

  it("refuses a second merge joined by a single & or |&, and one the split cannot see", () => {
    for (const command of [
      `gh pr merge 7 --squash & gh pr merge 8 --squash --admin`,
      `gh pr merge 7 --squash |& gh pr merge 8 --squash`,
      `gh pr merge 7 --squash $(gh pr merge 8 --squash)`,
    ])
      expect(deny(command, ctx({ prView: green }))).toMatch(/One `gh pr merge` per command/);
  });

  it("checks a merge behind a shell keyword or a command wrapper, not only at a bare command position", () => {
    for (const command of [
      "if true; then gh pr merge 7 --squash; fi",
      "while x; do gh pr merge 7 --squash; done",
      "env GH_DEBUG=1 gh pr merge 7 --squash",
      "env -i gh pr merge 7 --squash",
      "env -u GH_TOKEN -i PATH=/bin gh pr merge 7 --squash",
      "exec -a merger gh pr merge 7 --squash",
      "time -p gh pr merge 7 --squash",
      "nohup gh pr merge 7 --squash",
      "! gh pr merge 7 --squash",
    ])
      expect(deny(command, ctx({ prView: () => ({ ...green(), reviewDecision: "REVIEW_REQUIRED" }) }))).toMatch(
        /REVIEW_REQUIRED/,
      );
    expect(deny("if true; then gh pr merge 7 --squash; gh pr merge 8 --squash; fi", ctx({ prView: green }))).toMatch(
      /One `gh pr merge` per command/,
    );
  });

  it("still lets a mere mention through", () => passes("grep -n 'then gh pr merge' notes.md", ctx({ prView: green })));

  it("joins every ask in a chain into the one prompt, so none runs unseen", () => {
    const pr = green();
    pr.baseRefOid = "4444444444444444444444444444444444444444";
    pr.reviews = [
      {
        author: { login: "coderabbitai" },
        state: "APPROVED",
        commit: { oid: "2".repeat(40) },
        submittedAt: "2026-10-03T10:00:00Z",
      },
    ];
    const c = ctx({
      prView: () => pr,
      baseChangedSince: () => false,
      replayRebase: () => ({ ok: true, differing: ["c.json"], conflicted: ["c.json"], lineMismatch: [] }),
    });
    const v = asks(`git push origin v3.6.0 && gh pr merge 7 --squash --match-head-commit ${head}`, c);
    expect(v).toMatch(/Pushing a tag cuts a release/);
    expect(v).toMatch(/conflicted in c\.json/);
  });

  it("classifyCheck reads CheckRun and StatusContext by __typename", () => {
    expect(classifyCheck({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" })).toBe("ok");
    expect(classifyCheck({ __typename: "CheckRun", status: "QUEUED" })).toBe("pending");
    expect(classifyCheck({ __typename: "StatusContext", state: "EXPECTED" })).toBe("pending");
    expect(classifyCheck({ __typename: "StatusContext", state: "FAILURE" })).toBe("bad");
    expect(classifyCheck({})).toBe("unknown");
  });
});

describe("git commit", () => {
  it("denies a spec on a feature branch", () =>
    expect(
      deny("git commit -m x", ctx({ branch: () => "ir-1", staged: () => ["docs/superpowers/specs/a.md"] })),
    ).toMatch(/never on a feature branch/));
  it("allows a spec on master", () =>
    passes("git commit -m x", ctx({ staged: () => ["docs/superpowers/specs/a.md"] })));

  // #1193. The header block held at 98 % on its own, but "Out of scope" fell
  // 50 % -> 17 % and Testing/Verification 88 % -> 70 % once the spec became a
  // filing-time decision record — so the commit now reads what it carries.
  describe("the required sections", () => {
    const HEADER = "> **Issue:** [#9](u) · **Supersedes:** _none_ · **Superseded by:** _none_";
    const spec = (body) => ctx({ staged: () => ["docs/superpowers/specs/a.md"], specText: () => body });
    const whole = [HEADER, "# T", "## Out of scope", "none", "## Testing", "vitest"].join("\n\n");

    it("passes a spec carrying all three", () => passes("git commit -m x", spec(whole)));
    it("denies a missing header block", () =>
      expect(deny("git commit -m x", spec(whole.replace(HEADER, "")))).toMatch(/header block/));
    it("denies a missing Out of scope section", () =>
      expect(deny("git commit -m x", spec(whole.replace("## Out of scope\n\nnone\n\n", "")))).toMatch(/Out of scope/));
    it("denies a missing Testing section", () =>
      expect(deny("git commit -m x", spec(whole.replace("## Testing\n\nvitest", "")))).toMatch(
        /Testing or Verification/,
      ));
    it("names every missing piece at once", () => {
      const v = deny("git commit -m x", spec("# T\n\nprose only"));
      expect(v).toMatch(/header block/);
      expect(v).toMatch(/Out of scope/);
      expect(v).toMatch(/Testing or Verification/);
    });
    it("accepts the heading spellings already in the corpus", () => {
      for (const scope of ["## Out of scope", "## Non-goals", "### What this deliberately does not do"])
        for (const test of ["## Testing", "## Verification", "## Tests", "**Manual verification**", "**Testing:**"])
          passes("git commit -m x", spec([HEADER, "# T", scope, "x", test, "y"].join("\n\n")));
    });
    it("reads headings, not prose — a passing mention of a test is not a test plan", () =>
      expect(
        deny(
          "git commit -m x",
          spec([HEADER, "# T", "## Out of scope", "We tested it and verified nothing."].join("\n\n")),
        ),
      ).toMatch(/Testing or Verification/));
    // #1193 review: both used to pass, one of them in the corpus (#1145).
    it("does not take a paragraph that merely OPENS in bold for a heading", () =>
      expect(
        deny(
          "git commit -m x",
          spec(
            [HEADER, "# T", "## Out of scope", "x", "**Tests assert structure, not pixels.** Then prose."].join("\n\n"),
          ),
        ),
      ).toMatch(/Testing or Verification/));
    it("does not take a comment inside a code fence for a heading", () =>
      expect(
        deny(
          "git commit -m x",
          spec([HEADER, "# T", "## Out of scope", "x", "```bash\n# verify the build\npnpm build\n```"].join("\n\n")),
        ),
      ).toMatch(/Testing or Verification/));
    it("still reads the headings after a fenced block closes", () =>
      passes(
        "git commit -m x",
        spec([HEADER, "# T", "```text\n# not a heading\n```", "## Out of scope", "x", "## Testing", "y"].join("\n\n")),
      ));
    it("passes when the text cannot be read at all (fail open)", () =>
      passes("git commit -m x", ctx({ staged: () => ["docs/superpowers/specs/a.md"], specText: () => undefined })));
    it("leaves an AMENDMENT alone — the requirement is forward-only", () =>
      passes(
        "git commit -m x",
        ctx({ staged: () => ["docs/superpowers/specs/a.md"], specText: () => "# T", tracked: () => true }),
      ));
    it("still checks the new spec in a commit that also amends an old one", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({
            staged: () => ["docs/superpowers/specs/old.md", "docs/superpowers/specs/new.md"],
            specText: () => "# T",
            tracked: (_d, f) => f.endsWith("old.md"),
          }),
        ),
      ).toMatch(/new\.md/));
    it("checks every spec the commit carries", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({
            staged: () => ["docs/superpowers/specs/a.md", "docs/superpowers/specs/b.md"],
            specText: (_d, f) => (f.endsWith("a.md") ? whole : "# T"),
          }),
        ),
      ).toMatch(/b\.md/));
    it("still denies the feature branch first — the branch is the bigger mistake", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({ branch: () => "ir-1", staged: () => ["docs/superpowers/specs/a.md"], specText: () => "# T" }),
        ),
      ).toMatch(/never on a feature branch/));

    // #1193 review (CodeRabbit): the bytes checked must be the bytes committed.
    describe("reads each spec from where the commit takes it", () => {
      const A = "docs/superpowers/specs/a.md";
      // The index copy and the working copy disagree; each case says which one the commit takes.
      const split = (index, worktree, o = {}) =>
        ctx({ specText: (_d, _f, from) => (from === "index" ? index : worktree), ...o });
      it("the index, for a spec staged before the command", () => {
        expect(deny("git commit -m x", split("# T", whole, { staged: () => [A] }))).toMatch(/a\.md/);
        passes("git commit -m x", split(whole, "# T", { staged: () => [A] }));
      });
      it("the working copy, for a spec a chained `git add` stages", () => {
        expect(deny(`git add ${A} && git commit -m x`, split(whole, "# T"))).toMatch(/a\.md/);
        passes(`git add ${A} && git commit -m x`, split("# T", whole, { staged: () => [A] }));
      });
      it("the working copy, for `-a`", () =>
        expect(deny("git commit -am x", split(whole, "# T", { staged: () => [A] }))).toMatch(/a\.md/));
      it("the working copy, for a pathspec commit", () =>
        expect(deny(`git commit -m x -- ${A}`, split(whole, "# T", { staged: () => [A] }))).toMatch(/a\.md/));
    });
  });
  it("reads -a as staged plus modified", () =>
    deny("git commit -am x", ctx({ branch: () => "ir-1", modified: () => ["docs/superpowers/specs/a.md"] })));
  it("reads an explicit pathspec after --", () => {
    deny("git commit --only -m x -- docs/superpowers/specs/a.md", ctx({ branch: () => "ir-1" }));
    passes(
      "git commit --only -m x -- src/x.ts",
      ctx({ branch: () => "ir-1", staged: () => ["docs/superpowers/specs/a.md"] }),
    );
  });
  it("stops the pathspec at the next command in the chain", () =>
    passes("git commit --only -m x -- src/x.ts && echo done", ctx({ branch: () => "ir-1" })));
  it("finds the pathspec after a multi-line quoted message", () =>
    deny(
      'git commit -q -m "docs(specs): x (#1)\n\nClaude-Session: https://x" -- docs/superpowers/specs/a.md && echo done',
      ctx({ branch: () => "ir-1" }),
    ));
  it("counts a spec staged by a `git add` earlier in the same command", () =>
    deny("git add docs/superpowers/specs/a.md && git commit -m x", ctx({ branch: () => "ir-1" })));

  // #1193 review (CodeRabbit): a broad add named nothing, so a new spec it
  // staged reached neither the branch rule nor the section check.
  describe("a broad `git add` stages what it selects", () => {
    const NEW = "docs/superpowers/specs/new.md";
    const broad = (o = {}) => ctx({ untracked: () => [NEW, "src/x.ts"], specText: () => "# T", ...o });
    it.each([
      "git add -A && git commit -m x",
      "git add --all && git commit -m x",
      "git add . && git commit -m x",
      "git add docs/superpowers/specs/ && git commit -m x",
      "git add docs/superpowers && git commit -m x",
    ])("%s checks the untracked spec", (c) => expect(deny(c, broad())).toMatch(/new\.md is missing/));
    it("and the branch rule sees it too", () =>
      expect(deny("git add -A && git commit -m x", broad({ branch: () => "ir-1" }))).toMatch(
        /never on a feature branch/,
      ));
    it("leaves untracked files out of `-u`", () => passes("git add -u && git commit -m x", broad()));
    it("selects only under a directory operand", () => passes("git add src && git commit -m x", broad()));
    it("expands to modified files as well as untracked ones", () =>
      expect(deny("git add -u && git commit -m x", broad({ untracked: () => [], modified: () => [NEW] }))).toMatch(
        /new\.md is missing/,
      ));
  });
  it("judges the tree a chained `cd` lands in", () =>
    expect(
      deny(
        "cd ../ir-1 && git commit -m x -- docs/superpowers/specs/a.md",
        ctx({ branch: (d) => (d.endsWith("ir-1") ? "ir-1" : "master") }),
      ),
    ).toMatch(/on ir-1/));
  it("honours -C for the branch", () =>
    deny(
      "git -C ../ir-1 commit -m x",
      ctx({ branch: (d) => (d.endsWith("ir-1") ? "ir-1" : "master"), staged: () => ["docs/superpowers/specs/a.md"] }),
    ));
  it("denies a package.json commit that leaves a dirty lockfile behind", () =>
    expect(
      deny(
        "git commit -m x",
        ctx({ staged: () => ["packages/deck-core/package.json"], modified: () => ["pnpm-lock.yaml"] }),
      ),
    ).toMatch(/pnpm-lock/));
  it("allows it once the lockfile is staged", () =>
    passes("git commit -m x", ctx({ staged: () => ["package.json", "pnpm-lock.yaml"], modified: () => [] })));
});

describe("git worktree add", () => {
  it("denies a path inside the repo", () => expect(deny("git worktree add .worktrees/ir-1")).toMatch(/siblings/));
  it("denies a name that is not ir-<issue>", () =>
    expect(deny("git worktree add ../feature-x -b feature-x")).toMatch(/ir-<issue>/));
  it("denies a stale origin/master", () =>
    expect(
      deny("git worktree add ../ir-1 -b ir-1", ctx({ originFresh: () => ({ fresh: false, local: "a", remote: "b" }) })),
    ).toMatch(/stale/));
  it("passes a fresh sibling", () => passes("git worktree add -b ir-1 ../ir-1 origin/master"));
  it("is not fooled by a -C on a LATER command in the chain naming the new tree", () => {
    // The tree does not exist yet, so a context asked for the repo root THERE can only fall back.
    const c = ctx({ mainRoot: (dir) => (dir === MASTER ? MASTER : dir) });
    passes("git worktree add ../ir-1 -b ir-1 && git -C ../ir-1 log -1 --oneline", c);
    passes("git fetch origin && git worktree add ../ir-1 -b ir-1 origin/master && git -C ../ir-1 status", c);
  });
  it("passes when offline (freshness unknown)", () =>
    passes("git worktree add ../ir-1", ctx({ originFresh: () => undefined })));

  // #1193: 47 of 56 enhancement issues since the #621 policy had a spec, and
  // nothing checked the other nine. The worktree is the last moment before
  // implementation where the issue number is known.
  describe("the spec gate", () => {
    const noSpec = (o = {}) => ctx({ specFiles: () => [], ...o });
    it("asks when the issue has no spec", () =>
      expect(asks("git worktree add ../ir-42 -b ir-42", noSpec())).toMatch(/No spec on master for #42/));
    it("passes when a spec is named for the issue, whatever its date and topic", () =>
      passes("git worktree add ../ir-42 -b ir-42", ctx({ specFiles: () => ["2026-09-21-issue-42-anything.md"] })));
    it("is not satisfied by a spec for a DIFFERENT issue whose number contains this one", () =>
      expect(
        asks("git worktree add ../ir-42 -b ir-42", noSpec({ specFiles: () => ["2026-09-21-issue-421-x.md"] })),
      ).toMatch(/#42\b/));
    it("stays silent for an issue whose labels carry no enhancement", () =>
      passes("git worktree add ../ir-42 -b ir-42", noSpec({ issueLabels: () => ({ labels: [{ name: "bug" }] }) })));
    it("asks for an enhancement even when it also carries a kind: label", () =>
      asks(
        "git worktree add ../ir-42 -b ir-42",
        noSpec({ issueLabels: () => ({ labels: [{ name: "enhancement" }, { name: "kind: hygiene" }] }) }),
      ));
    it("asks when the labels cannot be read at all, and names the exemption", () =>
      expect(asks("git worktree add ../ir-42 -b ir-42", noSpec({ issueLabels: () => undefined }))).toMatch(
        /bug, docs fix, dependency bump or hygiene sweep is exempt/,
      ));
    it("never overrides a deny: placement and freshness still win", () => {
      expect(deny("git worktree add ../feature-x", noSpec())).toMatch(/ir-<issue>/);
      expect(
        deny("git worktree add ../ir-42", noSpec({ originFresh: () => ({ fresh: false, local: "a", remote: "b" }) })),
      ).toMatch(/stale/);
    });
  });
});

describe("git worktree remove", () => {
  it("denies while a deck host is linked into the tree", () =>
    expect(
      deny(
        "git worktree remove ../ir-1",
        ctx({ linkTargets: () => [{ host: "Stream Deck", target: tree("ir-1", "packages", "x", "plugin") }] }),
      ),
    ).toMatch(/Stream Deck plugin link/));
  it("passes when the links point elsewhere", () =>
    passes(
      "git -c core.longpaths=true worktree remove --force ../ir-1",
      ctx({ linkTargets: () => [{ host: "Stream Deck", target: tree("master", "p") }] }),
    ));
});

describe("gh issue and the board", () => {
  it("denies milestone/assignee at filing", () => {
    deny("gh issue create --title x --milestone 3.3");
    deny("gh issue create --title x -a niklam");
    passes("gh issue create --title x --label bug");
  });
  it("denies rewriting the Status options", () =>
    deny("gh api graphql -f query='mutation{updateProjectV2Field(...)}'"));
});

describe("command-shape traps", () => {
  it("pnpm build --force", () => expect(deny("pnpm build --force")).toMatch(/build:force/));
  it("piped pnpm without pipefail", () => {
    deny("pnpm build 2>&1 | tail -5");
    deny("pnpm test | tee log");
    passes("pnpm build; echo done | cat");
  });
  it("vitest outside the root script", () => {
    deny("pnpm exec vitest run x.test.ts");
    deny("npx vitest");
    deny("pnpm --filter @iracedeck/logger test");
    passes("pnpm test packages/x/y.test.ts");
  });
  it("pnpm --filter with a missing script or package", () => {
    expect(deny("pnpm --filter @iracedeck/logger lint")).toMatch(/no "lint" script/);
    expect(deny("pnpm --filter @iracedeck/nope build")).toMatch(/No workspace package/);
    passes("pnpm --filter @iracedeck/logger build");
    passes("pnpm --filter @iracedeck/logger add zod");
  });
  it("gh run list --commit with a short sha", () => {
    deny("gh run list --commit 37de46c02");
    passes("gh run list --commit 37de46c0260a574bfc71c166df09204c42392064");
  });
  it("jq", () => {
    deny("gh pr view 1 --json x | jq -r .x");
    passes("echo jquery");
    passes("echo 'a jq pipeline fails silently'");
    deny("jq . x.json");
  });
  it("heredoc with a doubled-backslash Windows path", () => {
    deny('cat > x.json <<\'EOF\'\n{"p":"C:\\\\Users\\\\x"}\nEOF');
    passes("cat > x.txt <<'EOF'\nhello\nEOF");
  });
  it("IRACEDECK_MOCK=0", () => deny("IRACEDECK_MOCK=0 pnpm test"));
  it("git show with a slashed ref and a dot path", () => {
    deny("git show origin/master:.claude/CLAUDE.md");
    passes("MSYS_NO_PATHCONV=1 git show origin/master:.claude/CLAUDE.md");
    passes("git show HEAD:.claude/CLAUDE.md");
  });
  it("two-dot diff against master", () => {
    deny("git diff origin/master..HEAD --stat");
    passes("git diff origin/master...HEAD --stat");
  });
});
