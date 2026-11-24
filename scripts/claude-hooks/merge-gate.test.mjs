import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyCheck, DEPENDABOT_COMMIT_AUTHOR, GITHUB_COMMITTER } from "./merge-gate.mjs";
import { checkBash } from "./rules-bash.mjs";
import { POWERSHELL } from "./shell-lexer.mjs";

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
    // the spec-gate cases override with `specFiles: () => []`. `committedText`
    // returning undefined is the fail-open contract the commit rule rests on
    // — a spec whose bytes the hook cannot read must still commit.
    specFiles: () => ["2026-01-01-issue-1-topic.md", "2026-01-01-issue-5-topic.md", "2026-01-01-issue-6-topic.md"],
    committedText: () => undefined,
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
    prComments: () => undefined,
    prChangedFiles: () => undefined,
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

describe("gh pr merge", () => {
  const head = "1111111111111111111111111111111111111111";
  const green = () => ({
    number: 7,
    url: "https://github.com/iracedeck/iracedeck/pull/7",
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
  // #1393 (with #1534): the gate judges a iracedeck/iracedeck PR only, and the PR it
  // reads is the one gh will merge — never this repository's PR of the same number.
  describe("the repository the merge is in", () => {
    /** A green home PR, recording every read as `[ref, dir, repo]`. */
    const arrange = (pr = green, extra = {}) => {
      const reads = [];
      const c = ctx({
        prView: (...args) => {
          reads.push(args);
          return pr();
        },
        ...extra,
      });
      return { c, reads };
    };

    it("passes a merge that names this repository, in every spelling gh takes", () => {
      for (const command of [
        "gh pr merge 7 --squash -R iracedeck/iracedeck",
        "gh pr merge 7 --squash --repo iracedeck/iracedeck",
        "gh pr merge 7 --squash --repo=iracedeck/iracedeck",
        "gh pr merge 7 --squash -Riracedeck/iracedeck",
        "gh pr merge 7 --squash -R github.com/iracedeck/iracedeck",
        "gh pr merge 7 --squash -R https://github.com/iracedeck/iracedeck.git",
        "gh pr merge 7 --squash -R 'iracedeck/iracedeck'",
        "gh pr merge 7 -dsR iracedeck/iracedeck",
        "GH_REPO=iracedeck/iracedeck gh pr merge 7 --squash",
        "env GH_REPO=iracedeck/iracedeck gh pr merge 7 --squash",
        "timeout 120 gh pr merge 7 --squash",
        "gh pr merge 7 --squash 2>&1",
        "gh pr merge 7 --squash && git pull || echo failed",
        "cd ../ir-7 && gh pr merge 7 --squash -R iracedeck/iracedeck",
        "cd ../ir-7; GH_REPO=iracedeck/iracedeck gh pr merge 7 --squash",
        "gh pr merge https://github.com/iracedeck/iracedeck/pull/7 --squash",
      ]) {
        const { c } = arrange();
        expect(checkBash(command, c), command).toBeNull();
      }
    });

    it("hands the named repository to the read as GH_REPO, and a URL reads as itself", () => {
      const named = arrange();
      passes("GH_REPO=iracedeck/iracedeck gh pr merge --squash", named.c);
      expect(named.reads).toEqual([[undefined, MASTER, "iracedeck/iracedeck"]]);
      const url = arrange();
      passes("gh pr merge https://github.com/iracedeck/iracedeck/pull/7 --squash -R iracedeck/iracedeck", url.c);
      expect(url.reads).toEqual([["https://github.com/iracedeck/iracedeck/pull/7", MASTER, undefined]]);
      const bare = arrange();
      passes("gh pr merge 7 --squash", bare.c);
      expect(bare.reads).toEqual([["7", MASTER, undefined]]);
    });

    it("refuses a merge that names another repository, before reading any PR", () => {
      for (const command of [
        "gh pr merge 7 --squash -R someone/other",
        "gh pr merge -R someone/other 7 --squash",
        "gh pr merge 7 --squash --repo someone/other",
        "gh pr merge 7 --squash --repo=someone/other",
        "gh pr merge 7 --squash -Rsomeone/other",
        "gh pr merge 7 --squash -R ghe.example.com/iracedeck/iracedeck",
        "gh pr merge 7 --squash -R iracedeck/iracedeck -R someone/other",
        // pflag's combined short flags: -d (delete-branch), then -R and its value.
        "gh pr merge 7 --squash -dR someone/other",
        "gh pr merge 7 --squash -dRsomeone/other",
        "gh pr merge 7 --squash -dR=someone/other",
        "GH_REPO=someone/other gh pr merge 7 --squash",
        "env GH_REPO=someone/other gh pr merge 7 --squash",
        // An empty --repo is no repository to gh, which then reads GH_REPO.
        "GH_REPO=someone/other gh pr merge 7 --squash -R ''",
        "gh pr merge https://github.com/someone/other/pull/7 --squash",
        // A URL wins over --repo, as it does in gh.
        "gh pr merge https://github.com/someone/other/pull/7 --squash -R iracedeck/iracedeck",
      ]) {
        const { c, reads } = arrange();
        expect(deny(command, c), command).toMatch(/targets someone\/other|targets ghe\.example\.com/);
        expect(reads, command).toEqual([]);
      }
    });

    it("refuses a repository it cannot read, before reading any PR", () => {
      for (const command of [
        `gh pr merge 7 --squash -R "$REPO"`,
        "gh pr merge 7 --squash --repo=$REPO",
        "gh pr merge 7 --squash -R",
        "GH_REPO=$REPO gh pr merge 7 --squash",
      ]) {
        const { c, reads } = arrange();
        expect(deny(command, c), command).toMatch(/Could not read the repository/);
        expect(reads, command).toEqual([]);
      }
    });

    // The gate reads before the command runs, so a command ahead of the merge
    // could change what gh resolves it to after the read (#1393 review).
    it("refuses anything but a plain cd ahead of the merge, before reading any PR", () => {
      for (const command of [
        "export GH_REPO=someone/other; gh pr merge 7 --squash",
        "export GH_REPO=iracedeck/iracedeck && gh pr merge 7 --squash",
        // An exported variable stays exported when assigned again.
        "export GH_REPO=iracedeck/iracedeck; GH_REPO=someone/other; gh pr merge 7 --squash",
        "export A=1 GH_REPO=someone/other; gh pr merge 7 --squash",
        "declare -gx GH_REPO=someone/other; gh pr merge 7 --squash",
        "export -- GH_REPO=someone/other; gh pr merge 7 --squash",
        "set -a; GH_REPO=someone/other; gh pr merge 7 --squash",
        "GH_REPO=someone/other; export GH_REPO; gh pr merge 7 --squash",
        "GH_REPO=someone/other gh pr view 7 && gh pr merge 7 --squash",
        "git switch other-branch && gh pr merge --squash",
        "gh repo set-default someone/other && gh pr merge 7 --squash",
        "pushd ../other && gh pr merge 7 --squash",
        "(cd ../other && gh pr merge 7 --squash)",
        "{ cd ../other; gh pr merge 7 --squash; }",
        "cd ../other 2>/dev/null && gh pr merge 7 --squash",
        "if cd ../other; then gh pr merge 7 --squash; fi",
        "cd - && gh pr merge 7 --squash",
        "cd ../other & gh pr merge 7 --squash",
        "# merge it\ncd ../ir-7 & cd ../other && gh pr merge 7 --squash",
        // A pipeline runs each command in its own subshell: the cd never reaches gh.
        "cd ../ir-99 | gh pr merge --squash",
        // Run beside the merge, a command can switch the branch or remote gh reads.
        "gh pr merge --squash & git -C ../ir-99 log -1",
        "gh pr merge --squash & git checkout feature-x",
        "gh pr merge 5 --squash | git remote set-url origin https://github.com/someone/other",
        "gh pr merge 5 --squash |& tail -3",
      ]) {
        const { c, reads } = arrange();
        expect(deny(command, c), command).toMatch(/as its own command/);
        expect(reads, command).toEqual([]);
      }
    });

    it("refuses a PowerShell environment write or directory change ahead of the merge", () => {
      for (const command of [
        "$env:GH_REPO = 'someone/other'; gh pr merge 7 --squash",
        "$env:GH_REPO = 'iracedeck/iracedeck'; gh pr merge 7 --squash",
        "${env:GH_REPO} = 'someone/other'; gh pr merge 7 --squash",
        "Set-Item Env:GH_REPO someone/other; gh pr merge 7 --squash",
        "[Environment]::SetEnvironmentVariable('GH_REPO', 'someone/other'); gh pr merge 7 --squash",
        "Push-Location ../other; gh pr merge 7 --squash",
      ]) {
        const { c, reads } = arrange(green, { shell: POWERSHELL });
        expect(deny(command, c), command).toMatch(/as its own command/);
        expect(reads, command).toEqual([]);
      }
      passes("Set-Location ../ir-7; gh pr merge 7 --squash", arrange(green, { shell: POWERSHELL }).c);
    });

    it("refuses a host, a working directory, a git variable or a wrapper's option in the merge's own prefix", () => {
      for (const command of [
        "GH_HOST=ghe.example.com gh pr merge 7 --squash -R iracedeck/iracedeck",
        "GH_REPO=iracedeck/iracedeck GH_HOST=ghe.example.com gh pr merge 7 --squash",
        "env -C ../other gh pr merge 7 --squash",
        "env -C../other gh pr merge 7 --squash",
        "env --chdir=../other gh pr merge 7 --squash",
        "env --c=../other gh pr merge 7 --squash",
        "GIT_DIR=../other/.git gh pr merge 7 --squash",
        "git_work_tree=../other gh pr merge 7 --squash",
        // Dropping an inherited GH_REPO the gate's own read still sees.
        "env -i PATH=/bin gh pr merge 7 --squash",
        "env -uGH_REPO gh pr merge 7 --squash",
        "xargs -afile gh pr merge --squash",
        // Windows hands gh its environment case-blind.
        "gh_repo=someone/other gh pr merge 7 --squash",
      ]) {
        const { c, reads } = arrange();
        expect(deny(command, c), command).toMatch(/prefix the gate cannot read whole/);
        expect(reads, command).toEqual([]);
      }
    });

    it("refuses a flag between `gh` and `merge`, which hid the merge from the gate", () => {
      for (const command of [
        "gh pr -R someone/other merge 7 --squash",
        "gh pr --repo iracedeck/iracedeck merge 7 --squash",
        "gh pr --repo=someone/other merge 7",
        "gh -R iracedeck/iracedeck pr merge 5 --squash",
        "gh --repo someone/other pr merge 5 --squash",
      ])
        expect(deny(command, arrange().c), command).toMatch(/every flag after `merge`/);
      passes("gh pr -R iracedeck/iracedeck view 7 --json url");
    });

    it("reads the PR where the merge runs, so a chained cd moves the read", () => {
      const { c, reads } = arrange();
      passes("cd ../ir-7 && gh pr merge --squash", c);
      expect(reads).toEqual([[undefined, tree("ir-7"), undefined]]);
    });

    it("refuses a PR gh read in another repository — an inherited GH_REPO or another checkout", () => {
      const foreign = () => ({ ...green(), url: "https://github.com/someone/other/pull/7" });
      expect(deny("gh pr merge 7 --squash", arrange(foreign).c)).toMatch(
        /someone\/other\/pull\/7 is in someone\/other, not iracedeck\/iracedeck/,
      );
      expect(deny("cd ../other && gh pr merge --squash", arrange(foreign).c)).toMatch(/is in someone\/other/);
      const unknown = () => ({ ...green(), url: undefined });
      expect(deny("gh pr merge 7 --squash", arrange(unknown).c)).toMatch(/an unknown repository/);
    });
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
      // The timeline is asked of the repository the PR's URL proved (#1393 review).
      expect(calls.timeline).toEqual([[7, "2026-10-03T10:00:00Z", MASTER, "iracedeck/iracedeck"]]);
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
      // In another command ahead of the merge it is refused by the chain rule (#1393).
      expect(deny(`echo --match-head-commit ${head}; gh pr merge 7 --squash`, arrange(clean).c)).toMatch(
        /as its own command/,
      );
      for (const command of [
        `gh pr merge 7 --squash; echo --match-head-commit ${head}`,
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

    it("--admin skips the rebase check with the other review checks, and asks (#1648)", () => {
      const { c, calls } = arrange({ ...clean, differing: ["a.ts"] });
      expect(asks("gh pr merge 7 --squash --admin", c)).toMatch(/runs only on Niklas's word/);
      expect(calls.replay).toHaveLength(0);
    });
  });

  // #1386: CodeRabbit's summary comment counts as the head's review, and as
  // the replay's start when it names a newer commit than the review object.
  describe("CodeRabbit's summary comment", () => {
    const fixture = (n) =>
      readFileSync(new URL(`./__fixtures__/coderabbit-summary/pr-${n}.md`, import.meta.url), "utf8");
    const BOT = { login: "coderabbitai", __typename: "Bot" };
    /** The real edit history of a fixture's summary (see coderabbit-summary.test.mjs), newest first. */
    const history = (n) =>
      JSON.parse(
        readFileSync(new URL(`./__fixtures__/coderabbit-summary/pr-${n}.edits.json`, import.meta.url), "utf8"),
      );
    /** The comments connection around one bot summary, its history one version unless given. */
    const comments = (body, at = "2026-10-03T12:00:00Z", edits) => ({
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: BOT,
          editor: BOT,
          isMinimized: false,
          createdAt: at,
          lastEditedAt: at,
          body,
          userContentEdits: edits ?? {
            totalCount: 1,
            nodes: [{ editedAt: at ?? "2026-10-03T12:00:00Z", editor: BOT, deletedAt: null, diff: body }],
          },
        },
      ],
    });
    /** PR #1290's real summary with its real eight-version history, `mutate` applied to the history first. */
    const real1290 = (mutate = () => {}) => {
      const h = history(1290);
      mutate(h);
      return comments(fixture(1290), "2026-09-30T19:27:50Z", h);
    };
    // PR #1290 as it stood at merge: one approval at 9fe7aa1a5, then a clean
    // incremental review of 0fba52955 that left only the summary behind.
    const head1290 = "0fba52955ee91824f9586cfaf0e42fa04d06e3d4";
    const approved1290 = "9fe7aa1a5a19a02cd160cef12c329ecf64e8e5bb";
    const base = "4444444444444444444444444444444444444444";
    const pr1290 = () => ({
      ...green(),
      number: 1290,
      headRefOid: head1290,
      baseRefOid: base,
      reviews: [
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          commit: { oid: approved1290 },
          submittedAt: "2026-09-30T18:38:58Z",
        },
      ],
    });
    const pinned1290 = `gh pr merge 1290 --squash --match-head-commit ${head1290}`;
    const clean = { ok: true, differing: [], conflicted: [], lineMismatch: [] };
    /** A context recording every comments read, timeline read and replay. */
    const arrange = (opts = {}) => {
      const { pr = pr1290, read = () => real1290(), replay = clean } = opts;
      // Read by `in`, not a destructuring default: the gh-failure case passes `undefined` on purpose.
      const moved = "moved" in opts ? opts.moved : false;
      const calls = { comments: [], timeline: [], replay: [] };
      const c = ctx({
        prView: pr,
        prComments: (...args) => (calls.comments.push(args), read()),
        baseChangedSince: (...args) => (calls.timeline.push(args), moved),
        // A function answers per replay; anything else answers every replay.
        replayRebase: (args) => (calls.replay.push(args), typeof replay === "function" ? replay(args) : replay),
      });
      return { c, calls };
    };
    const followUp1290 = "4d33e1f32178e69684739f5d31e037b72bff4987";

    it("accepts PR #1290's real summary at its head through its history, with one timeline read and no replay", () => {
      // Its recent review is 4d33e1f32..0fba52955; an earlier version of the same
      // comment reviewed 9fe7aa1a5..4d33e1f32, and 9fe7aa1a5 is the approval.
      const { c, calls } = arrange({ replay: { ...clean, differing: ["a.ts"] } });
      passes(pinned1290, c);
      expect(calls.comments).toEqual([[1290, MASTER, "iracedeck/iracedeck"]]);
      expect(calls.timeline).toEqual([[1290, "2026-09-30T18:38:58Z", MASTER, "iracedeck/iracedeck"]]);
      expect(calls.replay).toHaveLength(0);
    });

    it("refuses PR #1290's summary at its head once the base moved after the review, or gh cannot tell", () => {
      const moved = arrange({ moved: true });
      expect(deny(pinned1290, moved.c)).toMatch(
        /previous head 9fe7aa1a5, and the PR's base branch was retargeted or force-pushed after that review/,
      );
      expect(moved.calls.replay).toHaveLength(0);
      expect(deny(pinned1290, arrange({ moved: undefined }).c)).toMatch(
        /could not read whether the base branch moved since that review/,
      );
    });

    it("refuses an edit history with a foreign editor, falling back to the replay from the review object", () => {
      const { c, calls } = arrange({
        read: () => real1290((h) => (h.nodes[2].editor = { login: "niklam", __typename: "User" })),
        replay: { ...clean, followUp: 2 },
      });
      const why = deny(pinned1290, c);
      expect(why).toMatch(/does not count, because its edit history has an edit by User niklam/);
      expect(why).toMatch(/follow-up push/);
      expect(calls.replay.map((r) => r.reviewed)).toEqual([approved1290]);
    });

    it("refuses a truncated edit history", () =>
      expect(
        deny(
          pinned1290,
          arrange({ read: () => real1290((h) => (h.totalCount = 101)), replay: { ...clean, followUp: 2 } }).c,
        ),
      ).toMatch(/101 recorded edits and 8 were read/));

    describe("the recent review's start must lead back to the review object", () => {
      // #1290's history without the two versions that reviewed 9fe7aa1a5..4d33e1f32.
      const gapped = () =>
        real1290((h) => {
          h.nodes.splice(1, 2);
          h.totalCount = h.nodes.length;
        });

      it("refuses #1290 at its head when no earlier version reviewed up to 4d33e1f32, and it is no rebase either", () => {
        const { c, calls } = arrange({ read: gapped, replay: { ...clean, followUp: 2 } });
        const why = deny(pinned1290, c);
        expect(why).toMatch(
          /its recent review of 0fba52955 starts at 4d33e1f32, which the gate cannot trace back to the reviewed 9fe7aa1a5/,
        );
        // The start was tried as a rebase of the approval, then the head as before.
        expect(calls.replay).toEqual([
          { reviewed: approved1290, head: followUp1290, base, dir: MASTER },
          { reviewed: approved1290, head: head1290, base, dir: MASTER },
        ]);
      });

      it("accepts #1290 at its head when 4d33e1f32 is a clean pure rebase of the approval", () => {
        const { c, calls } = arrange({
          read: gapped,
          replay: (args) => (args.head === followUp1290 ? clean : { ...clean, followUp: 2 }),
        });
        passes(pinned1290, c);
        expect(calls.replay.map((r) => r.head)).toEqual([followUp1290]);
      });

      it("refuses when that rebase conflicted — a resolution nobody confirmed carries nothing here", () => {
        const conflicted = { ok: true, differing: ["a.ts"], conflicted: ["a.ts"], lineMismatch: [] };
        const { c } = arrange({
          read: gapped,
          replay: (args) => (args.head === followUp1290 ? conflicted : { ...clean, followUp: 2 }),
        });
        expect(deny(pinned1290, c)).toMatch(/cannot trace back to the reviewed 9fe7aa1a5[\s\S]*follow-up push/);
      });

      it("refuses when the replay of the start is not a pure rebase, or cannot run", () => {
        for (const r of [
          { ...clean, differing: ["b.ts"] },
          { ...clean, followUp: 1 },
          { ok: false, reason: "x" },
        ])
          expect(
            deny(
              pinned1290,
              arrange({ read: gapped, replay: (a) => (a.head === followUp1290 ? r : { ...clean, followUp: 2 }) }).c,
            ),
          ).toMatch(/cannot trace back/);
      });
    });

    it("requires the pin on this path, and reads nothing without it", () => {
      const { c, calls } = arrange();
      expect(deny("gh pr merge 1290 --squash", c)).toMatch(`pin it: add \`--match-head-commit ${head1290}\``);
      expect(deny(`gh pr merge 1290 --squash --match-head-commit ${head1290.slice(0, 9)}`, c)).toMatch(/pin it/);
      expect(calls.comments).toHaveLength(0);
    });

    it("reads no comments while a cheap check refuses", () => {
      const pr = () => {
        const p = pr1290();
        p.statusCheckRollup[0] = { __typename: "CheckRun", name: "Tests", status: "IN_PROGRESS" };
        return p;
      };
      const { c, calls } = arrange({ pr });
      expect(deny(pinned1290, c)).toMatch(/summary and pure-rebase checks run once the rest is green/);
      expect(calls.comments).toHaveLength(0);
    });

    it("denies CHANGES_REQUESTED even beside a valid summary, without reading it", () => {
      const { c, calls } = arrange({ pr: () => ({ ...pr1290(), reviewDecision: "CHANGES_REQUESTED" }) });
      expect(deny(pinned1290, c)).toMatch(/reviewDecision is CHANGES_REQUESTED/);
      expect(calls.comments).toHaveLength(0);
    });

    it("reads no comments when a review object sits at the head", () => {
      const pr = () => {
        const p = pr1290();
        p.reviews.push({
          author: { login: "coderabbitai" },
          state: "COMMENTED",
          body: "Actionable comments posted: 0",
          commit: { oid: head1290 },
        });
        return p;
      };
      const { c, calls } = arrange({ pr });
      passes("gh pr merge 1290 --squash", c);
      expect(calls.comments).toHaveLength(0);
    });

    it("--admin skips it with the other review checks, and asks (#1648)", () => {
      const { c, calls } = arrange({ read: () => undefined, replay: { ...clean, differing: ["a.ts"] } });
      expect(asks("gh pr merge 1290 --squash --admin", c)).toMatch(/runs only on Niklas's word/);
      expect(calls.comments).toHaveLength(0);
    });

    it("refuses a release back-merge before reading the summary", () => {
      const { c, calls } = arrange({ pr: () => ({ ...pr1290(), headRefName: "release/3.6" }) });
      expect(deny(`gh pr merge 1290 --merge --match-head-commit ${head1290}`, c)).toMatch(
        /back-merge lands its commits/,
      );
      expect(calls.comments).toHaveLength(0);
    });

    it("falls back to the replay from the review object when the summary cannot be read, naming why", () => {
      const { c, calls } = arrange({ read: () => undefined, replay: { ...clean, differing: ["a.ts"] } });
      const why = deny(pinned1290, c);
      expect(why).toMatch(/previous head 9fe7aa1a5; its summary comment does not count, because gh could not read/);
      expect(why).toMatch(/not a pure rebase of it/);
      expect(calls.replay[0].reviewed).toBe(approved1290);
    });

    it("names the rate limit when PR #1383's real summary is read at its unreviewed follow-up", () => {
      const head1383 = "0b0e4d758227192d3c87c2c72bf48d7a0eadd9a2";
      const reviewed1383 = "ab5e21c6f1e66291dcb96694fadc4ecb48236b3d";
      const pr = () => ({
        ...green(),
        number: 1383,
        headRefOid: head1383,
        baseRefOid: base,
        reviews: [
          {
            author: { login: "coderabbitai" },
            state: "APPROVED",
            commit: { oid: reviewed1383 },
            submittedAt: "2026-10-10T10:49:15Z",
          },
        ],
      });
      const { c, calls } = arrange({
        pr,
        read: () => comments(fixture(1383), "2026-10-10T10:55:21Z"),
        replay: { ...clean, followUp: 1 },
      });
      const why = deny(`gh pr merge 1383 --squash --match-head-commit ${head1383}`, c);
      expect(why).toMatch(/`rate limited` block/);
      expect(why).toMatch(/follow-up push/);
      expect(calls.replay[0].reviewed).toBe(reviewed1383);
    });

    describe("as the replay's start", () => {
      // The summary of a clean incremental review of S, then a rebase onto a moved base.
      const S = "6666666666666666666666666666666666666666";
      // Its range starts at the approval itself, so the start is traced without any history.
      const summaryOf = (commit) => fixture(1290).split(head1290).join(commit).split(followUp1290).join(approved1290);
      const rebasedPr = () => ({ ...pr1290(), headRefOid: head });
      const pinned = `gh pr merge 1290 --squash --match-head-commit ${head}`;

      it("starts from S when the summary was written after the newest review object", () => {
        const { c, calls } = arrange({ pr: rebasedPr, read: () => comments(summaryOf(S), "2026-09-30T19:27:50Z") });
        passes(pinned, c);
        expect(calls.replay).toEqual([{ reviewed: S, head, base, dir: MASTER }]);
        // The base-moved check keeps the review object's own, earlier time.
        expect(calls.timeline).toEqual([[1290, "2026-09-30T18:38:58Z", MASTER, "iracedeck/iracedeck"]]);
      });

      it("names S in a refusal, saying it came from the summary", () =>
        expect(
          deny(
            pinned,
            arrange({
              pr: rebasedPr,
              read: () => comments(summaryOf(S), "2026-09-30T19:27:50Z"),
              replay: { ...clean, differing: ["a.ts"] },
            }).c,
          ),
        ).toMatch(/previous head 666666666 \(read from its summary comment\), and the head is not a pure rebase/));

      it("keeps the review object as the start when the summary was written before it", () => {
        const { c, calls } = arrange({ pr: rebasedPr, read: () => comments(summaryOf(S), "2026-09-30T18:00:00Z") });
        passes(pinned, c);
        expect(calls.replay[0].reviewed).toBe(approved1290);
      });

      it("keeps the review object as the start when either time is missing or unreadable", () => {
        for (const at of [undefined, "not a date"]) {
          const read = () => {
            const r = comments(summaryOf(S));
            r.nodes[0].createdAt = at;
            r.nodes[0].lastEditedAt = at;
            return r;
          };
          const { c, calls } = arrange({ pr: rebasedPr, read });
          passes(pinned, c);
          expect(calls.replay[0].reviewed).toBe(approved1290);
        }
        const noTime = () => ({ ...rebasedPr(), reviews: [{ ...pr1290().reviews[0], submittedAt: undefined }] });
        const { c, calls } = arrange({ pr: noTime, read: () => comments(summaryOf(S), "2026-09-30T19:27:50Z") });
        passes(pinned, c);
        expect(calls.replay[0].reviewed).toBe(approved1290);
      });

      it("keeps the review object as the start when the newer summary fails a rule", () => {
        const broken = summaryOf(S).replace(`"kind":"reviewed"`, `"kind":"skipped"`);
        const { c, calls } = arrange({ pr: rebasedPr, read: () => comments(broken, "2026-09-30T19:27:50Z") });
        passes(pinned, c);
        expect(calls.replay[0].reviewed).toBe(approved1290);
      });

      it("keeps the review object as the start when the summary's range start cannot be traced to it", () => {
        // The real range start 4d33e1f32, with no history behind it and no clean rebase of the approval.
        const untraced = fixture(1290).split(head1290).join(S);
        const { c, calls } = arrange({
          pr: rebasedPr,
          read: () => comments(untraced, "2026-09-30T19:27:50Z"),
          replay: (a) => (a.head === followUp1290 ? { ...clean, followUp: 1 } : { ...clean, differing: ["a.ts"] }),
        });
        expect(deny(pinned, c)).toMatch(
          /previous head 9fe7aa1a5; its summary comment does not count, because its recent review of 666666666 starts at 4d33e1f32, which the gate cannot trace back/,
        );
        expect(calls.replay.map((r) => [r.reviewed, r.head])).toEqual([
          [approved1290, followUp1290],
          [approved1290, head],
        ]);
      });

      it("says the summary was written before the review only when both times are readable and it was", () => {
        const say = (read, pr = rebasedPr) =>
          deny(pinned, arrange({ pr, read, replay: { ...clean, differing: ["a.ts"] } }).c);
        expect(say(() => comments(summaryOf(S), "2026-09-30T18:00:00Z"))).toMatch(
          /recent review ends at 666666666 and was written before that review/,
        );
        const timed = (at) => () => {
          const r = comments(summaryOf(S));
          r.nodes[0].createdAt = at;
          r.nodes[0].lastEditedAt = at;
          return r;
        };
        const reviewAt = (t) => () => ({ ...rebasedPr(), reviews: [{ ...pr1290().reviews[0], submittedAt: t }] });
        const fresh = () => comments(summaryOf(S), "2026-09-30T19:27:50Z");
        for (const [why, read, pr] of [
          ["the comment carries no edit time", timed(undefined)],
          ["the comment's edit time is unreadable", timed("not a date")],
          ["both carry the same time", () => comments(summaryOf(S), "2026-09-30T18:38:58Z")],
          ["the review carries no time", fresh, reviewAt(undefined)],
          ["the review's time is unreadable", fresh, reviewAt("garbage")],
        ]) {
          const said = say(read, pr);
          expect(said).toContain(
            `recent review ends at 666666666, but the gate could not establish that the summary is newer than that review (${why})`,
          );
          expect(said).not.toMatch(/written before/);
        }
      });
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
  it("--admin skips the review checks but not the checks, and asks for a PR off the prose list (#1648)", () => {
    expect(
      asks(
        "gh pr merge 7 --squash --admin",
        ctx({ prView: () => ({ ...green(), reviewDecision: "REVIEW_REQUIRED", reviews: [] }) }),
      ),
    ).toMatch(/runs only on Niklas's word/);
    const pr = {
      ...green(),
      reviews: [],
      statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", status: "IN_PROGRESS" }],
    };
    deny("gh pr merge 7 --squash --admin", ctx({ prView: () => pr }));
  });

  // #1648: `--admin` skips the review checks, so every merge carrying it is
  // judged for whether it is one the bypass is for: Claude-facing prose, or a
  // PR Dependabot wrote whole, read with git at the pinned head. Such a PR may
  // pass the BLOCKED an unapproved PR reads; any other asks, or refuses while BLOCKED.
  describe("an --admin merge (#1648)", () => {
    const base = "4".repeat(40);
    const REQUIRED = ["ESLint check", "Prettier check", "Run tests", "Typecheck"];
    const run = (name, conclusion = "SUCCESS") => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
    const unapproved = (extra = {}) => ({
      ...green(),
      baseRefOid: base,
      baseRefName: "master",
      author: { is_bot: false, login: "niklam" },
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [...REQUIRED.map((n) => run(n)), run("CodeQL", "NEUTRAL")],
      reviews: [],
      ...extra,
    });
    const dependabot = (extra = {}) => unapproved({ author: { is_bot: true, login: "app/dependabot" }, ...extra });
    const PROSE = [
      ".claude/rules/hooks.md",
      ".claude/skills/issue-lead/SKILL.md",
      ".claude/agents/implementer.md",
      ".claude/CLAUDE.md",
      "scripts/CLAUDE.md",
      "packages/deck-core/CLAUDE.md",
    ];
    const NIKLAS = { author: "Niklas Lampén <niklas@lampen.fi>", committer: "Niklas Lampén <niklas@lampen.fi>" };
    const BOT = { author: DEPENDABOT_COMMIT_AUTHOR, committer: GITHUB_COMMITTER };
    const SKILL = "---\nname: x\nallowed-tools: Read\n---\n\nBody.\n";
    /** Both sides of every skill or agent file in `files`, its frontmatter untouched and its body edited. */
    const bodyEdits = (files) =>
      Object.fromEntries(
        files
          .filter((f) => /^\.claude\/(skills|agents)\//.test(f))
          .map((f) => [f, { base: SKILL, head: SKILL.replace("Body.", "Body, edited.") }]),
      );
    const prose = (files = PROSE, commits = [NIKLAS], blobs = bodyEdits(files)) => ({
      ok: true,
      files,
      commits,
      blobs,
    });
    /** A context whose file read and rules read answer as given, recording each call. */
    const arrange = (read = prose(), pr = unapproved(), required = { ok: true, contexts: [...REQUIRED] }) => {
      const calls = [];
      const ruleReads = [];
      const c = ctx({
        prView: () => pr,
        prChangedFiles: (args) => (calls.push(args), read),
        requiredChecks: (...args) => (ruleReads.push(args), required),
      });
      return { c, calls, ruleReads };
    };
    const pinned = `gh pr merge 7 --squash --admin --match-head-commit ${head}`;

    it("passes a prose-only PR pinned to its head, reading the files at that head and the base's rules", () => {
      const { c, calls, ruleReads } = arrange();
      passes(pinned, c);
      expect(calls).toEqual([{ head, base, dir: MASTER }]);
      expect(ruleReads).toEqual([["iracedeck/iracedeck", "master", MASTER]]);
    });

    it("passes it whatever the merge state, UNKNOWN and CLEAN included", () => {
      for (const mergeStateStatus of ["UNKNOWN", "CLEAN", "UNSTABLE", "HAS_HOOKS"])
        passes(pinned, arrange(undefined, unapproved({ mergeStateStatus })).c);
    });

    it("refuses each file off the list while BLOCKED, naming it", () => {
      for (const file of [
        "scripts/claude-hooks/rules-bash.mjs",
        "scripts/claude-hooks/rules-bash.test.mjs",
        ".claude/settings.json",
        "changelog.d/1648-x.md",
        "packages/website/src/content/docs/docs/index.md",
        "packages/website/src/content/docs/CLAUDE.md",
        "README.md",
      ]) {
        const said = deny(pinned, arrange(prose([...PROSE, file])).c);
        expect(said, file).toContain(`it changes ${file}, off the prose list`);
        expect(said, file).toMatch(/REVIEW_REQUIRED/);
        expect(said, file).toMatch(/take any `no-coderabbit` label off/);
      }
    });

    it("refuses a script renamed into the rules, by the deleted side git lists", () => {
      // `prChangedFiles` reads with --no-renames, so a move lists both paths.
      const said = deny(pinned, arrange(prose([".claude/rules/x.md", "scripts/x.mjs"])).c);
      expect(said).toContain("it changes scripts/x.mjs, off the prose list");
    });

    it("names at most five files off the list", () => {
      const files = Array.from({ length: 7 }, (_, i) => `scripts/f${i}.mjs`);
      expect(deny(pinned, arrange(prose(files)).c)).toContain("scripts/f4.mjs, and 2 more, off the prose list");
    });

    it("passes a PR Dependabot opened and wrote whole, on its own files", () => {
      const { c, calls } = arrange(prose(["package.json", "pnpm-lock.yaml"], [BOT]), dependabot());
      passes(pinned, c);
      expect(calls).toHaveLength(1);
      const two = arrange(prose(["pnpm-lock.yaml"], [BOT, BOT]), dependabot());
      passes(pinned, two.c);
    });

    it("judges a Dependabot PR carrying anyone else's commit on its files", () => {
      const mixed = [BOT, NIKLAS];
      const said = deny(pinned, arrange(prose(["pnpm-lock.yaml"], mixed), dependabot()).c);
      expect(said).toContain(
        "it changes pnpm-lock.yaml, off the prose list (Dependabot opened it, but not every commit",
      );
      // Off the list but not BLOCKED: the maintainer confirms.
      expect(
        asks(pinned, arrange(prose(["pnpm-lock.yaml"], mixed), dependabot({ mergeStateStatus: "CLEAN" })).c),
      ).toMatch(/not every commit on it is Dependabot's/);
      // On the list, it passes as prose.
      passes(pinned, arrange(prose([".claude/rules/a.md"], mixed), dependabot()).c);
      // An edit amended or rebased into Dependabot's own commit keeps its author, not GitHub's committer.
      const amended = [{ author: DEPENDABOT_COMMIT_AUTHOR, committer: NIKLAS.committer }];
      expect(deny(pinned, arrange(prose(["pnpm-lock.yaml"], amended), dependabot()).c)).toContain(
        "it changes pnpm-lock.yaml, off the prose list (Dependabot opened it, but not every commit",
      );
      expect(deny(pinned, arrange(prose(["pnpm-lock.yaml"], [BOT, ...amended]), dependabot()).c)).toContain(
        "off the prose list",
      );
      // No commit list at all is never Dependabot's.
      expect(deny(pinned, arrange({ ok: true, files: ["pnpm-lock.yaml"] }, dependabot()).c)).toContain(
        "it changes pnpm-lock.yaml, off the prose list",
      );
      expect(deny(pinned, arrange(prose(["pnpm-lock.yaml"], []), dependabot()).c)).toContain("off the prose list");
    });

    it("takes no other PR author for Dependabot, nor a look-alike commit author", () => {
      for (const author of [
        { is_bot: false, login: "app/dependabot" },
        { is_bot: true, login: "dependabot" },
        { is_bot: true, login: "app/dependabot-preview" },
        { login: "app/dependabot" },
        undefined,
      ]) {
        const c = arrange(prose(["package.json"], [BOT]), unapproved({ author })).c;
        expect(deny(pinned, c), JSON.stringify(author)).toContain("it changes package.json, off the prose list");
      }
      for (const commit of [
        { ...BOT, author: "dependabot[bot] <dependabot@example.com>" },
        { ...BOT, author: "dependabot <49699333+dependabot[bot]@users.noreply.github.com>" },
        { ...BOT, author: `${DEPENDABOT_COMMIT_AUTHOR} ` },
        { ...BOT, committer: "GitHub <noreply@example.com>" },
        { ...BOT, committer: "GitHub Actions <noreply@github.com>" },
        { author: DEPENDABOT_COMMIT_AUTHOR },
        {},
        null,
      ])
        expect(
          deny(pinned, arrange(prose(["package.json"], [commit]), dependabot()).c),
          JSON.stringify(commit),
        ).toContain("off the prose list");
    });

    it("refuses an unpinned merge, or one pinned to another sha or a prefix", () => {
      for (const command of [
        "gh pr merge 7 --squash --admin",
        `gh pr merge 7 --squash --admin --match-head-commit ${"2".repeat(40)}`,
        `gh pr merge 7 --squash --admin --match-head-commit ${head.slice(0, 9)}`,
      ])
        expect(deny(command, arrange().c), command).toContain(`add \`--match-head-commit ${head}\``);
      const bot = arrange(prose(["pnpm-lock.yaml"], [BOT]), dependabot()).c;
      expect(deny("gh pr merge 7 --squash --admin", bot)).toContain("--match-head-commit");
    });

    it("refuses a qualifying PR missing a check the base branch requires, or one not green", () => {
      const rollup = (...names) => names.map((n) => run(n));
      const without = unapproved({ statusCheckRollup: rollup("ESLint check", "Prettier check", "Typecheck") });
      expect(deny(pinned, arrange(undefined, without).c)).toContain(
        "master requires Run tests, not reported green at the head",
      );
      // A required check reported under another name is still missing.
      const renamed = unapproved({ statusCheckRollup: rollup("ESLint check", "Prettier check", "Typecheck", "Tests") });
      expect(deny(pinned, arrange(undefined, renamed).c)).toContain("requires Run tests");
      // A StatusContext counts by its context.
      const asContext = unapproved({
        statusCheckRollup: [
          ...rollup("ESLint check", "Prettier check", "Typecheck"),
          { __typename: "StatusContext", context: "Run tests", state: "SUCCESS" },
        ],
      });
      passes(pinned, arrange(undefined, asContext).c);
      // Nothing beyond the rollup's own checks is required: a check the rules require
      // that also shows up red refuses on the rollup first.
      const red = unapproved({
        statusCheckRollup: [...rollup("ESLint check", "Prettier check", "Typecheck"), run("Run tests", "FAILURE")],
      });
      expect(deny(pinned, arrange(undefined, red).c)).toMatch(/not green: Run tests/);
    });

    it("refuses a qualifying PR when the base branch's rules cannot be read", () => {
      for (const reason of ["gh could not read the rules of master", "master has more rules than one page holds"])
        expect(deny(pinned, arrange(undefined, undefined, { ok: false, reason }).c)).toContain(
          `the gate could not read the status checks master requires (${reason})`,
        );
      expect(deny(pinned, arrange(undefined, undefined, { ok: true }).c)).toContain("the gate could not read");
      // The default context's reader answers nothing.
      const c = ctx({ prView: () => unapproved(), prChangedFiles: () => prose() });
      expect(deny(pinned, c)).toContain("(the read did not run)");
    });

    it("passes a qualifying PR whose base requires no check unless it is BLOCKED", () => {
      const none = { ok: true, contexts: [] };
      const release = (extra) =>
        unapproved({ baseRefName: "release/3.9", statusCheckRollup: [run("Tests")], ...extra });
      for (const mergeStateStatus of ["CLEAN", "UNKNOWN", "UNSTABLE"])
        passes(pinned, arrange(undefined, release({ mergeStateStatus }), none).c);
      expect(deny(pinned, arrange(undefined, release({}), none).c)).toContain(
        "it is BLOCKED, yet the rules of release/3.9 require no status check",
      );
    });

    it("never passes a review that asked for changes, whatever the merge state", () => {
      const { c, calls } = arrange(undefined, unapproved({ reviewDecision: "CHANGES_REQUESTED" }));
      expect(deny(pinned, c)).toMatch(/mergeStateStatus is BLOCKED \(CHANGES_REQUESTED/);
      expect(calls).toEqual([]);
      const unknown = arrange(
        undefined,
        unapproved({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "UNKNOWN" }),
      );
      expect(deny(pinned, unknown.c)).toMatch(/asked for changes \(CHANGES_REQUESTED\)/);
      // Off the list too: refused, not asked, and before any read.
      const code = arrange(
        prose(["scripts/x.mjs"]),
        unapproved({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "UNKNOWN" }),
      );
      expect(deny(pinned, code.c)).toMatch(/asked for changes \(CHANGES_REQUESTED\), which `--admin` never passes/);
      expect(code.calls).toEqual([]);
      const approvedThenChanged = arrange(prose(["scripts/x.mjs"]), {
        ...green(),
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "CLEAN",
      });
      expect(deny("gh pr merge 7 --squash --admin", approvedThenChanged.c)).toMatch(/CHANGES_REQUESTED/);
    });

    describe("a skill's or agent's frontmatter is configuration", () => {
      const skill = ".claude/skills/issue-lead/SKILL.md";
      const agent = ".claude/agents/qa.md";

      it("qualifies a body-only edit", () => {
        passes(pinned, arrange(prose([skill, agent, ".claude/rules/r.md"])).c);
      });

      it("does not qualify a changed frontmatter, naming the file: refused while BLOCKED, otherwise asked", () => {
        for (const head of [
          SKILL.replace("allowed-tools: Read", "allowed-tools: Bash"),
          SKILL.replace("name: x\n", "name: x\nhooks: {}\n"),
          `---\npermissionMode: bypassPermissions\n---\n${SKILL}`,
        ]) {
          const read = prose([skill, ".claude/rules/r.md"], [NIKLAS], { [skill]: { base: SKILL, head } });
          const said = deny(pinned, arrange(read).c);
          expect(said).toContain(`the frontmatter of ${skill} changed`);
          expect(said).toMatch(/REVIEW_REQUIRED/);
          expect(asks(pinned, arrange(read, unapproved({ mergeStateStatus: "CLEAN" })).c)).toContain(
            `the frontmatter of ${skill} changed`,
          );
        }
      });

      it("does not qualify an added or deleted skill or agent file", () => {
        for (const pair of [
          { base: null, head: SKILL },
          { base: SKILL, head: null },
        ])
          expect(deny(pinned, arrange(prose([agent], [NIKLAS], { [agent]: pair })).c)).toContain(
            `the frontmatter of ${agent} changed, or the file is new or deleted`,
          );
      });

      it("does not qualify a skill or agent file whose sides the read did not return", () => {
        expect(deny(pinned, arrange(prose([skill], [NIKLAS], {})).c)).toContain(`the frontmatter of ${skill} changed`);
        expect(deny(pinned, arrange({ ok: true, files: [skill], commits: [NIKLAS] }).c)).toContain(
          `the frontmatter of ${skill} changed`,
        );
      });

      it("never checks a rule's or a CLAUDE.md's frontmatter", () => {
        passes(pinned, arrange(prose([".claude/rules/r.md", "scripts/CLAUDE.md"], [NIKLAS], {})).c);
      });

      it("names both reasons when a PR has files off the list and a changed frontmatter", () => {
        const read = prose(["scripts/x.mjs", skill], [NIKLAS], { [skill]: { base: SKILL, head: "---\n---\n" } });
        const said = deny(pinned, arrange(read).c);
        expect(said).toContain("it changes scripts/x.mjs, off the prose list; the frontmatter of");
      });
    });

    it("keeps every other check: DIRTY, a red or pending check, no checks, the method", () => {
      const cases = [
        [unapproved({ mergeStateStatus: "DIRTY" }), pinned, /mergeStateStatus is DIRTY/],
        [unapproved({ statusCheckRollup: [run("Tests", "FAILURE")] }), pinned, /not green: Tests/],
        [
          unapproved({ statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", status: "IN_PROGRESS" }] }),
          pinned,
          /pending: Tests/,
        ],
        [unapproved({ statusCheckRollup: [] }), pinned, /no checks reported/],
        [unapproved(), `gh pr merge 7 --admin --match-head-commit ${head}`, /squash/],
        [unapproved({ state: "CLOSED" }), pinned, /CLOSED, not OPEN/],
      ];
      for (const [pr, command, said] of cases) {
        const { c, calls } = arrange(undefined, pr);
        expect(deny(command, c)).toMatch(said);
        // Every cheap refusal comes before the git read.
        expect(calls).toEqual([]);
      }
      // A red check on an unapproved PR still names the BLOCKED it might otherwise pass.
      const red = unapproved({ statusCheckRollup: [run("Tests", "FAILURE")] });
      expect(deny(pinned, arrange(undefined, red).c)).toMatch(/BLOCKED \(REVIEW_REQUIRED; whether `--admin`/);
    });

    it("gives a release back-merge no bypass: BLOCKED refuses, otherwise it asks unread", () => {
      const { c, calls } = arrange(undefined, unapproved({ headRefName: "release/3.9" }));
      expect(deny(`gh pr merge 7 --merge --admin --match-head-commit ${head}`, c)).toMatch(
        /mergeStateStatus is BLOCKED/,
      );
      const clean = arrange(undefined, unapproved({ headRefName: "release/3.9", mergeStateStatus: "CLEAN" }));
      expect(asks("gh pr merge 7 --merge --admin", clean.c)).toMatch(/a release back-merge never is/);
      expect([...calls, ...clean.calls]).toEqual([]);
    });

    it("asks, naming the files, for a PR off the list that is not BLOCKED — UNKNOWN or approved at a stale head", () => {
      const code = prose(["packages/deck-core/src/x.ts", ".claude/rules/hooks.md"]);
      // Unapproved, while GitHub computes its mergeability.
      const unknown = arrange(code, unapproved({ mergeStateStatus: "UNKNOWN" }));
      const said = asks(pinned, unknown.c);
      expect(said).toContain("it changes packages/deck-core/src/x.ts, off the prose list");
      expect(said).toMatch(/skips CodeRabbit's review at the head/);
      expect(said).toMatch(/runs only on Niklas's word/);
      // Approved once, then pushed to: CodeRabbit never saw this head.
      const stale = {
        ...green(),
        baseRefOid: base,
        baseRefName: "master",
        reviews: [{ author: { login: "coderabbitai" }, state: "APPROVED", commit: { oid: "2".repeat(40) } }],
      };
      expect(asks("gh pr merge 7 --squash --admin", arrange(code, stale).c)).toContain(
        "packages/deck-core/src/x.ts, off the prose list",
      );
      // The ask never needs the rules read; the qualifying path does.
      expect(unknown.ruleReads).toEqual([]);
    });

    it("asks, never passes, when the file read fails on a PR that is not BLOCKED, and refuses while BLOCKED", () => {
      for (const reason of [
        "git could not fetch the PR's head and base from origin",
        "the history is criss-crossed (more than one merge-base)",
        "git could not list the files the PR changes",
        "git could not list the PR's commits",
        "git lists no file the PR changes",
      ]) {
        const said = `the gate could not read the files it changes: ${reason}`;
        expect(deny(pinned, arrange({ ok: false, reason }).c)).toContain(said);
        expect(asks(pinned, arrange({ ok: false, reason }, unapproved({ mergeStateStatus: "CLEAN" })).c)).toContain(
          said,
        );
      }
      // The default context's reader answers nothing, as a reader that never ran.
      expect(deny(pinned, ctx({ prView: () => unapproved() }))).toContain("the read did not run");
      expect(asks(pinned, ctx({ prView: () => unapproved({ mergeStateStatus: "CLEAN" }) }))).toContain(
        "the read did not run",
      );
    });

    it("leaves BLOCKED for any other reason a refusal, read or not", () => {
      // Without --admin, the unapproved PR refuses on the review checks.
      expect(deny(`gh pr merge 7 --squash --match-head-commit ${head}`, arrange().c)).toMatch(
        /reviewDecision is REVIEW_REQUIRED/,
      );
      for (const reviewDecision of ["APPROVED", "", undefined]) {
        const { c, calls } = arrange(undefined, unapproved({ reviewDecision }));
        expect(deny(pinned, c)).toMatch(/mergeStateStatus is BLOCKED\./);
        expect(calls).toEqual([]);
      }
    });

    it("lets a deny elsewhere in the chain beat the ask", () => {
      const c = arrange(prose(["scripts/x.mjs"]), unapproved({ mergeStateStatus: "CLEAN" })).c;
      expect(asks(pinned, c)).toMatch(/runs only on Niklas's word/);
      expect(deny(`${pinned} && jq . x.json`, c)).toMatch(/jq is not installed/);
    });
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
    // A keyword's condition is a command ahead of the merge, which the chain rule refuses (#1393).
    for (const command of ["if true; then gh pr merge 7 --squash; fi", "while x; do gh pr merge 7 --squash; done"])
      expect(deny(command, ctx({ prView: green }))).toMatch(/as its own command/);
    // A wrapper's option or a gh variable can move what gh merges, so the prefix check refuses it (#1393).
    for (const command of [
      "env GH_DEBUG=1 gh pr merge 7 --squash",
      "env -i gh pr merge 7 --squash",
      "env -u GH_TOKEN -i PATH=/bin gh pr merge 7 --squash",
      "exec -a merger gh pr merge 7 --squash",
      "time -p gh pr merge 7 --squash",
    ])
      expect(deny(command, ctx({ prView: green }))).toMatch(/prefix the gate cannot read whole/);
    for (const command of [
      "env DEBUG=1 PATH=/bin gh pr merge 7 --squash",
      "exec gh pr merge 7 --squash",
      "time gh pr merge 7 --squash",
      "timeout 120 gh pr merge 7 --squash",
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

  it("judges a long run of wrapper options in linear time — regex time is outside the spawn deadline", () => {
    // The short run first: an exponential regression takes seconds on 34 bare
    // `-u` tokens and fails here, where 4000 of them would hang the suite.
    for (const n of [34, 4000])
      for (const unit of ["-u ", "-u x ", "-u -i x -C "]) {
        const started = Date.now();
        passes(`env ${unit.repeat(n)}echo done`, ctx({ prView: green }));
        expect(Date.now() - started, `${n} × "${unit}"`).toBeLessThan(200);
      }
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
    // The merge leads: nothing but a `cd` may come ahead of one (#1393).
    const v = asks(`gh pr merge 7 --squash --match-head-commit ${head} && git push origin v3.6.0`, c);
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
