/**
 * PreToolUse rules for the Bash tool — the repo's mechanical "never do X"
 * rules, turned from prose into checks that run before the command does.
 *
 * Each rule is `(command, ctx) → verdict`: a string DENIES with that reason,
 * `{ ask: reason }` forces the permission prompt, anything falsy passes. The
 * context is lazy so a rule that needs `git` or `gh` only pays for it when
 * its regex matched; tests hand in a fake context.
 *
 * The rules are heuristics over a shell command string. They aim to catch the
 * shapes that have actually gone wrong here (each names its origin), not to
 * parse bash.
 */
import path from "node:path";

import { MAIN_BRANCH, SPEC_DIR } from "./lib.mjs";

const TITLE_RE = /^(feat|fix|improve|perf|refactor|docs|ci|chore|test|build|style|revert)(\([^)]+\))?!?: .+ \(#\d+\)$/;

/** The pieces of a chained shell command: split at `&&`, `||`, `;`, `|` and newlines. */
export function segments(command) {
  return command
    .split(/\n|&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const QUOTED_ARG = String.raw`("([^"]+)"|'([^']+)'|(\S+))`;
const CD_RE = new RegExp(String.raw`^(?:\w+=\S*\s+)*cd\s+${QUOTED_ARG}\s*$`);
const GIT_C_RE = new RegExp(String.raw`\bgit\s+-C\s+${QUOTED_ARG}`);
const argOf = (m) => m?.[2] ?? m?.[3] ?? m?.[4];

/**
 * The working directory of the git command a rule matched: the session cwd,
 * moved by every `cd <dir>` chained AHEAD of that command, then by the
 * command's own `git -C <dir>`. Pass the rule's own `cmd(...)` regex as `re`
 * so the `-C` is read off the segment it matched and never off a later
 * command in the chain — `git worktree add ../ir-5 … && git -C ../ir-5 log`
 * used to resolve the new tree against itself, fail the repo-root lookup
 * there, and deny the add as "inside the repo". The `cd` walk is what lets a
 * session whose cwd is `master` be judged on the tree it pushes from:
 * `cd ../ir-1143 && git push` used to ask with "branch master".
 */
export function gitCwd(command, cwd, re) {
  const segs = segments(command);
  const at = re ? segs.findIndex((s) => re.test(s)) : -1;
  const scope = at >= 0 ? segs[at] : command;
  let base = cwd;
  for (const s of segs.slice(0, at >= 0 ? at : segs.length)) {
    const dir = argOf(s.match(CD_RE));
    if (dir && dir !== "-") base = path.resolve(base, dir);
  }
  const dir = argOf(scope.match(GIT_C_RE));
  return dir ? path.resolve(base, dir) : base;
}

/** Splits a command into rough words, respecting simple quotes. */
export function words(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const has = (command, re) => re.test(command);

/**
 * Anchors a command regex to COMMAND POSITION: the start of the string or of
 * a line, or right after `|`, `;`, `&&`, `(` or `$(`, with any leading
 * `VAR=value` assignments. Without this, a grep, an echo or a docs edit that
 * merely MENTIONS a trapped shape (`grep 'pnpm exec vitest'`) would be denied.
 */
export function cmd(re) {
  const flags = new Set([...re.flags, "m"]);
  return new RegExp(String.raw`(?:^|[|;&(]\s*|\$\(\s*)(?:\w+=\S*\s+)*(?:${re.source})`, [...flags].join(""));
}

// ---------------------------------------------------------------------------

/** The git shapes whose rules read a `-C`; exported so the post-hook scopes the same way. */
export const GIT_PUSH = cmd(/git\s+(-C\s+\S+\s+)?push\b/);
export const GIT_COMMIT = cmd(/git\s+(-C\s+\S+\s+)?commit\b/);
export const GIT_WORKTREE_ADD = cmd(/git\s+(?:-C\s+\S+\s+)?worktree\s+add\b(.*)$/);
export const GIT_WORKTREE_REMOVE = cmd(/git\s+(?:-c\s+\S+\s+)?(?:-C\s+\S+\s+)?worktree\s+remove\b(.*)$/);

export const rules = [
  {
    name: "code-review is a Skill, never --fix",
    test: (c) =>
      has(c, /code-review[^\n|;&]*--fix\b/) &&
      "Never run /code-review with --fix: findings are candidates, not verdicts, and one bare run wrote eight files into master. Report only; apply verified findings by hand (.claude/rules/code-review.md).",
  },
  {
    name: "git push: spec-only goes through, everything else asks",
    test: (c, ctx) => {
      if (!has(c, GIT_PUSH) || has(c, /--dry-run/)) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_PUSH);
      if (has(c, /\bpush\s[^|&;]*\b(--tags|v\d+\.\d+)/))
        return { ask: "Pushing a tag cuts a release. The maintainer confirms." };
      const branch = ctx.branch(dir);
      // The hook runs BEFORE the command, so a commit chained ahead of the push
      // (`git commit … -- <spec> && git push`) is not in origin/master...HEAD yet —
      // which asked "0 non-spec file(s)" on every spec push. Count what that
      // commit would add as if it had landed.
      const chained = has(c, GIT_COMMIT) ? committedFiles(c, ctx, dir) : [];
      const files = ctx.branchFiles(dir);
      const all = files && [...files, ...chained];
      if (branch === MAIN_BRANCH && all && all.length > 0 && all.every((f) => f.startsWith(SPEC_DIR))) return null; // spec-only pushes to master are pre-approved
      const outside = (all ?? []).filter((f) => !f.startsWith(SPEC_DIR)).length;
      return {
        ask: `Push is not a spec-only push to ${MAIN_BRANCH} (${all ? `${outside} non-spec file(s)` : "diff unavailable"}, branch ${branch ?? "?"}). The maintainer confirms pushes, and only after their manual test.`,
      };
    },
  },
  {
    name: "gh --body @- does not read stdin",
    test: (c) =>
      has(c, cmd(/gh\b[^|&;]*--body\s+@-/)) &&
      "`--body @-` does not read stdin with gh; use `--body-file -` (and re-read the posted body).",
  },
  {
    name: "gh pr create: asks, and the title must be a complete conventional subject with the issue number",
    test: (c) => {
      if (!has(c, cmd(/gh\s+pr\s+create\b/))) return null;
      const title = c.match(/(?:--title|-t)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
      const t = title?.[1] ?? title?.[2] ?? title?.[3];
      if (t !== undefined && !TITLE_RE.test(t))
        return `PR title "${t}" must be \`<type>(<scope>): <description> (#<issue>)\` — it becomes the squash commit and drives the release notes (.claude/rules/build-and-commit.md).`;
      return { ask: "Opening a PR is gated on the maintainer's manual test. They confirm." };
    },
  },
  {
    name: "gh pr merge: approval and checks are verified at the current head",
    test: (c, ctx) => {
      if (!has(c, cmd(/gh\s+pr\s+merge\b/))) return null;
      const after = words(c.slice(c.indexOf("pr merge") + 8));
      const ref = after.find((w) => !w.startsWith("-"));
      const pr = ctx.prView(ref, ctx.cwd);
      if (!pr)
        return `Could not read the PR${ref ? ` "${ref}"` : " for this branch"} with gh; refusing to merge blind.`;
      if (pr.state !== "OPEN") return `PR #${pr.number} is ${pr.state}, not OPEN.`;
      const problems = [];
      const isBackMerge = /^release\//.test(pr.headRefName ?? "");
      const squash = has(c, /--squash\b/);
      const merge = has(c, /--merge\b/) || has(c, /--rebase\b/);
      if (isBackMerge && squash)
        problems.push("a release-branch back-merge is a regular merge (--merge), never a squash");
      if (!isBackMerge && !squash) problems.push("feature/fix PRs are squash-merged (--squash)");
      if (!isBackMerge && merge) problems.push("feature/fix PRs are squash-merged, not --merge/--rebase");
      const admin = has(c, /--admin\b/);
      if (!admin) {
        if (pr.reviewDecision !== "APPROVED")
          problems.push(`reviewDecision is ${pr.reviewDecision ?? "unset"}, not APPROVED`);
        const bot = (pr.reviews ?? []).filter((r) => /coderabbit/i.test(r.author?.login ?? ""));
        const atHead = bot.filter((r) => r.commit?.oid === pr.headRefOid);
        const everApproved = bot.some((r) => r.state === "APPROVED");
        if (atHead.length === 0)
          problems.push(
            `no CodeRabbit review at head ${pr.headRefOid.slice(0, 9)} — the approval shown belongs to a previous head`,
          );
        else if (!everApproved) problems.push("CodeRabbit has never approved this PR");
      }
      const rollup = pr.statusCheckRollup ?? [];
      const pending = rollup.filter((x) => classifyCheck(x) === "pending").map(checkName);
      const bad = rollup.filter((x) => classifyCheck(x) !== "pending" && classifyCheck(x) !== "ok").map(checkName);
      if (rollup.length === 0) problems.push("no checks reported at all");
      if (pending.length) problems.push(`checks still pending: ${pending.join(", ")}`);
      if (bad.length) problems.push(`checks not green: ${bad.join(", ")}`);
      if (["BLOCKED", "DIRTY"].includes(pr.mergeStateStatus))
        problems.push(`mergeStateStatus is ${pr.mergeStateStatus}`);
      if (problems.length === 0) return null;
      return `Not merging PR #${pr.number} at ${pr.headRefOid.slice(0, 9)}: ${problems.join("; ")}.`;
    },
  },
  {
    name: "git commit: specs go to master only; a dirty lockfile rides with its package.json",
    test: (c, ctx) => {
      if (!has(c, GIT_COMMIT)) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_COMMIT);
      const branch = ctx.branch(dir);
      const committed = committedFiles(c, ctx, dir);
      if (branch && branch !== MAIN_BRANCH) {
        const specs = committed.filter((f) => f.startsWith(SPEC_DIR));
        if (specs.length)
          return `A spec commits to ${MAIN_BRANCH} as its own docs(specs) commit, never on a feature branch (${specs.join(", ")} on ${branch}). See .claude/rules/specs-and-plans.md.`;
      }
      if (
        committed.some((f) => /(^|\/)package\.json$/.test(f)) &&
        !committed.includes("pnpm-lock.yaml") &&
        ctx.modified(dir).includes("pnpm-lock.yaml")
      )
        return "pnpm-lock.yaml is modified but not in this commit while a package.json is. Stage the lockfile too — local builds pass via hoisting, CI's --frozen-lockfile fails every job at once.";
      return null;
    },
  },
  {
    name: "git worktree add: a sibling of the repo, from a fresh origin/master",
    test: (c, ctx) => {
      const m = c.match(GIT_WORKTREE_ADD);
      if (!m) return null;
      const args = words(m[1]);
      let target;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-b" || a === "-B" || a === "--reason") i++;
        else if (!a.startsWith("-")) {
          target = a;
          break;
        }
      }
      if (!target) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_WORKTREE_ADD);
      const resolved = path.resolve(dir, target);
      if (ctx.isInside(resolved, ctx.mainRoot(dir)))
        return `Worktrees are siblings of the repo (${path.join(path.dirname(ctx.mainRoot(dir)), "ir-<issue>")}), never inside it: ${resolved}.`;
      if (!/(^|[\\/])ir-\d+$/.test(resolved))
        return `Issue worktrees are named ../ir-<issue> (got ${path.basename(resolved)}).`;
      const fresh = ctx.originFresh(dir);
      if (fresh && !fresh.fresh)
        return `origin/${MAIN_BRANCH} is stale (local ${fresh.local}, remote ${fresh.remote}); run \`git fetch origin\` first or the branch starts behind and surfaces as a PR conflict.`;
      return null;
    },
  },
  {
    name: "git worktree remove: not while a deck host is linked into it",
    test: (c, ctx) => {
      const m = c.match(GIT_WORKTREE_REMOVE);
      if (!m) return null;
      const target = words(m[1]).find((w) => !w.startsWith("-"));
      if (!target) return null;
      const resolved = path.resolve(gitCwd(c, ctx.cwd, GIT_WORKTREE_REMOVE), target);
      const held = ctx.linkTargets().filter((l) => l.target && ctx.isInside(l.target, resolved));
      if (held.length)
        return `${held.map((l) => l.host).join(" and ")} plugin link points into ${resolved}. Relink to master first — or, if another session may be testing there, leave it and say so.`;
      return null;
    },
  },
  {
    name: "gh issue create: no milestone or assignee at filing",
    test: (c) =>
      has(c, cmd(/gh\s+issue\s+create\b/)) &&
      has(c, /\s(--milestone|--assignee|-a)\b/) &&
      "An issue gets its milestone and assignee when implementation STARTS, never at filing (.claude/rules/issue-workflow.md).",
  },
  {
    name: "never rewrite the board's Status options",
    test: (c) =>
      has(c, /updateProjectV2Field/) &&
      "`updateProjectV2Field` replaces the option list and regenerates its ids, which clears every card's lane. Add a lane in the UI instead.",
  },
  {
    name: "pnpm build --force does nothing",
    test: (c) =>
      has(c, cmd(/pnpm\s+(run\s+)?build\s+--force\b/)) &&
      "`pnpm build --force` forwards no argv (scripts/build.mjs); use `pnpm build:force`.",
  },
  {
    name: "a piped pnpm build/test needs pipefail",
    test: (c) =>
      has(c, cmd(/pnpm\s+(run\s+)?(build|test|typecheck|lint|format)\b(?:[^|&;\n]|\d?>&\d)*\|/)) &&
      !has(c, /pipefail/) &&
      "Piping `pnpm build/test/...` hides its exit code (you get tail's). Prefix `set -o pipefail;` or check the log before claiming green.",
  },
  {
    name: "run vitest through the root script",
    test: (c) =>
      (has(c, cmd(/(pnpm\s+exec\s+|npx\s+)vitest\b/)) || has(c, cmd(/pnpm\s+--filter\s+\S+\s+(run\s+)?test\b/))) &&
      "Run tests as `pnpm test <path>`: `pnpm exec vitest` drops the native config loader and the per-package test scripts match nothing (.claude/rules/testing.md).",
  },
  {
    name: "pnpm --filter on a script the package does not have",
    test: (c, ctx) => {
      const m = c.match(cmd(/pnpm\s+--filter\s+(@iracedeck\/[\w-]+)\s+(?:run\s+)?([\w:-]+)/));
      if (!m) return null;
      if (/^(add|remove|install|exec|dlx|update|why|list|ls)$/.test(m[2])) return null;
      const pkg = ctx.packages()[m[1]];
      if (!pkg) return `No workspace package named ${m[1]}.`;
      if (!pkg.scripts.includes(m[2]))
        return `${m[1]} has no "${m[2]}" script — pnpm --filter exits 0 and does nothing (scripts: ${pkg.scripts.join(", ") || "none"}).`;
      return null;
    },
  },
  {
    name: "gh run list --commit needs the full sha",
    test: (c) => {
      const m = c.match(cmd(/gh\s+run\s+list\b[^|&;]*--commit[= ]([0-9a-f]+)\b/));
      return (
        m &&
        m[1].length < 40 &&
        `\`gh run list --commit\` needs the FULL 40-char sha; a short one returns zero rows silently.`
      );
    },
  },
  {
    name: "jq is not installed",
    test: (c) =>
      has(c, cmd(/jq(\s|$)/)) &&
      "jq is not installed here and a jq pipeline fails silently (empty fields, exit 0). Parse `gh --json` with node or python (UTF-8).",
  },
  {
    name: "heredocs collapse doubled backslashes",
    test: (c) =>
      has(c, /<<-?\s*['"]?\w+/) &&
      has(c, /[A-Za-z]:\\\\/) &&
      "A doubled backslash collapses to one inside a heredoc, corrupting that Windows path. Write the file with the Write tool instead.",
  },
  {
    name: "IRACEDECK_MOCK=0 still mocks",
    test: (c) =>
      has(c, cmd(/IRACEDECK_MOCK=0\b/)) &&
      "`IRACEDECK_MOCK=0` still forces the mock (any non-empty value does). Use `IRACEDECK_REAL_NATIVE=1`.",
  },
  {
    name: "git show <ref/with/slash>:<dot-path> is mangled by MSYS",
    test: (c) =>
      has(c, cmd(/git\s+show\s+\S*\/\S*:\./)) &&
      !has(c, /MSYS_NO_PATHCONV/) &&
      "Git Bash mangles `git show <ref-with-slash>:<.dot-path>`. Prefix `MSYS_NO_PATHCONV=1`, or use `git -C <tree> show HEAD:…`.",
  },
  {
    name: "git diff master..HEAD is the wrong question",
    test: (c) =>
      has(c, cmd(/git\s+(-C\s+\S+\s+)?diff\b[^|&;]*\s(origin\/)?master\.\.[^.\s]/)) &&
      "`git diff master..X` diffs the two tips and returns master's own commits inverted. Use `origin/master...HEAD` (three dots, from the merge base).",
  },
];

// ---------------------------------------------------------------------------

/** The words of one command in a chain: everything up to the next `&&`, `||`, `;` or `|`. */
function chainWords(text) {
  const out = [];
  for (const w of words(text)) {
    if (/^(&&|\|\||;|\|)$/.test(w)) break;
    const bare = w.replace(/;$/, "");
    if (bare) out.push(bare);
    if (bare !== w) break;
  }
  return out;
}

const asPath = (p) => p.replace(/\\/g, "/");

/**
 * What `git commit` would include: an explicit `--only` pathspec, else what is
 * staged plus what a `git add <paths>` EARLIER IN THE SAME COMMAND stages — the
 * hook runs before any of the chain does, so those paths are not staged yet
 * when it looks (`-a` folds in the modified files too). A `git add .`/`-A`
 * names nothing, and an untracked file is invisible to the diff, so that
 * shape stays unknown and the rules reading this fail towards asking.
 */
function committedFiles(command, ctx, dir) {
  // Tokenised, not a line regex: a quoted commit message spans lines, and the
  // `--` that follows it sits on the message's last line.
  const afterCommit = chainWords(command.slice(command.search(/\bcommit\b/)));
  const dash = afterCommit.indexOf("--");
  if (dash >= 0) return afterCommit.slice(dash + 1).map(asPath);
  const added = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?add\s+(.+)$/gm)].flatMap((m) =>
    chainWords(m[1])
      .filter((w) => !w.startsWith("-") && w !== ".")
      .map(asPath),
  );
  const staged = [...ctx.staged(dir), ...added];
  if (has(command, /\bcommit\b[^|&;]*\s(-a|--all|-am|-a[a-zA-Z]+)\b/))
    return [...new Set([...staged, ...ctx.modified(dir)])];
  return [...new Set(staged)];
}

/**
 * Classifies one `statusCheckRollup` entry. The array MIXES two node types:
 * GitHub Actions jobs are `CheckRun` (status/conclusion) while CodeRabbit is a
 * `StatusContext` (state) whose absent fields are omitted, not null — so the
 * test is on `__typename`, and an unknown type fails closed.
 */
export function classifyCheck(c) {
  switch (c.__typename) {
    case "CheckRun":
      return c.status !== "COMPLETED"
        ? "pending"
        : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)
          ? "ok"
          : "bad";
    case "StatusContext":
      return ["PENDING", "EXPECTED"].includes(c.state) ? "pending" : c.state === "SUCCESS" ? "ok" : "bad";
    default:
      return "unknown";
  }
}

const checkName = (c) => c.name ?? c.context ?? c.__typename ?? "?";

/** Runs every rule; the first verdict wins. */
export function checkBash(command, ctx) {
  for (const rule of rules) {
    const v = rule.test(command, ctx);
    if (v) return v;
  }
  return null;
}
