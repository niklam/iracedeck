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
    // Specs live on master, so they are listed in the MAIN checkout — the tree
    // a `worktree add` is being run from, and the one a sibling ir-<n> has not
    // been created in yet. `specText` reads from the committing tree's own
    // toplevel instead, since that is where the staged file actually is.
    specFiles: memo((dir) => specFilenames(mainRepoRoot(dir) ?? mainRepoRoot(cwd) ?? cwd)),
    specText: memo((dir, rel) => readRepoFile(toplevel(dir) ?? mainRepoRoot(cwd) ?? cwd, rel)),
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
