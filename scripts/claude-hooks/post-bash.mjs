/**
 * PostToolUse hook for the Bash and PowerShell tools: the follow-through steps
 * that used to be reminders — the board move after a merge, a worktree or an
 * issue filing, the post-merge CI run list, and a diff after a scripted edit.
 * A PowerShell command (#1520) is read as the pre-hook reads it, through
 * `powershellAsBash`, so the same triggers find it.
 *
 * Every board move is for an issue of niklam/iracedeck only (#1527): a card is
 * found by number, so a filing, a merge or a worktree in another repository
 * would move the iRaceDeck card that shares its number. Those get one line
 * saying the hook left the board alone.
 */
import { existsSync } from "node:fs";

import { addToBoard, ghJson, git, postContext, readInput, setBoardStatus } from "./lib.mjs";
import {
  BASH,
  firstMerge,
  GIT_WORKTREE_ADD,
  gitCwd,
  issueFromWorktreePath,
  POWERSHELL,
  powershellAsBash,
  resolveDir,
  trustedMask,
  worktreeAddTarget,
} from "./rules-bash.mjs";
import {
  assignedGhRepo,
  boardIssues,
  createdIssue,
  HOME_REPO,
  isHomeRepo,
  mergeRepo,
  missingWorkflows,
  repoOfUrl,
} from "./rules-post.mjs";

// Unanchored, as `firstMerge` is: anchored, a merge behind a wrapper the anchor
// does not know matched no segment, and `gitCwd` then walked every `cd` in the
// chain, those after the merge included.
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;

const input = await readInput();
const raw = input.tool_input?.command;
if (typeof raw === "string") {
  const shell = input.tool_name === "PowerShell" ? POWERSHELL : BASH;
  const command = shell === POWERSHELL ? powershellAsBash(raw) : raw;
  const cwd = input.cwd ?? process.cwd();
  const resp = input.tool_response ?? {};
  const stdout = typeof resp === "string" ? resp : (resp.stdout ?? resp.output ?? "");
  const notes = [];
  try {
    // The triggers read the trusted-masked text (#1321): a grep, a heredoc or a
    // comment body that merely NAMES `gh pr merge` used to run the after-merge
    // steps. Where the mask is not trusted they read the raw text, as before.
    // Unanchored on purpose: a follow-up is wanted wherever the command ran,
    // `xargs sed -i` and `timeout 120 gh pr merge` included.
    const text = trustedMask(command);
    if (/\bsed\s+(-[a-zA-Z]*i|--in-place)/.test(text)) {
      const r = git(["diff", "--stat"], gitCwd(command, cwd));
      notes.push(`sed -i ran; git diff --stat:\n${r.out.trim() || "(no tracked changes)"}`);
    }
    const merge = firstMerge(command);
    if (merge?.readable) notes.push(...afterMerge(merge, command, cwd, shell));
    else if (merge)
      notes.push(
        "gh pr merge ran, but its PR argument could not be read; check by hand whether it merged, and move its Roadmap card to Testing.",
      );
    if (/\bgh\s+issue\s+create\b/.test(text)) notes.push(...afterIssueCreate(stdout, cwd));
    const target = worktreeAddTarget(command);
    if (target) notes.push(...afterWorktreeAdd(command, target, cwd, shell));
  } catch (e) {
    notes.push(`post-bash hook error: ${e?.stack ?? e}`);
  }
  if (notes.length) postContext(`[hook] ${notes.join("\n[hook] ")}`);
}

/**
 * `merge` is the merge's own arguments (`parseMerge`), so a pin or a body value
 * is never read as the PR. The PR is read back from the repository the merge
 * named, in the directory it ran in, and only one in {@link HOME_REPO} moves a
 * card (#1527). A `GH_REPO` counts only where it reaches the merge
 * (`assignedGhRepo`). The repository reaches the read-back as `GH_REPO`, not
 * `--repo`, which gh refuses without a PR argument where the merge itself,
 * reading `GH_REPO`, took the branch's PR. A directory the chain removed after
 * the merge is gone by now, so the read-back then runs in the session's.
 */
