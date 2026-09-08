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
    branchFiles: () => [],
    staged: () => [],
    modified: () => [],
    mainRoot: () => MASTER,
    originFresh: () => ({ fresh: true, local: "aaaaaaaaa", remote: "aaaaaaaaa" }),
    linkTargets: () => [],
    packages: () => ({ "@iracedeck/logger": { dir: "x", scripts: ["build", "typecheck"] } }),
    isInside: (c, p) => c.toLowerCase() === p.toLowerCase() || c.toLowerCase().startsWith(p.toLowerCase() + path.sep),
    prView: () => undefined,
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

describe("code review", () => {
  it("refuses --fix", () => expect(deny("claude /code-review high --fix")).toMatch(/--fix/));
});

describe("git push", () => {
  it("lets a spec-only push to master through", () =>
    passes("git push origin master", ctx({ branchFiles: () => ["docs/superpowers/specs/2026-09-08-issue-1-x.md"] })));
  it("asks for anything else on master", () =>
    expect(asks("git push", ctx({ branchFiles: () => ["docs/superpowers/specs/a.md", "src/x.ts"] }))).toMatch(
      /1 non-spec/,
    ));
  it("asks from a feature branch even when spec-only", () =>
    asks("git push", ctx({ branch: () => "ir-1", branchFiles: () => ["docs/superpowers/specs/a.md"] })));
  it("asks when the diff is unavailable", () =>
    expect(asks("git push", ctx({ branchFiles: () => undefined }))).toMatch(/diff unavailable/));
  it("asks on a tag push", () => expect(asks("git push origin v3.2.0")).toMatch(/release/));
  it("ignores --dry-run", () => passes("git push --dry-run"));
});

describe("gh pr create", () => {
  it("asks with a well-formed title", () => asks(`gh pr create --title "feat(x): thing (#12)" --body-file -`));
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
      { author: { login: "coderabbitai" }, state: "COMMENTED", commit: { oid: head } },
    ];
    passes("gh pr merge 7 --squash", ctx({ prView: () => pr }));
  });
  it("ignores the maintainer's own thread replies when looking for the reviewer", () => {
    const pr = green();
    pr.reviews = [{ author: { login: "niklam" }, state: "COMMENTED", commit: { oid: head } }];
    expect(deny("gh pr merge 7 --squash", ctx({ prView: () => pr }))).toMatch(/no CodeRabbit review/);
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
  it("reads -a as staged plus modified", () =>
    deny("git commit -am x", ctx({ branch: () => "ir-1", modified: () => ["docs/superpowers/specs/a.md"] })));
  it("reads an explicit pathspec after --", () => {
    deny("git commit --only -m x -- docs/superpowers/specs/a.md", ctx({ branch: () => "ir-1" }));
    passes(
      "git commit --only -m x -- src/x.ts",
      ctx({ branch: () => "ir-1", staged: () => ["docs/superpowers/specs/a.md"] }),
    );
  });
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
