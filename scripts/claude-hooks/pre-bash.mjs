/**
 * PreToolUse hook for the Bash tool: runs `rules-bash.mjs` over the command
 * with a real git/gh/filesystem context. Wired in `.claude/settings.json`.
 */
import {
  applyVerdict,
  branchFiles,
  currentBranch,
  ghJson,
  git,
  isInside,
  linkTargets,
  mainRepoRoot,
  originMasterFresh,
  readInput,
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
    branchFiles: memo(branchFiles),
    staged: memo((dir) => lines(git(["diff", "--cached", "--name-only"], dir))),
    modified: memo((dir) => lines(git(["diff", "--name-only"], dir))),
    mainRoot: memo((dir) => mainRepoRoot(dir) ?? dir),
    originFresh: memo(originMasterFresh),
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
