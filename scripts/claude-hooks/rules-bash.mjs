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

/**
 * What a spec must carry beyond its header block (#1193). Measured over all
 * 106 specs: since the #621 policy, "Out of scope" fell from 50 % to 17 % and
 * a Testing/Verification section from 88 % to 70 % — because no rule had ever
 * named either. The only surviving prescription was a pre-#621 template in
 * `.claude/agents/feature-planner.md` that has produced zero specs.
 *
 * The spellings are the ones ALREADY in the corpus, deliberately: the house
 * style has never been uniform, and forcing one would rewrite 45 compliant
 * specs' habits for nothing. Matched against headings at any level plus the
 * bold pseudo-headings the specs use, never against body prose — a passing
 * mention of a test is not a test plan.
 */
const SPEC_SECTIONS = [
  {
    what: "an Out of scope section",
    re: /out of scope|non-goals?|not in scope|deliberately does not|does not (?:do|cover|include|ship)/i,
  },
  { what: "a Testing or Verification section", re: /\b(tests?|testing|verification|verify)\b/i },
];

/** The `> **Issue:** … **Supersedes:** … **Superseded by:** …` block. */
const SPEC_HEADER = /^>\s*\*\*Issue:\*\*.*\*\*Supersedes:\*\*.*\*\*Superseded by:\*\*/m;

/** A fenced code block: its opening run of backticks or tildes, up to the same run closing it. */
const FENCED_BLOCK = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

/**
 * Headings at any level, plus the lines the specs make headings of by bolding
 * the WHOLE line (`**Manual verification**`, optionally with a trailing colon).
 * Code fences are dropped first, since a `# verify the build` comment in a
 * bash block is not a heading. A paragraph that merely OPENS in bold is body
 * prose, and does not count: the one post-policy spec that passed on such a
 * line (`**Tests assert structure, not pixels.**`, inside #1145's Decisions)
 * has no test section, and is already in HEAD, so it is never re-checked.
 */
function specHeadings(text) {
  const body = text.replace(FENCED_BLOCK, "");
  return [
    ...[...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]),
    ...[...body.matchAll(/^\*\*([^*\n]+?)\*\*[:.]?\s*$/gm)].map((m) => m[1]),
  ].map((h) => h.trim());
}

/** What a committed spec is missing, in the order a reader would fix it. */
export function missingSpecParts(text) {
  const missing = [];
  if (!SPEC_HEADER.test(text)) missing.push("the header block (Issue · Supersedes · Superseded by)");
  const heads = specHeadings(text);
  for (const s of SPEC_SECTIONS) if (!heads.some((h) => s.re.test(h))) missing.push(s.what);
  return missing;
}

