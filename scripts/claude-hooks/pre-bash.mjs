/**
 * PreToolUse hook for the Bash tool: runs `rules-bash.mjs` over the command
 * with a real git/gh/filesystem context. Wired in `.claude/settings.json`.
 */
import {
  applyVerdict,
  currentBranch,
  ghJson,
  git,
  isInside,
  linkTargets,
  mainRepoRoot,
  originMasterFresh,
  readIndexFile,
  readInput,
  readRepoFile,
  specFilenames,
  toplevel,
  workspacePackages,
} from "./lib.mjs";
import { checkBash } from "./rules-bash.mjs";

const memo = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key);
  };
};

const input = await readInput();
const command = input.tool_input?.command;
if (typeof command === "string" && command.trim()) {
  const cwd = input.cwd ?? process.cwd();
  const ctx = {
    cwd,
    branch: memo(currentBranch),
    staged: memo((dir) => lines(git(["diff", "--cached", "--name-only"], dir))),
    modified: memo((dir) => lines(git(["diff", "--name-only"], dir))),
    // A dir git cannot answer for (not a repo, or not on disk yet) falls back to the
    // SESSION's repo root, never to the dir itself — comparing a path against itself
    // is how a valid `worktree add` got denied as "inside the repo".
    mainRoot: memo((dir) => mainRepoRoot(dir) ?? mainRepoRoot(cwd) ?? cwd),
    originFresh: memo(originMasterFresh),
    // Specs are listed off origin/master, asked of the MAIN repository — the
    // ref a new ir-<n> is cut from, which the freshness check has just
    // confirmed current (see `specFilenames` for the fallback).
    //
    // `specText` reads from wherever the commit will take the bytes, which the
    // rule works out per file: the INDEX for a spec staged before this command
    // and not re-added by it, the WORKING copy for everything else — a chained
    // `git add spec.md && git commit` has staged nothing yet when this hook
    // runs, and `-a` and pathspec commits take the working copy anyway.
    specFiles: memo((dir) => specFilenames(mainRepoRoot(dir) ?? mainRepoRoot(cwd) ?? cwd)),
    specText: memo((dir, rel, from) =>
      from === "index" ? readIndexFile(dir, rel) : readRepoFile(toplevel(dir) ?? mainRepoRoot(cwd) ?? cwd, rel),
    ),
    // Root-relative like `staged`/`modified`, so a `git add <dir>` operand can be
    // matched against them.
    untracked: memo((dir) => lines(git(["ls-files", "--others", "--exclude-standard", "--full-name"], dir))),
    // Already in HEAD means this commit AMENDS the spec rather than adding it.
    tracked: memo((dir, rel) => git(["cat-file", "-e", `HEAD:${rel}`], dir).ok),
    issueLabels: memo((issue, dir) => ghJson(["issue", "view", String(issue), "--json", "labels"], dir)),
    linkTargets: memo(() => linkTargets()),
    packages: memo(() => workspacePackages(mainRepoRoot(cwd) ?? cwd)),
    isInside,
    prView: memo((ref, dir) =>
      ghJson(
        [
          "pr",
          "view",
          ...(ref ? [ref] : []),
          "--json",
          "number,state,headRefOid,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,reviews",
        ],
        dir,
      ),
    ),
  };
  let verdict;
  try {
    verdict = checkBash(command, ctx);
  } catch (e) {
    verdict = `Hook error in pre-bash.mjs (fix the hook, then retry): ${e?.stack ?? e}`;
  }
  applyVerdict(verdict);
}

function lines(res) {
  return res.ok ? res.out.split(/\r?\n/).filter(Boolean) : [];
}
