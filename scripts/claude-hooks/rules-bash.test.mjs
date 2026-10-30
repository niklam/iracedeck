import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEBUG_VALUE, ELGATO_MANIFEST } from "../lib/debug-plugin.mjs";
import { isInside } from "./lib.mjs";
import {
  checkBash,
  classifyCheck,
  cmd,
  firstMerge,
  GIT_COMMIT,
  GIT_WORKTREE_REMOVE,
  gitCwd,
  issueFromWorktreePath,
  maskInert,
  matchAt,
  POWERSHELL,
  resolveDir,
  trustedMask,
  words,
  worktreeAddTarget,
} from "./rules-bash.mjs";

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

// #1520: Git Bash spells a drive `/c/…` and hands native programs `C:/…`, while
// `path.resolve` reads `/c/…` as a folder `c` at the root of the current drive.
// That put `cd /c/…/master && pnpm build` in a `C:\c\…` no deck link points into.
describe("resolveDir: a Git Bash drive path names its drive", () => {
  const BASE = "C:\\repo\\master";
  const win = { platform: "win32" };
  it("maps /c/…, /C/…, a bare /d and /cygdrive/c/… on Windows", () => {
    expect(resolveDir(BASE, "/c/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/C/Users/x/", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/d", win)).toBe("D:\\");
    expect(resolveDir(BASE, "/cygdrive/c/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/cygdrive/d", win)).toBe("D:\\");
  });
  it("leaves every other spelling to path.resolve", () => {
    expect(resolveDir(BASE, "../ir-5", win)).toBe("C:\\repo\\ir-5");
    expect(resolveDir(BASE, "C:/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "D:\\x", win)).toBe("D:\\x");
    // Not a drive: a longer first segment, or a letter that does not end it.
    expect(resolveDir(BASE, "/cc/x", win)).toBe("C:\\cc\\x");
    expect(resolveDir(BASE, "/c-x/y", win)).toBe("C:\\c-x\\y");
    expect(resolveDir(BASE, "/cygdrive/cc", win)).toBe("C:\\cygdrive\\cc");
  });
  it("reads /c/… as PowerShell does there: a folder at the root of the drive", () =>
    expect(resolveDir(BASE, "/c/Users/x", { ...win, shell: POWERSHELL })).toBe("C:\\c\\Users\\x"));
  it("off Windows /c is a real directory", () => {
    expect(resolveDir("/repo/master", "/c/Users/x", { platform: "linux" })).toBe("/c/Users/x");
    expect(resolveDir("/repo/master", "../ir-5", { platform: "linux" })).toBe("/repo/ir-5");
  });
  // Positive control: the plain resolve every guard used to call lands elsewhere.
  it("is needed: path.win32.resolve misreads the same path", () =>
    expect(path.win32.resolve(BASE, "/c/Users/x")).toBe("C:\\c\\Users\\x"));
});

// The guards resolve with the real platform, so these run where Git Bash does.
// Off Windows the resolver's own tests above are the coverage.
describe.runIf(process.platform === "win32")("every guard reads a Git Bash drive path (#1520)", () => {
  /** `C:\repo\x` spelled as Git Bash spells it: `/c/repo/x`. */
  const gitBash = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
  const IR5 = tree("ir-5");
  const INTEGRATION = tree("ir-integration");
  const linkedMaster = ctx({
    cwd: IR5,
    linkTargets: () => [{ host: "Stream Deck", target: path.join(MASTER, "packages", "plugin") }],
    toplevel: (d) => [MASTER, IR5, INTEGRATION].find((r) => isInside(d, r)),
  });

  // Positive control: without the mapping these paths resolve away from the tree they name.
  it("would be misread by a plain resolve", () => {
    expect(gitBash(MASTER)).toMatch(/^\/[a-z]\/repo\/master$/);
    expect(path.resolve(IR5, gitBash(MASTER))).not.toBe(MASTER);
  });

  it("gitCwd follows a cd and a git -C spelled the Git Bash way", () => {
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd(`cd ${gitBash(IR5)} && git status`, MASTER, status)).toBe(IR5);
    expect(gitCwd(`git -C ${gitBash(IR5)} status`, MASTER, status)).toBe(IR5);
    expect(gitCwd(`cd /cygdrive/${gitBash(IR5).slice(1)} && git status`, MASTER, status)).toBe(IR5);
  });

  // `dev:voices` is the one command that asks only in a linked tree (#1526), so it
  // is the vehicle that shows which tree a path was resolved to.
  it("asks for dev:voices in the linked tree, through a cd or a pnpm -C", () => {
    asks(`cd ${gitBash(MASTER)} && pnpm dev:voices on`, linkedMaster);
    asks(`pnpm -C ${gitBash(MASTER)} dev:voices off`, linkedMaster);
    asks(`pnpm --dir=${gitBash(MASTER)} dev:voices on`, linkedMaster);
    asks(`cd /cygdrive/${gitBash(MASTER).slice(1)} && pnpm dev:voices on`, linkedMaster);
  });
  it("passes the same command in an unlinked tree, and a build in the linked one", () => {
    passes(`cd ${gitBash(IR5)} && pnpm dev:voices on`, linkedMaster);
    passes(`pnpm -C ${gitBash(IR5)} dev:voices off`, linkedMaster);
    passes(`cd ${gitBash(MASTER)} && pnpm build`, linkedMaster);
    passes(`pnpm -C ${gitBash(MASTER)} install`, linkedMaster);
  });

  it("denies an integration push from a git -C or cd to the tree, by its branch or its top level", () => {
    // `toplevel` answers only for real trees and the basename is `packages`/`ir-5`,
    // so the deny cannot come from the directory's own name.
    const byBranch = ctx({
      branch: (d) => (isInside(d, IR5) ? "integration" : "master"),
      toplevel: () => undefined,
    });
    expect(deny(`git -C ${gitBash(IR5)} push`, byBranch)).toMatch(/never pushed/);
    expect(deny(`cd ${gitBash(IR5)} && git push`, byBranch)).toMatch(/never pushed/);
    const byTop = ctx({ toplevel: (d) => (isInside(d, INTEGRATION) ? INTEGRATION : undefined) });
    expect(deny(`git -C ${gitBash(path.join(INTEGRATION, "packages"))} push`, byTop)).toMatch(/never pushed/);
    passes(`git -C ${gitBash(path.join(IR5, "packages"))} push`, byTop);
  });

  it("judges a worktree add or remove at a Git Bash path", () => {
    passes(`git worktree add ${gitBash(tree("ir-1"))} -b fix/1-x`);
    expect(deny(`git worktree add ${gitBash(path.join(MASTER, ".worktrees", "ir-1"))} -b x`)).toMatch(/siblings/);
    expect(
      deny(
        `git worktree remove ${gitBash(tree("ir-1"))}`,
        ctx({ linkTargets: () => [{ host: "Stream Deck", target: tree("ir-1", "plugin") }] }),
      ),
    ).toMatch(/Stream Deck plugin link/);
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

  // #1520: `integration` is a local branch reset to origin/master and merged
  // into for every combined build — never a branch anyone else should see.
  describe("the integration branch is never pushed", () => {
    const INTEGRATION = tree("ir-integration");
    const inTree = (o = {}) =>
      ctx({ branch: (d) => (d === INTEGRATION ? "integration" : "master"), toplevel: (d) => d, ...o });
    it.each([
      "git push origin integration",
      "git push -u origin integration",
      "git push origin integration:integration",
      "git push origin +integration",
      "git push origin refs/heads/integration",
      "git push origin HEAD:integration",
      "git push origin ir-5:integration",
      "git push --force origin integration 2>&1 | tail -2",
      "git -C ../ir-integration push origin integration",
      "git status && git push origin integration",
    ])("denies a refspec naming it: %s", (c) => expect(deny(c, inTree())).toMatch(/integration.*never pushed/));
    it.each(["git push", "git push origin", "git push -u origin HEAD", "git push origin @"])(
      "denies a bare or HEAD push from inside the tree: %s",
      (c) => expect(deny(c, inTree({ cwd: INTEGRATION }))).toMatch(/never pushed/),
    );
    it("follows a cd and a git -C into the tree", () => {
      expect(deny("cd ../ir-integration && git push", inTree())).toMatch(/never pushed/);
      expect(deny("git -C ../ir-integration push -u origin HEAD", inTree())).toMatch(/never pushed/);
      expect(deny("git -C ../ir-integration/packages push", inTree({ toplevel: () => INTEGRATION }))).toMatch(
        /never pushed/,
      );
    });
    it("knows the branch by name wherever it is checked out", () =>
      expect(deny("git push", ctx({ branch: () => "integration" }))).toMatch(/never pushed/));
    it("denies --all and --mirror, which carry every local branch, integration with them", () => {
      expect(deny("git push --all origin")).toMatch(/never pushed/);
      expect(deny("git push --mirror origin")).toMatch(/never pushed/);
    });
    it("lets every other push through, from either tree", () => {
      passes("git push origin master", inTree());
      passes("git push", inTree());
      passes("git push -u origin feature/1520-integration-tests", inTree());
      passes("git push origin ir-5:ir-5", inTree({ cwd: INTEGRATION }));
      passes("cd ../ir-integration && git fetch origin && cd ../master && git push", inTree());
      passes("git -C ../ir-integration fetch && git push", inTree());
      passes("git push --dry-run origin integration", inTree());
    });
    it("is not fooled by a mention", () => {
      passes(`echo "git push origin integration"`, inTree());
      passes(`git commit -q -m "never git push origin integration" -- x.md`, inTree());
    });
    // Second read: a glob pushes every branch it matches, `heads/` is a ref
    // name git resolves, and a revision suffix still names the branch's commit.
    it.each([
      "git push origin 'refs/heads/*'",
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push origin '+refs/heads/*:refs/remotes/mirror/*'",
      "git push origin 'refs/heads/int*'",
      "git push origin heads/integration",
      "git push origin refs/heads/integration:heads/integration",
      "git push origin integration~0",
      "git push origin integration^0",
      "git push origin 'integration@{0}'",
      "git push origin 'integration^{commit}:refs/heads/x'",
      "git push origin integration~0:ir-5",
    ])("denies a glob, a heads/ name or a revision of it: %s", (c) =>
      expect(deny(c, inTree())).toMatch(/never pushed/),
    );
    it("denies a revision of HEAD from inside the tree", () =>
      expect(deny("git push origin HEAD~0:ir-5", inTree({ cwd: INTEGRATION }))).toMatch(/never pushed/));
    it("lets a glob or a name that cannot reach it through", () => {
      passes("git push origin 'refs/tags/*'", inTree());
      passes("git push origin 'refs/heads/feature/*'", inTree());
      passes("git push origin integration-tests", inTree());
      passes("git push origin heads/ir-5", inTree());
      passes("git push origin HEAD~0:ir-5", inTree());
    });
  });
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
      expect(calls.comments).toEqual([[1290, MASTER]]);
      expect(calls.timeline).toEqual([[1290, "2026-09-30T18:38:58Z", MASTER]]);
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

    it("--admin skips it with the other review checks", () => {
      const { c, calls } = arrange({ read: () => undefined, replay: { ...clean, differing: ["a.ts"] } });
      passes("gh pr merge 1290 --squash --admin", c);
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
        expect(calls.timeline).toEqual([[1290, "2026-09-30T18:38:58Z", MASTER]]);
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
    const spec = (body) => ctx({ staged: () => ["docs/superpowers/specs/a.md"], committedText: () => body });
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
      passes(
        "git commit -m x",
        ctx({ staged: () => ["docs/superpowers/specs/a.md"], committedText: () => undefined }),
      ));
    // #1466: a spec-only push runs no CI, so the commit is the last check.
    it("denies a raw control byte in a new spec, naming the line", () =>
      expect(deny("git commit -m x", spec(`${whole}\n\nPK\x03`))).toMatch(
        /a\.md has a raw control byte 0x03 on line 13/,
      ));
    it("denies a raw control byte in an AMENDMENT too — unlike the sections, this is not forward-only", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({ staged: () => ["docs/superpowers/specs/a.md"], committedText: () => "# T\x00", tracked: () => true }),
        ),
      ).toMatch(/0x00 on line 1/));
    it("names a control byte and missing sections in one deny", () => {
      const v = deny("git commit -m x", spec("# T\x01"));
      expect(v).toMatch(/0x01 on line 1/);
      expect(v).toMatch(/Out of scope/);
    });
    it("allows tab, CR and LF in a spec", () => passes("git commit -m x", spec(whole.replace("vitest", "a\tb\r\nc"))));
    it("leaves an AMENDMENT alone — the requirement is forward-only", () =>
      passes(
        "git commit -m x",
        ctx({ staged: () => ["docs/superpowers/specs/a.md"], committedText: () => "# T", tracked: () => true }),
      ));
    it("still checks the new spec in a commit that also amends an old one", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({
            staged: () => ["docs/superpowers/specs/old.md", "docs/superpowers/specs/new.md"],
            committedText: () => "# T",
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
            committedText: (_d, f) => (f.endsWith("a.md") ? whole : "# T"),
          }),
        ),
      ).toMatch(/b\.md/));
    it("still denies the feature branch first — the branch is the bigger mistake", () =>
      expect(
        deny(
          "git commit -m x",
          ctx({ branch: () => "ir-1", staged: () => ["docs/superpowers/specs/a.md"], committedText: () => "# T" }),
        ),
      ).toMatch(/never on a feature branch/));

    // #1193 review (CodeRabbit): the bytes checked must be the bytes committed.
    describe("reads each spec from where the commit takes it", () => {
      const A = "docs/superpowers/specs/a.md";
      // The index copy and the working copy disagree; each case says which one the commit takes.
      const split = (index, worktree, o = {}) =>
        ctx({ committedText: (_d, _f, from) => (from === "index" ? index : worktree), ...o });
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
    const broad = (o = {}) => ctx({ untracked: () => [NEW, "src/x.ts"], committedText: () => "# T", ...o });
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

describe("git commit: the Elgato manifest never carries a Debug key (#1338)", () => {
  const M = ELGATO_MANIFEST;
  const OFF = '{\n  "Nodejs": {\n    "Version": "24"\n  }\n}\n';
  const ON = OFF.replace('"24"\n', `"24",\n    "Debug": "${DEBUG_VALUE}"\n`);
  /**
   * A checkout whose manifest reads `index` when staged bytes are asked for and
   * `worktree` for the working copy; `reads` records which copies the rule read.
   */
  const repo = ({ index = OFF, worktree = OFF, ...o } = {}) => {
    const reads = [];
    const c = ctx({
      toplevel: () => MASTER,
      committedText: (_d, f, from) => {
        if (f !== M) return undefined;
        reads.push(from);
        return from === "index" ? index : worktree;
      },
      ...o,
    });
    return Object.assign(c, { reads });
  };
  // The maintainer's master: `debug:plugin on` in effect, nothing staged.
  const dirtyOn = (o = {}) => repo({ worktree: ON, modified: () => [M, "src/a.ts"], ...o });

  it("allows a commit whose manifest carries no Debug key", () => {
    passes("git commit -m x", repo({ staged: () => [M] }));
    passes(`git commit -m x -- ${M}`, repo());
    passes("git commit -am x", repo({ modified: () => [M] }));
  });

  it("denies a staged manifest carrying the key, naming the fix", () => {
    const v = deny("git commit -m x", repo({ staged: () => [M], index: ON }));
    expect(v).toContain(M);
    expect(v).toContain("pnpm debug:plugin off");
    expect(v).toMatch(/staged copy/);
  });

  it("allows other paths while the manifest is dirty with the key but not staged", () => {
    const c = dirtyOn({ staged: () => ["src/a.ts"] });
    passes("git commit -m x", c);
    passes("git commit --only -m x -- src/a.ts", c);
    passes("git commit -m x src/a.ts", c);
    passes("git add src/a.ts && git commit -m x", c);
    passes("git add src && git commit -m x", c);
    // Never read at all: none of these commits take the manifest.
    expect(c.reads).toEqual([]);
  });

  it("does not fire on a mention inside a commit message", () => {
    const c = dirtyOn({ staged: () => ["src/a.ts"] });
    passes(`git commit -m "chore: pnpm debug:plugin on, git commit -am ${M} -- ${M}"`, c);
    passes(`git commit -m "$(cat <<'EOF'\nfix: x -a\n\n${M} "Debug" -- ${M}\nEOF\n)" -- src/a.ts`, c);
    passes(`git commit -q -F - <<'EOF'\nfix: x\n\ngit commit -a -- ${M}\nEOF`, c);
    passes(`echo "git commit -am x -- ${M}"`, c);
  });

  it("reads the working copy for -a, a pathspec, or a chained git add that selects the manifest", () => {
    for (const command of [
      "git commit -am x",
      "git commit -a -m x",
      "git commit --all -m x",
      `git commit -m x -- ${M}`,
      `git commit --only -m x -- ${M}`,
      `git commit -m x ${M}`,
      `git commit -m x -- packages/iracing-plugin-stream-deck`,
      `git commit -m x -- .`,
      `git commit -m x -- 'packages/*/com.iracedeck.sd.core.sdPlugin/manifest.json'`,
      `git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)" -- ${M}`,
      `git add ${M} && git commit -m x`,
      "git add . && git commit -m x",
      "git add -A && git commit -m x",
      "git add -u && git commit -m x",
      "git add packages/ && git commit -m x",
    ])
      expect(deny(command, dirtyOn()), command).toMatch(/working copy/);
  });

  it("resolves a pathspec against the command's own directory", () => {
    const sub = path.join(MASTER, "packages", "iracing-plugin-stream-deck");
    expect(
      deny("cd packages/iracing-plugin-stream-deck && git commit -m x -- com.iracedeck.sd.core.sdPlugin", dirtyOn()),
    ).toMatch(/working copy/);
    passes(`cd ${sub} && git commit -m x -- src`, dirtyOn());
  });

  it("judges a plain commit on the staged copy, and -a on the working copy", () => {
    // Staged with the key, switched off since: a plain commit still records the key.
    deny("git commit -m x", repo({ staged: () => [M], index: ON, worktree: OFF }));
    passes("git commit -am x", repo({ staged: () => [M], index: ON, worktree: OFF }));
    // Staged clean, switched on since: the plain commit records the clean copy.
    passes("git commit -m x", repo({ staged: () => [M], index: OFF, worktree: ON }));
    deny("git commit -am x", repo({ staged: () => [M], index: OFF, worktree: ON }));
  });

  it("a pathspec leaves a staged manifest out, unless -i includes the staged files", () => {
    const c = () => repo({ staged: () => [M], index: ON });
    passes("git commit -m x -- src/a.ts", c());
    expect(deny("git commit -i -m x -- src/a.ts", c())).toMatch(/staged copy/);
    expect(deny("git commit --include -m x -- src/a.ts", c())).toMatch(/staged copy/);
  });

  it("reads both copies when the selection is decided at run time", () => {
    for (const command of [
      `git commit -m x "$P"`,
      "git commit -m x $(git diff --name-only)",
      "git commit --pathspec-from-file=f -m x",
    ]) {
      const c = dirtyOn();
      expect(deny(command, c), command).toMatch(/working copy/);
      expect(c.reads).toContain("index");
    }
  });

  it("does not mistake an option's value or an attached option for a flag", () => {
    const c = dirtyOn();
    // `-m` takes "-a"; `-S` carries its key id attached; `-C HEAD` reuses a message.
    passes('git commit -m "-a" -- src/a.ts', c);
    passes("git commit -Sabc -m x", c);
    passes("git commit -C HEAD --amend", c);
  });

  it("names a value the switch did not set without offering the switch", () => {
    const v = deny("git commit -m x", repo({ staged: () => [M], index: ON.replace(DEBUG_VALUE, "enabled") }));
    expect(v).toContain('"enabled"');
    expect(v).toMatch(/by hand/);
  });

  it("judges unparseable text by a plain search", () => {
    deny("git commit -m x", repo({ staged: () => [M], index: '{ "Nodejs": { "Debug": "x", } ' }));
    passes("git commit -m x", repo({ staged: () => [M], index: "{ nope" }));
  });

  it("passes when the manifest's bytes cannot be read", () =>
    passes("git commit -am x", repo({ committedText: () => undefined })));

  it("follows git -C to the tree the commit runs in", () => {
    const c = dirtyOn({ toplevel: () => tree("ir-5") });
    expect(deny(`git -C ../ir-5 commit -m x -- ${M}`, c)).toMatch(/working copy/);
    passes(`git -C ../ir-5 commit -m x -- src/a.ts`, c);
  });
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

  // #1520: the one permanent tree the deck links to for combined manual tests.
  describe("the integration tree", () => {
    it("accepts ../ir-integration, with no spec gate since it names no issue", () =>
      passes("git worktree add ../ir-integration -b integration origin/master", ctx({ specFiles: () => [] })));
    it("still refuses every other name, near misses included", () => {
      for (const name of ["ir-integrations", "ir-Integration", "integration", "ir-integration-2", "ir-"])
        expect(deny(`git worktree add ../${name} -b x`)).toMatch(/ir-<issue>/);
    });
    it("still has to be a fresh sibling", () => {
      expect(deny("git worktree add .worktrees/ir-integration -b integration")).toMatch(/siblings/);
      expect(
        deny(
          "git worktree add ../ir-integration -b integration",
          ctx({ originFresh: () => ({ fresh: false, local: "a", remote: "b" }) }),
        ),
      ).toMatch(/stale/);
    });
  });

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

// #1520: Niklas may be racing on the plugin a deck host runs, and a restart, a
// stop, a start or a relink of that host breaks the session. A build or an
// install does not (#1526): the host keeps the plugin it loaded until it restarts.
describe("nothing restarts or relinks a deck host without Niklas's go", () => {
  const ROOTS = [MASTER, tree("ir-5"), tree("ir-integration")];
  const linkedTo = (root, host = "Stream Deck", o = {}) =>
    ctx({
      linkTargets: () => [
        { host, target: path.join(root, "packages", "iracing-plugin-stream-deck", "com.iracedeck.sd.core.sdPlugin") },
        { host: "Ulanzi", target: undefined },
      ],
      toplevel: (d) => ROOTS.find((r) => isInside(d, r)),
      ...o,
    });
  const linked = linkedTo(MASTER);
  const elsewhere = linkedTo(tree("ir-integration"));

  it.each([
    "pnpm build:with-restart",
    "pnpm run build:with-restart",
    "pnpm build:stream-deck",
    "pnpm restart:stream-deck",
    "pnpm watch:stream-deck",
    "pnpm link:mirabox",
    "pnpm relink:stream-deck",
    "pnpm unlink:ulanzi",
    "pnpm -C ../ir-5 restart:stream-deck",
    "node scripts/integration-build.mjs --restart fix/1-a feature/2-b",
    "node ../master/scripts/integration-build.mjs fix/1-a --restart",
    "node scripts/build-with-restart.mjs",
    "streamdeck restart com.iracedeck.sd.core",
    "streamdeck link packages/x",
    "git status && pnpm restart:stream-deck",
    "pnpm build && pnpm restart:stream-deck",
    "npm run restart:stream-deck",
    "npm run build:with-restart",
    "node scripts/link-mirabox.mjs",
    "node scripts/unlink-ulanzi.mjs",
  ])("always asks, linked or not: %s", (c) => {
    expect(asks(c, linked)).toMatch(/Niklas/);
    expect(asks(c, elsewhere)).toMatch(/Niklas/);
    expect(asks(c, ctx())).toMatch(/Niklas/);
  });

  it("says what still needs a go and what does not", () =>
    expect(asks("pnpm restart:stream-deck", linked)).toMatch(
      /No deck host restarts, stops, starts or relinks without Niklas's go \(#1520, #1526\).*Builds and installs need none/,
    ));

  // #1526: building needs no go, even in the tree a host's link points into.
  it.each([
    "pnpm build",
    "pnpm run build",
    "pnpm build:ts",
    "pnpm build:force",
    "pnpm install",
    "pnpm i",
    "pnpm add zod",
    "pnpm remove zod",
    "pnpm rm zod",
    "pnpm update",
    "pnpm up",
    "pnpm --filter @iracedeck/logger build",
    "pnpm clean",
    "pnpm precommit",
    "pnpm dev",
    "pnpm dev:x",
    "pnpm watch",
    "set -o pipefail; pnpm build 2>&1 | tail -5",
    "pnpm test && pnpm build",
    "pnpm install --frozen-lockfile && pnpm typecheck",
    "npm run build",
    "npm run-script build:ts",
    "npm run build -- --force",
    "npm install",
    "npm i",
    "npm ci",
    "npm --workspace @iracedeck/logger run build",
    "pnpm turbo build",
    "pnpm turbo run build --filter=@iracedeck/logger",
    "pnpm exec turbo run build",
    "pnpm dlx turbo build",
    "npx turbo run build",
    "npx --yes turbo@2.5.0 run build",
    "npm exec turbo run build",
    "npm exec -- turbo build",
    "turbo run build",
    "turbo run lint build",
    "turbo watch build",
    "turbo run dev",
    "turbo run clean",
    "node_modules/.bin/turbo run build",
    "node scripts/build.mjs",
    "node --run build",
    "node --run=build",
    "node scripts/integration-build.mjs fix/1-a feature/2-b",
    "node scripts/integration-build.mjs --no-build fix/1-a",
  ])("passes a build, an install or a clean, linked or not: %s", (c) => {
    passes(c, linked);
    passes(c, elsewhere);
  });

  // `--restart` is a strict parseArgs boolean, so it is read only as the
  // script's own option: after a `--` it is a positional, and no other
  // spelling restarts anything.
  it("asks for integration-build only with its own --restart", () => {
    asks("node scripts/integration-build.mjs --restart fix/1-a", ctx());
    asks("node scripts/integration-build.mjs fix/1-a --restart", ctx());
    passes("node scripts/integration-build.mjs fix/1-a", linked);
    passes("node scripts/integration-build.mjs -- --restart", ctx());
    passes("node scripts/integration-build.mjs --no-restart fix/1-a", ctx());
    passes(`echo "node scripts/integration-build.mjs --restart"`, ctx());
    expect(asks("node scripts/integration-build.mjs --restart fix/1-a", ctx())).toMatch(
      /stops and starts the deck hosts linked to its tree/,
    );
  });

  // dev:voices rebuilds and relinks the hosts already linked to its tree, so it
  // is the one command left that asks only where a host's link points.
  it.each([
    "pnpm dev:voices on",
    "pnpm run dev:voices off",
    "npm run dev:voices",
    "node --run dev:voices",
    "node --run=dev:voices",
    "turbo run dev:voices",
    "node scripts/dev-voices.mjs on",
  ])("asks for dev:voices in the linked tree, and passes it in an unlinked one: %s", (c) => {
    expect(asks(c, linked)).toMatch(/Stream Deck plugin link points into .*master.*relinks the running plugin/);
    passes(c, elsewhere);
  });
  it("judges dev-voices.mjs by its own tree as well as the cwd", () => {
    asks("node ../ir-integration/scripts/dev-voices.mjs on", elsewhere);
    passes("node ../ir-5/scripts/dev-voices.mjs on", elsewhere);
    asks("node ../master/scripts/dev-voices.mjs on", linkedTo(MASTER, "Stream Deck", { cwd: tree("ir-5") }));
  });

  it("moves npm by --prefix / -C and turbo by --cwd, as pnpm by -C", () => {
    asks("npm --prefix ../ir-integration run dev:voices", elsewhere);
    asks("npm run dev:voices --prefix=../ir-integration", elsewhere);
    asks("npm -C ../ir-integration run dev:voices", elsewhere);
    passes("npm --prefix ../ir-5 run dev:voices", linked);
    asks("turbo run dev:voices --cwd ../ir-integration", elsewhere);
    asks("turbo run dev:voices --cwd=../ir-integration", elsewhere);
    passes("turbo run dev:voices --cwd ../ir-5", linked);
    asks("pnpm -C ../ir-integration exec turbo run dev:voices", elsewhere);
    asks("cd ../ir-integration && npx turbo run dev:voices", elsewhere);
  });

  it("passes npm and turbo commands that restart nothing", () => {
    for (const c of [
      "npm test",
      "npm run test",
      "npm run typecheck",
      "npm run lint -- --fix",
      "npm --version",
      "npm view turbo version",
      "npx prettier --check .",
      "npx turbo run test",
      "pnpm exec turbo run lint typecheck",
      "pnpm exec tsc --noEmit",
      "turbo run test",
      "turbo --version",
      "turbo run test --filter=build",
    ])
      passes(c, linked);
  });

  it("is not fooled by an npm or turbo mention", () => {
    passes(`echo "npm run dev:voices"`, linked);
    passes(`grep -n "turbo run dev:voices" turbo.json`, linked);
  });

  it("judges the tree the command runs in: a cd, a pnpm -C or --dir, a subdirectory", () => {
    asks("cd ../ir-integration && pnpm dev:voices on", elsewhere);
    passes("cd ../ir-5 && pnpm dev:voices on", linked);
    asks("pnpm -C ../ir-integration dev:voices on", elsewhere);
    asks("pnpm --dir ../ir-integration dev:voices off", elsewhere);
    asks("pnpm --dir=../ir-integration dev:voices on", elsewhere);
    passes("pnpm -C ../ir-5 dev:voices on", linked);
    asks("cd packages/logger && pnpm dev:voices on", linked);
    asks("cd ../ir-5 && pnpm dev:voices on && cd ../master && pnpm dev:voices off", linked);
  });

  it("is not moved by a git -C, which is git's own", () => {
    passes("git -C ../ir-integration status && pnpm dev:voices on", elsewhere);
    asks("git -C ../ir-5 log -1 && pnpm dev:voices on", linked);
  });

  it("names every host linked into the tree", () =>
    expect(
      asks(
        "pnpm dev:voices on",
        ctx({
          linkTargets: () => [
            { host: "Stream Deck", target: path.join(MASTER, "a") },
            { host: "Mirabox", target: path.join(MASTER, "b") },
          ],
        }),
      ),
    ).toMatch(/Stream Deck and Mirabox/));

  it("passes what restarts nothing, linked or not", () => {
    for (const c of ["pnpm test", "pnpm typecheck", "pnpm lint", "pnpm format:fix", "pnpm test scripts/claude-hooks"])
      passes(c, linked);
  });

  it("passes a host's packaged install, which is no link at all", () =>
    passes(
      "pnpm dev:voices on",
      ctx({ linkTargets: () => [{ host: "Stream Deck", target: "(a real directory, not a link)" }] }),
    ));

  it("is not fooled by a mention", () => {
    passes(`echo "pnpm build:with-restart"`, linked);
    passes(`grep -n "pnpm restart:stream-deck" README.md`, linked);
    passes(`git commit -q -m "run pnpm restart:stream-deck later" -- x.md`, linked);
  });

  // Second read (#1520): the root scripts that stop, start or switch a host
  // were not on the name lists. They stay there as the floor, for a
  // package.json the hook cannot read.
  it.each([
    "pnpm switch-test-env",
    "pnpm switch-test-env:mirabox",
    "pnpm stop:stream-deck",
    "pnpm stop:mirabox",
    "pnpm start:stream-deck",
    "pnpm start:ulanzi",
    "node --run restart:stream-deck",
  ])("always asks by name, with no package.json to read: %s", (c) => {
    expect(asks(c, elsewhere)).toMatch(/Niklas/);
    expect(asks(c, ctx())).toMatch(/Niklas/);
  });

  it.each([
    "streamdeck.cmd restart com.iracedeck.sd.core",
    "streamdeck.exe link packages/x",
    "streamdeck.ps1 unlink -d com.iracedeck.sd.core",
    "node_modules/.bin/streamdeck restart com.iracedeck.sd.core",
    "pnpm exec streamdeck restart com.iracedeck.sd.core",
    "pnpm streamdeck restart com.iracedeck.sd.core",
    "pnpm dlx streamdeck stop com.iracedeck.sd.core",
    "npx streamdeck restart com.iracedeck.sd.core",
    "npx --yes streamdeck link packages/x",
    "npm exec streamdeck unlink -d com.iracedeck.sd.core",
  ])("asks for the Stream Deck CLI behind any lead: %s", (c) => expect(asks(c, ctx())).toMatch(/deck host/));
  it("passes the Stream Deck CLI's harmless verbs", () => {
    passes("npx streamdeck --version", ctx());
    passes("pnpm exec streamdeck validate packages/x", ctx());
  });

  // #1526: the Stream Deck plugin's `watch` restarts the host on every rebuild
  // through a rollup watch hook, a command line inside a quoted option value.
  it.each([
    `rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
    `rollup -c -w --watch.onEnd "streamdeck restart com.iracedeck.sd.core"`,
    `rollup -c -w --watch.onEnd='streamdeck restart com.iracedeck.sd.core'`,
    `rollup -c -w --watch.onBundleEnd="pnpm restart:stream-deck"`,
    `rollup -c -w --watch.onStart="taskkill /IM StreamDeck.exe /F"`,
    `node_modules/.bin/rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
    `npx rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
    `pnpm exec rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
    `pnpm rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
    `node x.mjs && rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`,
  ])("asks for a rollup watch hook that restarts a host, linked or not: %s", (c) => {
    expect(asks(c, ctx())).toMatch(/`rollup --watch\.on\w+` → .*deck host/);
    asks(c, linked);
  });
  it("passes a rollup watch whose hooks restart nothing", () => {
    for (const c of [
      "rollup -c",
      "rollup -c -w",
      `rollup -c -w --watch.onEnd="echo done"`,
      "rollup -c --watch.clearScreen=false",
      `echo 'rollup -c -w --watch.onEnd="streamdeck restart x"'`,
    ])
      passes(c, linked);
  });
  // Positive control: the plain splitter cuts the hook at its quote, leaving no
  // value to read, which is why the rule splits the way the shell does.
  it("needs the shell's word splitting to see the hook", () =>
    expect(words(`--watch.onEnd="streamdeck restart x"`)).toEqual([`--watch.onEnd="streamdeck`, "restart", `x"`]));

  it.each([
    "taskkill /IM StreamDeck.exe /F",
    "taskkill /F /IM UlanziDeck.exe",
    "taskkill /im streamdock.exe",
    'start /B "" "C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe"',
    "node scripts/host-app.mjs stop mirabox",
    "node ../master/scripts/host-app.mjs start ulanzi",
  ])("always asks for what stops or starts a host app: %s", (c) => expect(asks(c, ctx())).toMatch(/Niklas/));
  it("passes what stops or starts something else", () => {
    passes("taskkill /IM notepad.exe /F", ctx());
    passes("start https://iracedeck.com", ctx());
    passes("node scripts/host-app.mjs", ctx());
  });

  // #1526: deleting a linked plugin's build output is a build step like any other.
  it("passes a rimraf of a linked plugin's files", () => {
    const bin = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin";
    passes(`rimraf ${bin}/plugin.js`, linked);
    passes(`pnpm exec rimraf ${bin}`, linked);
    passes("npx rimraf packages/iracing-plugin-stream-deck", linked);
    passes(`cd packages/iracing-plugin-stream-deck && rimraf com.iracedeck.sd.core.sdPlugin/bin/plugin.js`, linked);
  });
});

// Second read (#1520): a script name is a list that is always one behind, so
// a pnpm, npm or `node --run` script is judged by the command line it runs,
// read from the package.json of the directory it runs in.
describe("a script is judged by what it runs", () => {
  const IR5 = tree("ir-5");
  const pluginOf = (root) => path.join(root, "packages", "iracing-plugin-stream-deck");
  const ROOT_SCRIPTS = {
    test: "vitest run --configLoader native",
    lint: 'eslint "packages/*/src/**" "**/*.mjs"',
    typecheck: "turbo run typecheck",
    build: "node scripts/build.mjs",
    hostkill: "taskkill /IM StreamDeck.exe /F || exit 0",
    hoststart: 'start /B "" "C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe',
    "ulanzi-off": "node scripts/host-app.mjs stop ulanzi",
    swap: "pnpm install && pnpm build && pnpm relink:mirabox",
    wrapped: "pnpm swap",
    scrub: "turbo run wipe",
    "plugin-reload": "pnpm --filter @iracedeck/iracing-plugin-stream-deck reload",
    "loop-a": "pnpm loop-b",
    "loop-b": "pnpm loop-a",
    "loop-c": "pnpm loop-d",
    "loop-d": "pnpm loop-c && pnpm relink:ulanzi",
    tidy: "pnpm clean",
    deep: "pnpm deep1",
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`deep${i + 1}`, `pnpm deep${i + 2}`])),
    deep21: "pnpm relink:ulanzi",
    "dev:voices": "node scripts/dev-voices.mjs",
    voices: "pnpm dev:voices on",
    integ: "node scripts/integration-build.mjs",
    "plugin-watch": "pnpm --filter @iracedeck/iracing-plugin-stream-deck watch",
    "watch-all": "turbo run watch",
  };
  // The plugins' real `watch` lines: Stream Deck's restarts the host after every rebuild.
  const PLUGIN_SCRIPTS = {
    clean: "rimraf com.iracedeck.sd.core.sdPlugin/bin/plugin.js",
    wipe: "rimraf com.iracedeck.sd.core.sdPlugin/bin",
    typecheck: "tsc --noEmit",
    reload: "streamdeck restart com.iracedeck.sd.core",
    bundle: "rollup -c",
    watch:
      'node ../../scripts/generate-changelog-data.mjs && rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"',
  };
  const MIRABOX_SCRIPTS = {
    clean: "rimraf com.iracedeck.sd.core.sdPlugin/bin/plugin.js",
    watch: "node ../../scripts/generate-changelog-data.mjs && rollup -c -w",
  };
  const mirabox = (root) => path.join(root, "packages", "iracing-plugin-mirabox");
  const manifests = {};
  for (const root of [MASTER, IR5]) {
    manifests[root] = { name: "iracedeck", scripts: ROOT_SCRIPTS };
    manifests[pluginOf(root)] = { name: "@iracedeck/iracing-plugin-stream-deck", scripts: PLUGIN_SCRIPTS };
    manifests[mirabox(root)] = { name: "@iracedeck/iracing-plugin-mirabox", scripts: MIRABOX_SCRIPTS };
    manifests[path.join(root, "packages", "logger")] = {
      name: "@iracedeck/logger",
      scripts: { clean: "rimraf dist", typecheck: "tsc --noEmit" },
    };
  }
  const scriptsAt = (dir) => {
    for (let d = dir; ; d = path.dirname(d)) {
      if (manifests[d]) return { dir: d, ...manifests[d] };
      if (path.dirname(d) === d) return undefined;
    }
  };
  const workspaceDirs = (root) => Object.keys(manifests).filter((d) => path.dirname(d) === path.join(root, "packages"));
  const at = (linkRoot, o = {}) =>
    ctx({
      linkTargets: () => [
        { host: "Stream Deck", target: path.join(pluginOf(linkRoot), "com.iracedeck.sd.core.sdPlugin") },
      ],
      toplevel: (d) => [MASTER, IR5].find((r) => isInside(d, r)),
      scriptsAt,
      workspaceDirs,
      packages: () => ({
        "@iracedeck/iracing-plugin-stream-deck": { dir: pluginOf(MASTER), scripts: Object.keys(PLUGIN_SCRIPTS) },
        "@iracedeck/iracing-plugin-mirabox": { dir: mirabox(MASTER), scripts: Object.keys(MIRABOX_SCRIPTS) },
      }),
      ...o,
    });
  const linked = at(MASTER);
  const elsewhere = at(tree("ir-integration"));

  it.each([
    "pnpm hostkill",
    "pnpm run hostkill",
    "pnpm hoststart",
    "pnpm ulanzi-off",
    "pnpm swap",
    "pnpm wrapped",
    "pnpm plugin-reload",
    "pnpm --filter @iracedeck/iracing-plugin-stream-deck reload",
    "pnpm --filter=@iracedeck/iracing-plugin-stream-deck run reload",
    "pnpm -C packages/iracing-plugin-stream-deck reload",
    "cd packages/iracing-plugin-stream-deck && pnpm reload",
    "npm run hostkill",
    "npm --prefix ../ir-5 run swap",
    "node --run hostkill",
    "node --run=swap",
    "cd ../ir-5 && pnpm swap",
  ])("asks for what the script runs, linked or not: %s", (c) => {
    expect(asks(c, elsewhere)).toMatch(/Niklas/);
    expect(asks(c, linked)).toMatch(/Niklas/);
  });

  it("names the script and what it reached", () =>
    expect(asks("pnpm wrapped", elsewhere)).toMatch(/`pnpm wrapped` → `pnpm swap` → `pnpm relink:mirabox`/));

  // #1526: the Stream Deck plugin's `watch` restarts the host after every
  // rebuild through its rollup hook. It used to be caught only by the
  // linked-tree `watch` name; now it is judged by what it runs, anywhere.
  it.each([
    "pnpm --filter @iracedeck/iracing-plugin-stream-deck watch",
    "pnpm --filter=@iracedeck/iracing-plugin-stream-deck run watch",
    "cd packages/iracing-plugin-stream-deck && pnpm watch",
    "pnpm -C packages/iracing-plugin-stream-deck run watch",
    "pnpm plugin-watch",
    "pnpm watch-all",
    "turbo run watch",
    "turbo watch watch",
  ])("asks for the Stream Deck plugin's watch by its rollup hook, linked or not: %s", (c) => {
    expect(asks(c, elsewhere)).toMatch(/`rollup --watch\.onEnd` → `streamdeck restart/);
    expect(asks(c, linked)).toMatch(/Niklas/);
  });
  it("passes a plugin watch whose rollup runs no hook", () => {
    passes("pnpm --filter @iracedeck/iracing-plugin-mirabox watch", linked);
    passes("cd packages/iracing-plugin-mirabox && pnpm watch", linked);
  });

  it("asks for dev:voices where linked, through a script too, and passes it elsewhere", () => {
    expect(asks("pnpm dev:voices on", linked)).toMatch(/`pnpm dev:voices` there relinks the running plugin/);
    expect(asks("pnpm voices", linked)).toMatch(/`pnpm voices` → .*`pnpm dev:voices` there relinks/);
    passes("pnpm dev:voices on", elsewhere);
    passes("pnpm voices", elsewhere);
  });

  // A runner appends what follows the script's name to its command line, so a
  // flag that decides the ask is read through a wrapping script too.
  it("hands a script the arguments its runner forwards", () => {
    expect(asks("pnpm integ --restart fix/1-a", elsewhere)).toMatch(
      /`pnpm integ` → `node scripts\/integration-build\.mjs --restart`/,
    );
    asks("pnpm run integ fix/1-a --restart", elsewhere);
    asks("pnpm integ -- --restart fix/1-a", elsewhere);
    asks("npm run integ -- --restart fix/1-a", elsewhere);
    asks("node --run integ -- --restart fix/1-a", elsewhere);
    asks("node --run=integ -- --restart", elsewhere);
    asks(`turbo run bundle -- --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`, elsewhere);
    passes("pnpm integ fix/1-a", linked);
    passes("npm run integ -- fix/1-a", linked);
    passes("node --run integ -- fix/1-a", linked);
    passes("turbo run bundle", linked);
  });

  // #1526: a clean or a build a script reaches needs no go either, in the linked tree too.
  it.each([
    "pnpm build",
    "pnpm scrub",
    "pnpm tidy",
    "turbo run wipe",
    "turbo run clean",
    "pnpm --filter @iracedeck/iracing-plugin-stream-deck clean",
    "cd packages/iracing-plugin-stream-deck && pnpm wipe",
  ])("passes a build or a clean the script reaches, linked or not: %s", (c) => {
    passes(c, linked);
    passes(c, elsewhere);
  });

  it("passes what reaches no restart or relink", () => {
    for (const c of ["pnpm test", "pnpm lint", "pnpm typecheck", "pnpm test scripts/claude-hooks", "node --run test"])
      passes(c, linked);
  });

  it("stops at a cycle, and still judges what the cycle runs", () => {
    passes("pnpm loop-a", linked);
    expect(asks("pnpm loop-c", elsewhere)).toMatch(/relink:ulanzi/);
  });
  it("stops at its depth bound, where the name is all it judges", () => passes("pnpm deep", elsewhere));

  it("falls back to the name when the script cannot be read", () => {
    passes("pnpm no-such-script", linked);
    passes("pnpm hostkill", at(MASTER, { scriptsAt: () => undefined }));
    passes("pnpm --filter ./packages/* reload", linked);
    expect(asks("pnpm stop:stream-deck", at(MASTER, { scriptsAt: () => undefined }))).toMatch(/Niklas/);
  });

  it("does not read a pnpm built-in as a script", () =>
    passes(
      "pnpm install",
      at(MASTER, { cwd: IR5, scriptsAt: () => ({ dir: IR5, scripts: { install: "pnpm relink:x" } }) }),
    ));
});

// #1520: PowerShell is this environment's primary shell, and its commands
// reached no guard. They get every rule that is not bash syntax.
describe("PowerShell commands", () => {
  const ROOTS = [MASTER, tree("ir-5"), tree("ir-integration")];
  const ps = (root, o = {}) =>
    ctx({
      shell: POWERSHELL,
      linkTargets: () => [{ host: "Stream Deck", target: path.join(root, "packages", "plugin") }],
      toplevel: (d) => ROOTS.find((r) => isInside(d, r)),
      ...o,
    });
  const linked = ps(MASTER);
  const elsewhere = ps(tree("ir-integration"));

  // `dev:voices` is the one command that asks only in a linked tree (#1526), so
  // it is the vehicle that shows where a command was judged to run.
  it("asks for dev:voices in the linked tree and passes it elsewhere, and passes a build in either", () => {
    expect(asks("pnpm dev:voices on", linked)).toMatch(/Stream Deck plugin link points into .*master/);
    passes("pnpm dev:voices on", elsewhere);
    asks("npm run dev:voices", linked);
    asks("& pnpm dev:voices off", linked);
    asks("pnpm restart:stream-deck", elsewhere);
    passes("pnpm build", linked);
    passes("& pnpm install", linked);
  });

  it("splits a chain at ; and newlines, and moves the base by cd and Set-Location", () => {
    asks("git status; pnpm dev:voices on", linked);
    asks("git status\npnpm dev:voices on", linked);
    for (const c of [
      "cd ../ir-integration; pnpm dev:voices on",
      "cd ..\\ir-integration; pnpm dev:voices on",
      "Set-Location ..\\ir-integration; pnpm dev:voices on",
      "set-location -Path '..\\ir-integration'; pnpm dev:voices off",
      'Set-Location -LiteralPath "..\\ir-integration" && pnpm dev:voices on',
      "sl ../ir-integration\npnpm dev:voices on",
      "chdir ../ir-integration; pnpm dev:voices on",
    ])
      asks(c, elsewhere);
    passes("Set-Location ..\\ir-5; pnpm dev:voices on", linked);
    passes("cd -; pnpm dev:voices on", elsewhere); // unknowable, stays put
  });

  it("reads PowerShell's escapes, not bash's: a backtick continues a line, a backslash is a character", () => {
    asks("pnpm `\n  dev:voices on", linked);
    asks("pnpm `\r\n  dev:voices on", linked);
    // `"C:\x\"` ends at its quote in PowerShell; bash would read `\"` as escaped and hide the command.
    asks(`Write-Output "C:\\x\\"; pnpm dev:voices on; Write-Output "C:\\y\\"`, linked);
    // A backtick-escaped quote or semicolon is a literal character.
    passes('Write-Output "a`"; pnpm dev:voices on`""', linked);
    passes("Write-Output a`; pnpm dev:voices on", linked);
  });

  it("denies an integration push, from the tree or by refspec", () => {
    const INTEGRATION = tree("ir-integration");
    const inTree = ctx({ shell: POWERSHELL, branch: (d) => (d === INTEGRATION ? "integration" : "master") });
    expect(deny("git push origin integration", inTree)).toMatch(/never pushed/);
    expect(deny("Set-Location ..\\ir-integration; git push", inTree)).toMatch(/never pushed/);
    expect(deny("git -C ..\\ir-integration push -u origin HEAD", inTree)).toMatch(/never pushed/);
    passes("git push origin master", inTree);
  });

  it("asks for a PowerShell stop or start of a host app", () => {
    for (const c of [
      "Stop-Process -Name StreamDeck -Force",
      "spps -Name UlanziDeck",
      "Start-Process 'C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe'",
      'start-process "C:\\Program Files (x86)\\Ulanzi Studio\\UlanziDeck.exe"',
    ])
      expect(asks(c, elsewhere)).toMatch(/stops or starts a deck host app/);
    passes("Stop-Process -Name notepad", elsewhere);
  });

  it("keeps the shell-agnostic guards", () => {
    expect(asks("git push origin v3.2.0", ctx({ shell: POWERSHELL }))).toMatch(/release/);
    expect(deny("pnpm exec vitest run", ctx({ shell: POWERSHELL }))).toMatch(/vitest/);
    expect(deny("git worktree add ..\\feature-x -b x", ctx({ shell: POWERSHELL }))).toMatch(/ir-<issue>/);
  });

  // The bash-syntax traps describe bash; in PowerShell they would only misfire.
  it.each([
    ["a heredoc carrying a doubled-backslash path", "Write-Output 'x' <<EOF C:\\\\Users"],
    ["a piped build without pipefail", "pnpm build 2>&1 | Select-Object -Last 5"],
    ["jq", "gh pr view --json title | jq .title"],
    ["IRACEDECK_MOCK=0", "IRACEDECK_MOCK=0 pnpm test"],
    ["git show of a slashed ref", "git show origin/feature/x:.claude/rules/hooks.md"],
  ])("does not judge %s", (_, c) => {
    passes(c, ps(tree("ir-integration")));
    // Positive control: the same command is refused as a Bash command.
    deny(c, ctx());
  });
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
    expect(deny("npx vitest")).toMatch(/native config loader/);
    passes("pnpm test packages/x/y.test.ts");
  });
  it("pnpm --filter <pkg> test runs the shared runner, so only a missing script is refused (#1021)", () => {
    const c = ctx({
      packages: () => ({
        "@iracedeck/logger": { dir: "x", scripts: ["build", "typecheck", "test", "test:watch"] },
        "@iracedeck/iracing-plugin-mirabox": { dir: "y", scripts: ["build", "typecheck"] },
      }),
    });
    passes("pnpm --filter @iracedeck/logger test", c);
    passes("pnpm --filter @iracedeck/logger run test", c);
    passes("pnpm --filter @iracedeck/logger test:watch", c);
    passes('pnpm --filter @iracedeck/logger test -t "a name"', c);
    expect(deny("pnpm --filter @iracedeck/iracing-plugin-mirabox test", c)).toMatch(/no "test" script/);
    // A passing filtered command does not shield a later one in the chain.
    expect(
      deny("pnpm --filter @iracedeck/logger test && pnpm --filter @iracedeck/iracing-plugin-mirabox test", c),
    ).toMatch(/iracing-plugin-mirabox has no "test" script/);
    passes("pnpm --filter @iracedeck/logger add zod; pnpm --filter @iracedeck/logger test", c);
    expect(deny("pnpm --filter @iracedeck/logger test")).toMatch(/no "test" script/);
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

// #1321: a trapped shape fires where the shell RUNS it, never where a command
// merely carries it as data — every case below is one that misfired on 2026-10-03.
describe("a mention is not a command (#1321)", () => {
  it("masks inert text without moving anything", () => {
    const command = `grep -n 'a | b' f && echo "x; $(date) y" # tail`;
    const { masked, flat, sure } = maskInert(command);
    expect(sure).toBe(true);
    expect(masked).toBe(`grep -n '_____' f && echo "___$(date)__" ______`);
    expect(flat).toBe(`grep -n _______ f && echo ______________ ______`);
  });

  it("masks a quoted-delimiter heredoc body whole, and keeps an unquoted one's substitutions", () => {
    expect(maskInert("cat <<'EOF'\nrun $(x)\nEOF\nls").masked).toBe("cat <<'EOF'\n_________EOF\nls");
    expect(maskInert("cat <<EOF\nrun $(x)\nEOF\nls").masked).toBe("cat <<EOF\n____$(x)_EOF\nls");
    expect(maskInert("cat <<-EOF\n\tbody\n\tEOF\nls").masked).toBe("cat <<-EOF\n______\tEOF\nls");
  });

  it("splits a chain where the shell splits it, not at a separator inside quotes", () => {
    const status = cmd(/git\s+status\b/);
    expect(gitCwd(`echo 'a; cd ../ir-9' && git status`, MASTER, status)).toBe(MASTER);
    expect(gitCwd(`echo 'a;b' && cd ../ir-5 && git status`, MASTER, status)).toBe(tree("ir-5"));
  });

  it("lets the day's false triggers through", () => {
    for (const command of [
      // The day's grep had an unmatched backtick, which bash refuses; these are the two valid spellings of it.
      "grep -n 'a\\|gh pr merge` | deny' .claude/rules/hooks.md",
      'grep -n "a\\|gh pr merge\\` | deny" .claude/rules/hooks.md',
      `git commit -q -F - <<'EOF'\nfix: x (#1)\n\nso \`gh pr merge 7 … & gh pr\nmerge 8 --admin\` read as one\nEOF`,
      `gh pr comment 1313 --body "two merges joined by & gh pr merge 8 --squash --admin"`,
      `python - <<'EOF'\nprint("pnpm exec vitest run")\nEOF`,
      `grep -rn "gh pr merge" scripts`,
    ])
      passes(command);
  });

  it("still catches a real command in every position", () => {
    for (const command of [
      "ls; gh pr merge 7 --squash",
      "ls && gh pr merge 7 --squash",
      `echo "$(gh pr merge 7 --squash)"`,
      "cat <<EOF\n$(gh pr merge 7 --squash)\nEOF",
      "echo 'quoted' && gh pr merge 7 --squash",
    ])
      // A merge inside a substitution mid-command is caught but cannot be isolated
      // or read; either way it is refused.
      expect(deny(command)).toMatch(/refusing to merge blind|Could not isolate|Could not read this/);
    deny(`echo "done" && pnpm exec vitest run`);
  });

  it("locates a command in the masked text and reads its arguments from the raw text", () => {
    const remove = matchAt(
      `echo "x; git worktree remove ../ir-5" && git worktree remove "../ir 6"`,
      GIT_WORKTREE_REMOVE,
    );
    expect(remove[1]).toBe(` "../ir 6"`);
    expect(matchAt(`echo "sed -i s/a/b/ f"`, cmd(/sed\s+-i/))).toBeNull();
    expect(matchAt("grep 'gh issue create' f", cmd(/gh\s+issue\s+create\b/))).toBeNull();
    expect(matchAt("ls && sed -i s/a/b/ f", cmd(/sed\s+-i/))).not.toBeNull();
  });
});

// The #1321 review (2026-10-04): the first mask failed OPEN — it blanked text
// bash executes, so real commands passed every anchored rule. Each case below
// is a command from that review; the real ones must get the verdict the
// pre-#1321 hook gave them, the mentions must pass.
describe("the mask fails closed (#1321 review)", () => {
  const REAL = /refusing to merge blind|Could not isolate|Could not read this|One `gh pr merge`/;
  const merges = (commands, c = ctx()) => {
    for (const command of commands) expect(deny(command, c), command).toMatch(REAL);
  };
  const linked = ctx({ linkTargets: () => [{ host: "Stream Deck", target: tree("ir-1013", "plugin") }] });
  const green = () => ({
    number: 7,
    state: "OPEN",
    headRefOid: "1".repeat(40),
    headRefName: "ir-7",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [{ author: { login: "coderabbitai" }, state: "APPROVED", commit: { oid: "1".repeat(40) } }],
  });

  describe("the lexer is trusted only when it is sure", () => {
    it("reports an unterminated or impossible construct as unsure", () => {
      for (const command of [
        `echo 'open`,
        `echo "open`,
        `echo $(open`,
        "echo `open",
        "echo ${open",
        `echo $((1 + 2)`,
        `cat <<EOF\nno terminator`,
        `x=$(cat <<'EOF'\nbody\nEOF)\nls`,
        `cat <<EOF`,
        `cat << ;`,
        `case x in x) ls ;; esac`,
        `echo )`,
      ])
        expect(maskInert(command).sure, command).toBe(false);
    });

    it("lexes here-strings, arithmetic, ANSI-C quotes, odd delimiters and parameter words as bash does", () => {
      for (const command of [
        `grep -q OPEN <<< "$(gh pr view 7)"\nls`,
        `echo $((1<<4))\nls`,
        `(( x = 1 << 3 ))\nls`,
        `echo $'it\\'s'`,
        `cat <<E'OF'\nbody\nEOF\nls`,
        `cat <<"E"OF\nbody\nEOF\nls`,
        `cat <<@END\nbody\n@END\nls`,
        `cat <<END+\nbody\nEND+\nls`,
        "echo ${x:- #y}",
        `x="$(echo ")")"`,
        `git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)"`,
        "echo `echo a # c` b",
      ])
        expect(maskInert(command).sure, command).toBe(true);
      expect(maskInert("echo ${x:- #y} && ls").masked).toBe("echo ${x:- #y} && ls");
      expect(maskInert("ls;# don't\nls").masked).toBe("ls;_______\nls");
      expect(maskInert("echo `echo a # c` b").masked).toBe("echo `echo a ___` b");
      expect(maskInert(`cat <<E'OF'\ngh pr merge\nEOF`).masked).toBe(`cat <<E'OF'\n____________EOF`);
    });

    it("reads the raw command when a string or stdin is handed to a shell", () => {
      for (const command of [
        `bash -c 'gh pr merge 7'`,
        `sh -c "x"`,
        `eval "x"`,
        `bash <<'EOF'\nx\nEOF`,
        `timeout 9 bash -c 'x'`,
        `ls | xargs sh -c 'x'`,
        `trap 'x' EXIT`,
      ])
        expect(trustedMask(command), command).toBe(command);
      expect(trustedMask(`python - <<'EOF'\nx\nEOF`)).toBe(`python - <<'EOF'\n__EOF`);
    });
  });

  it("finding 1: a here-string or an arithmetic `<<` is not a heredoc", () => {
    merges([
      `grep -q OPEN <<< "$(gh pr view 7 --json state)"\ngh pr merge 7 --squash --admin`,
      `IFS=, read -r a b <<< "1,2"\ngh pr merge 7 --squash`,
      `mapfile -t arr <<< "$x"\ngh pr merge 7 --squash`,
      `while read -r l; do echo "$l"; done <<< "$list"\ngh pr merge 7 --squash`,
      `echo $((1<<4))\ngh pr merge 7 --squash`,
    ]);
    asks(`read -r a <<< "$x"\ngit push origin v1.2.3`);
    deny(`echo $((1<<4))\npnpm exec vitest run`);
    deny(`(( x = 1 << 3 ))\npnpm exec vitest run`);
    deny(`read -r a <<< "$x"\ngh pr view 1 --json x | jq .x`);
    deny(
      `read -r a <<< "$x"\ngit commit -m "docs(specs): x" -- docs/superpowers/specs/2026-01-01-issue-9-x.md`,
      ctx({ branch: () => "fix/9-x" }),
    );
  });

  it("finding 2: text handed to `bash -c`, `sh -c`, `eval` or a shell-fed heredoc is read raw", () => {
    merges([
      `timeout 900 bash -c 'until gh pr checks 1321; do sleep 30; done; gh pr merge 1321 --squash'`,
      `bash <<'EOF'\ncd ../ir-5\ngh pr merge 7 --squash\nEOF`,
    ]);
    asks(`sh -c "cd x && git push origin v1.2.3"`);
    asks(`sh <<'EOF'\ngit push origin v1.2.3\nEOF`);
    expect(deny(`bash <<'EOF'\ncd ../ir-1013\ngit worktree remove .\nEOF`, linked)).toMatch(/plugin link/);
    deny(`eval "ls; pnpm exec vitest run"`);
    deny(`bash <<'EOF'\npnpm exec vitest run scripts\nEOF`);
    deny(`bash <<'EOF'\ngh pr view 1 --json x | jq .x\nEOF`);
    deny(`bash <<'EOF'\ngh issue create --title x --milestone 3.3\nEOF`);
    expect(
      deny(
        `bash <<'EOF'\ncd ../ir-5\ngit commit -m "docs(specs): x" -- docs/superpowers/specs/2026-01-01-issue-5-x.md\nEOF`,
        ctx({ branch: (d) => (d === tree("ir-5") ? "fix/5-x" : "master") }),
      ),
    ).toMatch(/never on a feature branch/);
  });

  it("finding 3: the one-merge backstop counts raw text, so a second merge in executed text is seen", () => {
    for (const command of [
      `gh pr merge 7 --squash && bash -c 'gh pr merge 8 --squash --admin'`,
      `gh pr merge 7 --squash; eval "gh pr merge 8 --admin --squash"`,
      `gh pr merge 7 --squash\ngrep -q MERGED <<< "$s"\ngh pr merge 8 --squash --admin`,
      // The cost, in the safe direction: a mention beside a real merge is refused too.
      `gh pr merge 7 --squash --body "after gh pr merge 6"`,
    ])
      expect(deny(command, ctx({ prView: green })), command).toMatch(/One `gh pr merge` per command/);
  });

  it('finding 4: nested quotes and heredocs inside `"$(…)"` close where bash closes them', () => {
    merges([
      `x="$(echo ")")" && gh pr merge 7 --squash`,
      `x="$(echo "it's")" && echo ')' && echo "z" && gh pr merge 7 --squash`,
      `git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)" && gh pr merge 5 --squash`,
      `git commit -m "$(cat <<'EOF'\nfix: don't fire\nEOF\n)" && gh pr comment 5 --body 'Done :)' && gh pr merge 5 --squash --body "merged"`,
      `echo "$(echo "(")" && case x in x) gh pr merge 7 --squash;; esac`,
    ]);
    asks(`git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)" && git push origin v1.2.3`);
    deny(`git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)" && pnpm build --force`);
  });

  describe("finding 5: a flag inside a quoted body is not the merge's own", () => {
    // Approved, green and clean, but CodeRabbit's newest review is at an older
    // head: only a real `--admin`, or a real pin on a pure rebase, gets it through.
    const stale = () => ({
      ...green(),
      baseRefOid: "4".repeat(40),
      reviews: [
        {
          author: { login: "coderabbitai" },
          state: "APPROVED",
          commit: { oid: "2".repeat(40) },
          submittedAt: "2026-10-03T10:00:00Z",
        },
      ],
    });
    const seen = [];
    const c = ctx({
      prView: (ref) => (seen.push(ref), stale()),
      baseChangedSince: () => false,
      replayRebase: () => ({ ok: true, differing: [], conflicted: [], lineMismatch: [] }),
    });
    const head = stale().headRefOid;

    it("is refused with the flag only in the body", () => {
      passes("gh pr merge 7 --squash --admin", c);
      passes(`gh pr merge 7 --squash --match-head-commit ${head}`, c);
      for (const command of [
        `gh pr merge 7 --squash --body="Merges the gate fix.\n--admin is not needed for this one."`,
        `gh pr merge 7 --squash --body "Fixes the \\"gate\\";\n--admin is not used here"`,
        `gh pr merge 7 --squash --body="x\n--match-head-commit ${head}"`,
        `gh pr merge 7 --squash "--admin"`,
      ])
        expect(deny(command, c), command).toMatch(/no CodeRabbit review at head/);
    });

    it("judges the PR gh merges, never a number read out of the body", () => {
      seen.length = 0;
      deny(`gh pr merge --squash --body="Done.\n1300 follows up."`, c);
      expect(seen).toEqual([undefined]);
    });

    it("refuses a quoted or substituted PR rather than judging the branch's PR in its place", () => {
      for (const command of [`gh pr merge "7" --squash`, `gh pr merge $(cat pr.txt) --squash`])
        expect(deny(command, c), command).toMatch(/Could not read this/);
    });
  });

  it("finding 6: a misread mask falls back to the raw command instead of blanking the rest", () => {
    merges([`echo 'unterminated && gh pr merge 7 --squash`, `cat <<EOF\nnever closed\ngh pr merge 7 --squash`]);
  });

  it("finding 7: an indented line, a backtick and a case arm are command positions", () => {
    merges([
      `if gh pr checks 7; then\n  echo green\n  gh pr merge 7 --squash\nfi`,
      // #1328 review: a case pattern's `)` inside a quoted substitution.
      `x="$(case $y in a) gh pr merge 7 --squash;; esac)"`,
      `cat <<EOF\n$(case $y in a) gh pr merge 7 --squash;; esac)\nEOF`,
      "x=`gh pr merge 7 --squash`",
      "echo `gh pr merge 7 --squash`",
      `case x in *) gh pr merge 7 --squash ;; esac`,
    ]);
    asks(`if true; then\n  git push origin v9.9.9\nfi`);
    deny(`for f in a; do\n\tpnpm exec vitest run "$f"\ndone`);
  });

  it("finding 8: a `git -C` quoted in a commit message moves nothing", () => {
    const command = `cd ../ir-5 && git commit -m "docs(specs): x (#5)\n\nRepro: git -C ../master log -1"`;
    expect(gitCwd(command, MASTER, GIT_COMMIT)).toBe(tree("ir-5"));
    expect(gitCwd(`cd "${tree("ir 5")}" && git -C "../ir 6" status`, MASTER, cmd(/git\s+-C\s+\S+\s+status/))).toBe(
      tree("ir 6"),
    );
    expect(
      deny(
        command,
        ctx({
          branch: (d) => (d === tree("ir-5") ? "fix/5-x" : "master"),
          staged: () => ["docs/superpowers/specs/2026-01-01-issue-5-x.md"],
        }),
      ),
    ).toMatch(/never on a feature branch/);
  });

  it("finding 9: ANSI-C quotes, partly quoted or unusual delimiters and `EOF)` do not blank what follows", () => {
    merges([
      "echo $'it\\'s' && gh pr merge 7 --squash",
      `x=$(cat <<'EOF'\nbody\nEOF)\ngh pr merge 7 --squash`,
      `cat <<E'OF'\nbody\nEOF\ngh pr merge 7 --squash`,
      `cat <<"E"OF\nbody\nEOF\ngh pr merge 7 --squash`,
      `cat <<@END\nbody\n@END\ngh pr merge 7 --squash`,
      `cat <<END+\nbody\nEND+\ngh pr merge 7 --squash`,
    ]);
    passes(`cat <<E'OF'\ngh pr merge 7 --squash --admin\nEOF`);
    passes(`cat <<@END\npnpm exec vitest run\n@END`);
  });

  it("finding 10: a comment starts where bash starts one, and nowhere else", () => {
    merges([
      `ls;# don't\ngh pr merge 7 --squash`,
      "echo ${x:- #y} && gh pr merge 7 --squash",
      "echo ${x/ #/} && gh pr merge 7 --squash",
      "echo `echo a # c` && gh pr merge 7 --squash",
    ]);
    asks(`true;# don't forget\ngit push origin v9.9.9`);
    passes(`ls # gh pr merge 7 --squash`);
  });

  it("finding 11: the rules that read their arguments judge the real command, not a mention ahead of it", () => {
    for (const command of [
      `echo "step; git worktree remove ../ir-5" && git worktree remove ../ir-1013`,
      `git commit -q -F - <<'EOF'\nchore: x\n\ngit worktree remove ../ir-999 later\nEOF\ngit worktree remove ../ir-1013`,
      `echo "note; git -C .. worktree remove ir-1013 " && git worktree remove ../ir-1013`,
    ])
      expect(deny(command, linked), command).toMatch(/plugin link/);
    expect(deny(`echo "next; git worktree add ../ir-5 -b x" && git worktree add .worktrees/ir-6 -b y`)).toMatch(
      /siblings/,
    );
    expect(deny(`echo "x; pnpm --filter @iracedeck/logger build" && pnpm --filter @iracedeck/nope build`)).toMatch(
      /No workspace package/,
    );
    expect(deny(`echo "a | gh run list --commit ${"a".repeat(40)}" && gh run list --commit 37de46c02`)).toMatch(
      /FULL 40-char sha/,
    );
    for (const command of [
      `git commit -q -F - <<'EOF'\ndocs: x\n\npnpm --filter @iracedeck/nope build\nEOF`,
      `git commit -q -F - <<'EOF'\ndocs: x\n\ngh run list --commit abc123\nEOF`,
      `git commit -q -F - <<'EOF'\ndocs: x\n\ngit worktree add ../scratch\nEOF`,
      `git commit -q -F - <<'EOF'\ndocs: x\n\ngit worktree remove ../ir-1013\nEOF`,
    ])
      passes(command, linked);
    // The --fix rule stays unanchored on purpose: it fires on any occurrence.
    deny(`grep -rn "code-review.*--fix" .claude/rules`);
  });

  it("finding 13: the canonical `-m \"$(cat <<'EOF' …)\"` body is a mention", () => {
    for (const command of [
      `git commit -m "$(cat <<'EOF'\nfix: x (#1)\n\nso gh pr merge 7 … & gh pr\nmerge 8 --admin read as one\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\nfix: x (#1)\n\npnpm exec vitest run was dropped\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\nfix: x (#1)\n\nrun it as a | jq pipeline\nEOF\n)"`,
      `gh issue create --title x --body "$(cat <<'EOF'\ngit worktree add ../scratch -b fix/77-x\nEOF\n)"`,
    ])
      passes(command);
    expect(
      worktreeAddTarget(
        `gh issue create --title x --body "$(cat <<'EOF'\ngit worktree add ../ir-77 -b fix/77-x\nEOF\n)"`,
      ),
    ).toBeNull();
  });

  it("finding 14: a suppressor counts only in live text that covers the command", () => {
    asks(`git push --dry-run origin master && git push origin v3.4.0`);
    asks(`git push origin v1.2.3 # not a --dry-run`);
    asks(`git push origin "v1.2.3"`);
    passes(`git push --dry-run origin v3.4.0`);
    deny(`pnpm build 2>&1 | tail -5 && echo "remember pipefail"`);
    deny(`pnpm build | tail -5; set -o pipefail`);
    passes(`set -euo pipefail\npnpm test 2>&1 | tee log`);
    passes(`pnpm build || echo failed`);
    deny(`git show origin/master:.claude/x.md # MSYS_NO_PATHCONV later`);
    deny(`git show "origin/master:.claude/rules/hooks.md"`);
    deny(`git show HEAD:x && git show origin/master:.claude/x.md`);
    passes(`export MSYS_NO_PATHCONV=1; git show origin/master:.claude/x.md`);
  });

  it("judges a long run of `2>&1` in linear time — the old pipefail regex backtracked exponentially", () => {
    // The short run first: the old regex takes over a second on 26 of them and
    // fails here, where 4000 would hang the suite.
    for (const n of [26, 4000]) {
      const started = Date.now();
      passes(`pnpm build ${"2>&1 ".repeat(n)}x`);
      expect(Date.now() - started, `${n} × 2>&1`).toBeLessThan(200);
    }
  });

  it("finding 15: the post-hook's worktree target is the add the rule judged", () => {
    expect(
      worktreeAddTarget(`# superseded: git worktree add ../ir-1400\ngit worktree add ../ir-1321 -b fix/1321-x`),
    ).toBe("../ir-1321");
    expect(
      worktreeAddTarget(`echo "was: git worktree add ../ir-99" && git worktree add ../ir-1321 -b fix/1321-x`),
    ).toBe("../ir-1321");
    expect(worktreeAddTarget("git worktree add --lock --reason why ../ir-5")).toBe("../ir-5");
    expect(worktreeAddTarget("git status")).toBeNull();
  });

  it("reads the issue off a worktree path's last segment, the tree the add creates (#1358)", () => {
    expect(issueFromWorktreePath("C:\\x\\ir-1100")).toBe(1100);
    expect(issueFromWorktreePath("../ir-42")).toBe(42);
    expect(issueFromWorktreePath("ir-7")).toBe(7);
    expect(issueFromWorktreePath("C:\\x\\master")).toBeUndefined();
    // An `ir-` segment higher up is where the add ran, not what it made.
    expect(issueFromWorktreePath("C:\\x\\ir-1325\\scripts\\ir-1321")).toBe(1321);
    expect(issueFromWorktreePath("/x/ir-1325/scripts/ir-1321")).toBe(1321);
    expect(issueFromWorktreePath("C:\\x\\ir-1325\\scripts")).toBeUndefined();
    expect(issueFromWorktreePath("C:\\x\\ir-1325-old")).toBeUndefined();
    expect(issueFromWorktreePath("C:\\x\\ir-0")).toBeUndefined();
    expect(issueFromWorktreePath("C:\\x\\ir-0042")).toBeUndefined();
  });

  it("denies a worktree nested in another ir-* tree, which is outside master (#1358)", () => {
    // mainRoot is the checkout the git-common-dir belongs to — master — so
    // "not inside master" alone let these through.
    const sub = ctx({ cwd: tree("ir-1325", "scripts") });
    expect(deny(`git worktree add ir-5 -b fix/5-x`, sub)).toMatch(/siblings/);
    expect(deny(`git worktree add ../ir-5 -b fix/5-x`, sub)).toMatch(/siblings/);
    // With the real `isInside`, a parent differing only in case is a sibling on
    // Windows and a different directory everywhere else.
    const other = path.join(path.dirname(REPO), path.basename(REPO).toUpperCase(), "ir-5");
    const real = ctx({ isInside });
    if (process.platform === "win32") passes(`git worktree add "${other}" -b fix/5-x`, real);
    else expect(deny(`git worktree add "${other}" -b fix/5-x`, real)).toMatch(/siblings/);
    passes(`git worktree add ../../ir-5 -b fix/5-x`, sub);
  });

  it("refuses a name that is no issue number, and asks the spec gate the same number (#1358)", () => {
    expect(deny("git worktree add ../ir-0 -b x")).toMatch(/ir-<issue>/);
    expect(deny("git worktree add ../ir-0042 -b x")).toMatch(/ir-<issue>/);
    expect(asks("git worktree add ../ir-42 -b x", ctx({ specFiles: () => [] }))).toMatch(/No spec on master for #42 /);
  });

  it("the post-hook's merge trigger finds a merge behind any wrapper, and only a readable PR", () => {
    expect(firstMerge("timeout 120 gh pr merge 7 --squash")).toMatchObject({ ref: "7", readable: true });
    expect(firstMerge("echo 7 | xargs -I{} gh pr merge {} --squash")).toMatchObject({ ref: "{}" });
    expect(firstMerge(`gh pr merge "7" --squash`)).toMatchObject({ readable: false });
    expect(firstMerge(`grep -rn "gh pr merge" scripts`)).toBeUndefined();
  });
});