function afterMerge(merge, command, cwd, shell) {
  const text = trustedMask(command);
  const at = GH_PR_MERGE.exec(text)?.index ?? command.length;
  const named = mergeRepo(merge, assignedGhRepo(command.slice(0, at), text.slice(0, at)));
  if (named === null)
    return [
      "gh pr merge ran with a --repo or GH_REPO the hook cannot read; check by hand whether it merged an iRaceDeck PR, and move its Roadmap card to Testing.",
    ];
  if (named && !isHomeRepo(named))
    return [`gh pr merge ran in ${named}, not ${HOME_REPO}: no Roadmap card moved and no post-merge runs listed.`];
  const ran = gitCwd(command, cwd, GH_PR_MERGE, shell);
  const pr = ghJson(
    [
      "pr",
      "view",
      ...(merge.ref ? [merge.ref] : []),
      "--json",
      "number,state,title,url,mergeCommit,closingIssuesReferences",
    ],
    existsSync(ran) ? ran : cwd,
    named && !repoOfUrl(merge.ref) ? { env: { GH_REPO: named } } : undefined,
  );
  if (!pr) return ["gh pr merge: could not read the PR back; check by hand whether it merged."];
  // Whatever gh resolved the repository from (a cd, the session's GH_REPO), its URL says which PR it read.
  const prRepo = repoOfUrl(pr.url);
  if (!isHomeRepo(prRepo))
    return [
      `gh pr merge: PR ${pr.url ?? `#${pr.number}`} is in ${prRepo ?? "an unknown repository"}, not ${HOME_REPO}: no Roadmap card moved and no post-merge runs listed.`,
    ];
  if (pr.state !== "MERGED") return [`PR #${pr.number} is ${pr.state}, not MERGED — the merge did not go through.`];
  const out = [];
  const { issues, foreign } = boardIssues(pr);
  for (const n of issues) out.push(setBoardStatus(n, "Testing", cwd));
  if (foreign.length) out.push(`Closing issues outside ${HOME_REPO} have no Roadmap card: ${foreign.join(", ")}.`);
  if (issues.length === 0)
    out.push("No closing issue on the PR; move its Roadmap card to Testing by hand if there is one.");
  const sha = pr.mergeCommit?.oid;
  if (sha) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000); // give Actions a moment to create the runs
    const runs =
      ghJson(
        [
          "run",
          "list",
          "--repo",
          HOME_REPO,
          "--commit",
          sha,
          "--json",
          "workflowName,status,conclusion,url",
          "--limit",
          "20",
        ],
        cwd,
      ) ?? [];
    const missing = missingWorkflows(runs);
    const lines = runs.map(
      (r) => `  ${r.workflowName}: ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""} ${r.url}`,
    );
    out.push(
      `Post-merge runs for ${sha.slice(0, 9)}:\n${lines.join("\n") || "  (none created yet)"}` +
        (missing.length ? `\n  not yet started: ${missing.join(", ")}` : "") +
        `\nThe merge is not finished until all four are green. Watch them: gh run list --commit ${sha} --json workflowName,status,conclusion — a red goes to the coordinator, then to the maintainer; never fix or revert on your own.`,
    );
  }
  return out;
}

function afterIssueCreate(stdout, cwd) {
  const issue = createdIssue(stdout);
  if (!issue)
    return ["gh issue create: no issue URL in the output; add the card to the Roadmap board by hand (Backlog)."];
  if (!isHomeRepo(issue.repo))
    return [`Filed ${issue.url} in ${issue.repo}, not ${HOME_REPO}: the Roadmap board is left alone.`];
  const itemId = addToBoard(issue.url, cwd);
  if (!itemId)
    return [
      `Filed ${issue.url} but could not add it to the Roadmap board (gh project item-add failed — token scope?).`,
    ];
  return [
    `Added ${issue.url} to the Roadmap board; ${setBoardStatus(issue.number, "Backlog", cwd)}. Milestone and assignee stay empty until implementation starts.`,
  ];
}

/**
 * `target` is the add's own argument (`worktreeAddTarget`), read where the
 * pre-hook's rule read it. The issue is looked up from the checkout the add
 * ran in, so an `ir-<n>` added to another repository's checkout is that
 * repository's issue and moves no card here (#1527).
 */
function afterWorktreeAdd(command, target, cwd, shell) {
  const dir = gitCwd(command, cwd, GIT_WORKTREE_ADD, shell);
  const issue = issueFromWorktreePath(resolveDir(dir, target, { shell }));
  if (!issue) return [];
  const found = ghJson(["issue", "view", String(issue), "--json", "url"], dir);
  if (!found)
    return [`Worktree for #${issue} created, but gh cannot see that issue; move its card to In progress by hand.`];
  const repo = repoOfUrl(found.url);
  if (!isHomeRepo(repo))
    return [
      `Worktree ir-${issue} created in a checkout of ${repo ?? "an unknown repository"}, not ${HOME_REPO}: no Roadmap card moved.`,
    ];
  return [
    `${setBoardStatus(issue, "In progress", cwd)}. Now set the issue's milestone and assignee (implementation is starting).`,
  ];
}