/** A spec is named for its issue; the date and the topic around it are free. */
const specExistsFor = (files, issue) => files.some((f) => new RegExp(`-issue-${issue}-`).test(f));

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
    // Only a tag push asks. The plain push and `gh pr create` asks were dropped
    // on 2026-09-08: the hook sees the command, never the conversation, so it
    // prompted just as loudly when the maintainer had asked for the push. The
    // manual-test gate on pushes and PRs is a prose rule (issue-workflow.md).
    name: "git push: a tag cuts a release",
    test: (c) =>
      has(c, GIT_PUSH) &&
      !has(c, /--dry-run/) &&
      has(c, /\bpush(?:\s[^|&;]*)?\s(--tags\b|v\d+\.\d+)/) && {
        ask: "Pushing a tag cuts a release. The maintainer confirms.",
      },
  },
  {
    name: "gh --body @- does not read stdin",
    test: (c) =>
      has(c, cmd(/gh\b[^|&;]*--body\s+@-/)) &&
      "`--body @-` does not read stdin with gh; use `--body-file -` (and re-read the posted body).",
  },
  {
    name: "gh pr create: the title must be a complete conventional subject with the issue number",
    test: (c) => {
      if (!has(c, cmd(/gh\s+pr\s+create\b/))) return null;
      const title = c.match(/(?:--title|-t)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
      const t = title?.[1] ?? title?.[2] ?? title?.[3];
      if (t !== undefined && !TITLE_RE.test(t))
        return `PR title "${t}" must be \`<type>(<scope>): <description> (#<issue>)\` — it becomes the squash commit and drives the release notes (.claude/rules/build-and-commit.md).`;
      return null;
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
      const { files: committed, fromIndex } = commitSelection(c, ctx, dir);
      if (branch && branch !== MAIN_BRANCH) {
        const specs = committed.filter((f) => f.startsWith(SPEC_DIR));
        if (specs.length)
          return `A spec commits to ${MAIN_BRANCH} as its own docs(specs) commit, never on a feature branch (${specs.join(", ")} on ${branch}). See .claude/rules/specs-and-plans.md.`;
      }
      // The commit is where a spec's bytes are knowable and its author is still
      // holding it. Two things pass on purpose (#1193): a spec ALREADY in HEAD,
      // because the requirement is forward-only like #621's naming convention
      // and `specs-and-plans.md` protects editing a spec freely before it ships
      // — 30 of the 64 post-policy specs were amended, and none of those edits
      // is the moment to demand a section the spec was never asked for; and
      // text the hook cannot read, because a spec is never blocked over bytes
      // the hook failed to find. The bytes are read from where the commit will
      // take them — the index or the working copy, per `commitSelection`.
      for (const f of committed.filter((x) => x.startsWith(SPEC_DIR))) {
        if (ctx.tracked?.(dir, f)) continue;
        const text = ctx.specText?.(dir, f, fromIndex.has(f) ? "index" : "worktree");
        if (text === undefined) continue;
        const missing = missingSpecParts(text);
        if (missing.length)
          return `${f} is missing ${missing.join(" and ")}. A spec carries the header block, an Out of scope section and a Testing/Verification section. See .claude/rules/specs-and-plans.md.`;
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
      // The one moment where the issue number is known and implementation has
      // not started (#1193): 47 of the 56 enhancement issues filed since the
      // #621 policy have a spec, and nothing was checking the other nine.
      // An ASK, never a deny — the exemptions (a bug, a docs fix, a dependency
      // bump, a hygiene sweep) are judgement no regex makes. Labels that are
      // readable and carry no `enhancement` ARE those exemptions, so the ask
      // stays silent for them; labels that cannot be read (no `gh`, offline)
      // ask, and the prompt names the exemption so it costs one keypress.
      const issue = resolved.match(/ir-(\d+)$/)?.[1];
      if (issue && !specExistsFor(ctx.specFiles?.(dir) ?? [], issue)) {
        const labels = (ctx.issueLabels?.(issue, dir)?.labels ?? []).map((l) => l?.name ?? l);
        if (!labels.length || labels.includes("enhancement"))
          return {
            ask: `No spec on ${MAIN_BRANCH} for #${issue} (${SPEC_DIR}*-issue-${issue}-*.md). A feature or enhancement gets its spec BEFORE its worktree; a bug, docs fix, dependency bump or hygiene sweep is exempt — confirm to proceed. See .claude/rules/specs-and-plans.md.`,
          };
      }
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
        return `${held.map((l) => l.host).join(" and ")} plugin link points into ${resolved}. Do not relink it yourself, not even to master — leave the link and the worktree as they are and tell Niklas.`;
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
 * What `git commit` would include, and where each file's bytes come from.
 *
 * `files`: an explicit `--only` pathspec, else what is staged plus what a
 * `git add` EARLIER IN THE SAME COMMAND stages — the hook runs before any of
 * the chain does, so those paths are not staged yet when it looks (`-a` folds
 * in the modified files too).
 *
 * `fromIndex`: the files a plain commit takes from the index AS IT STANDS NOW —
 * staged before this command and not re-added by it (#1193 review). Every other
 * file is committed from the working copy: a pathspec commit and `-a` take it
 * directly, and a chained `git add` puts it in the index first. A rule that
 * reads a file's bytes must read them from where they will be committed, or a
 * staged spec is judged on an edit made after it was staged.
 */
function commitSelection(command, ctx, dir) {
  // Tokenised, not a line regex: a quoted commit message spans lines, and the
  // `--` that follows it sits on the message's last line.
  const afterCommit = chainWords(command.slice(command.search(/\bcommit\b/)));
  const dash = afterCommit.indexOf("--");
  if (dash >= 0) return { files: afterCommit.slice(dash + 1).map(asPath), fromIndex: new Set() };
  const added = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?add\s+(.+)$/gm)].flatMap((m) =>
    addedFiles(chainWords(m[1]), ctx, dir),
  );
  const before = ctx.staged(dir);
  if (has(command, /\bcommit\b[^|&;]*\s(-a|--all|-am|-a[a-zA-Z]+)\b/))
    return { files: [...new Set([...before, ...added, ...ctx.modified(dir)])], fromIndex: new Set() };
  const reAdded = new Set(added);
  return { files: [...new Set([...before, ...added])], fromIndex: new Set(before.filter((f) => !reAdded.has(f))) };
}

/**
 * The files one `git add <args>` stages. An operand names a file OR a
 * directory, so each is matched against the files that differ from the index —
 * modified and untracked — as itself or as a prefix (#1193 review: a new spec
 * staged by `git add -A`, `git add .` or `git add docs/superpowers/specs/` used
 * to reach no rule at all). `.`, and `-A`/`--all`/`-u` with no operand, select
 * every candidate; `-u`/`--update` leaves untracked files out. An operand that
 * matches nothing is kept as written — a file already staged, a glob, a path
 * outside this model — which is exactly what the rules saw before.
 */
function addedFiles(args, ctx, dir) {
  const flags = args.filter((w) => w.startsWith("-"));
  const operands = args.filter((w) => !w.startsWith("-")).map(asPath);
  const updateOnly = flags.some((f) => /^(-u|--update)$/.test(f));
  const candidates = [...ctx.modified(dir), ...(updateOnly ? [] : (ctx.untracked?.(dir) ?? []))];
  if (!operands.length) return flags.some((f) => /^(-A|--all|-u|--update)$/.test(f)) ? candidates : [];
  return operands.flatMap((o) => {
    const p = o.replace(/^\.\//, "").replace(/\/+$/, "");
    if (p === "." || p === "") return candidates;
    const hits = candidates.filter((f) => f === p || f.startsWith(`${p}/`));
    return hits.length ? hits : [o];
  });
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

/**
 * Runs the rules. The first DENY wins at once; the first ask is held until
 * every rule has had its turn, so a deny anywhere beats an ask anywhere,
 * whatever order the two rules sit in. One chained command can match both — a
 * spec-less `git worktree add … && <a denied shape>` used to surface only the
 * ask, and confirming it ran the command the deny exists to stop (#1193
 * review; the tag-push ask had the same gap). Order still picks which of two
 * denies, or which of two asks, is the one reported.
 */
export function checkBash(command, ctx) {
  let ask = null;
  for (const rule of rules) {
    const v = rule.test(command, ctx);
    if (!v) continue;
    if (typeof v === "string") return v;
    ask ??= v;
  }
  return ask;
}
