/**
 * PostToolUse hook for the Bash and PowerShell tools: the follow-through steps
 * that used to be reminders — the board move after a merge, a worktree, an
 * issue filing or a milestone set on an issue (#1574), the post-merge CI run
 * list, and a diff after a scripted edit.
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
  chainCommands,
  firstMerge,
  GIT_WORKTREE_ADD,
  gitCwd,
  issueEdits,
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
  createdIssues,
  editTargets,
  HOME_REPO,
  isHomeRepo,
  issueCreateRepos,
  issueNumberOfUrl,
  mergeRepo,
  missingWorkflows,
  pickCreated,
  repoOfUrl,
  setsMilestone,
} from "./rules-post.mjs";

// Unanchored, as `firstMerge` is: anchored, a merge behind a wrapper the anchor
// does not know matched no segment, and `gitCwd` then walked every `cd` in the
// chain, those after the merge included.
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;
const GH_ISSUE_CREATE = /\bgh\s+issue\s+create\b/;

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
    const repos = issueCreateRepos(command, text);
    if (repos.length) {
      // Each create's own directory, so a chain that `cd`s between two creates
      // judges each by its own checkout; both walks visit the same masked
      // matches in the same order.
      const dirs = [...chainCommands(command, cwd, GH_ISSUE_CREATE, shell)].map((c) => c.base);
      notes.push(
        ...afterIssueCreate(
          stdout,
          repos.map((repo, k) => ({ repo, dir: dirs[k] ?? cwd })),
          cwd,
        ),
      );
    }
    // Ahead of the worktree step, so a chain that does both ends in In progress
    // whichever order it ran them in: Planned is a lane In progress may follow.
    for (const edit of issueEdits(command, cwd, shell))
      if (setsMilestone(edit))
        notes.push(
          ...afterMilestone(edit, assignedGhRepo(command.slice(0, edit.start), text.slice(0, edit.start)), cwd),
        );
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

/**
 * Only an issue the command just created is filed ({@link pickCreated}): a
 * chain's output can carry other issues' URLs, a comment's, an edit's or a
 * view's, while a create may print none (#1527). Another repository's issue is
 * only reported as left alone, so it needs no age.
 *
 * `creates` holds, for each create, the repository it named (`repo`, from
 * `issueCreateRepos`) and the directory it ran in (`dir`); one that named none
 * used that directory's repository, which is asked of gh only when a board
 * decision depends on it, once per directory. An iRaceDeck URL is filed only
 * when some create may have been home, and the hand-move reminder for a create
 * that printed no new iRaceDeck issue goes out on the same condition. So a
 * foreign create never files another command's iRaceDeck URL nor is sent to
 * this board by hand, and a home one is never lost behind a foreign URL.
 */
function afterIssueCreate(stdout, creates, cwd) {
  let resolved;
  const homeCreate = () => {
    if (!resolved) {
      const checkoutRepo = new Map();
      const repoOf = (dir) => {
        if (!checkoutRepo.has(dir))
          checkoutRepo.set(dir, ghJson(["repo", "view", "--json", "nameWithOwner"], dir)?.nameWithOwner ?? null);
        return checkoutRepo.get(dir);
      };
      resolved = creates.map(({ repo, dir }) => (repo !== undefined ? repo : repoOf(dir)));
    }
    // An unreadable or unresolvable repository may be home.
    return resolved.some((t) => t == null || isHomeRepo(t));
  };
  const leftAlone = () =>
    `gh issue create ran in ${[...new Set(resolved.filter((t) => t != null))].join(", ")}, not ${HOME_REPO}: the Roadmap board is left alone.`;
  const found = createdIssues(stdout);
  if (!found.length)
    return [
      homeCreate()
        ? "gh issue create: no issue URL in the output; add the card to the Roadmap board by hand (Backlog)."
        : leftAlone(),
    ];
  const out = found
    .filter((issue) => !isHomeRepo(issue.repo))
    .map((issue) => `Filed ${issue.url} in ${issue.repo}, not ${HOME_REPO}: the Roadmap board is left alone.`);
  const homeFound = found.filter((issue) => isHomeRepo(issue.repo));
  // An iRaceDeck URL beside creates that all ran elsewhere is another
  // command's (a view's, an edit's): no create here made it.
  if (homeFound.length && !homeCreate()) return [...out, leftAlone()];
  const { picked, unsure } = pickCreated(homeFound, (issue) => {
    const created = Date.parse(ghJson(["api", `repos/${issue.repo}/issues/${issue.number}`], cwd)?.created_at);
    return Number.isFinite(created) ? Date.now() - created : undefined;
  });
  out.push(...picked.map((issue) => fileOnBoard(issue, cwd)));
  if (unsure.length)
    out.push(
      `gh issue create: could not tell whether ${unsure.map((i) => i.url).join(", ")} ${unsure.length > 1 ? "were" : "was"} just filed; add any that was to the Roadmap board by hand (Backlog).`,
    );
  // A home create that printed no new iRaceDeck issue still needs its card,
  // whatever foreign URLs sit beside it in the output.
  if (!picked.length && !unsure.length) {
    if (homeCreate())
      out.push(
        "gh issue create: no issue in the output was just created; add the card to the Roadmap board by hand (Backlog).",
      );
    else if (!out.length) out.push(leftAlone());
  }
  return out;
}

function fileOnBoard(issue, cwd) {
  const itemId = addToBoard(issue.url, cwd);
  if (!itemId)
    return `Filed ${issue.url} but could not add it to the Roadmap board (gh project item-add failed — token scope?).`;
  return `Added ${issue.url} to the Roadmap board; ${setBoardStatus(issue.number, "Backlog", cwd)}. Milestone and assignee stay empty until implementation starts.`;
}

/**
 * The hand move for a card the hook could not move to Planned, run from the
 * repo root. A declaration, not a `const`: the hook's body above runs first.
 */
function plannedByHand(n) {
  return `node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(${n},'Planned',process.cwd())))"`;
}

/**
 * An open iRaceDeck issue with a milestone belongs in Planned (#1574), so a
 * `gh issue edit … --milestone` moves each issue it names there. PostToolUse
 * fires on a failed edit too (a misspelt milestone), so each issue is read
 * back, in the directory the edit ran in and from the repository it used —
 * passed as `GH_REPO`, as {@link afterMerge} does — and only one that is in
 * {@link HOME_REPO}, open and milestoned moves. A card already in Planned or
 * past it stays, as `setBoardStatus` says. Another repository's issue is
 * named once as left alone, with no gh call when the edit's own arguments
 * already say where it is (#1527). An edit with an issue argument the hook
 * cannot read still moves the ones it can, and names the rest for a hand move.
 */
function afterMilestone(edit, envRepo, cwd) {
  const out = edit.readable
    ? []
    : [
        `gh issue edit set a milestone, but the hook could not read every issue it edited; move each other open iRaceDeck one to Planned by hand: ${plannedByHand("<n>")}`,
      ];
  const foreign = [];
  const dir = existsSync(edit.base) ? edit.base : cwd;
  for (const { ref, repo } of editTargets(edit, envRepo)) {
    const name = repoOfUrl(ref) ? ref : `#${ref}`;
    if (repo === null) {
      out.push(
        `gh issue edit ${name} ran with a --repo or GH_REPO the hook cannot read; if it is an open iRaceDeck issue that now has a milestone, move its card to Planned by hand: ${plannedByHand(ref)}`,
      );
      continue;
    }
    if (repo && !isHomeRepo(repo)) {
      foreign.push(repoOfUrl(ref) ? ref : `${repo}#${ref}`);
      continue;
    }
    const issue = ghJson(
      ["issue", "view", ref, "--json", "url,milestone,state"],
      dir,
      repo && !repoOfUrl(ref) ? { env: { GH_REPO: repo } } : undefined,
    );
    const n = issueNumberOfUrl(issue?.url);
    if (!issue || n === undefined) {
      out.push(
        `gh issue edit: could not read ${name} back; if it is an open iRaceDeck issue that now has a milestone, move its card to Planned by hand: ${plannedByHand(repoOfUrl(ref) ? "<n>" : ref)}`,
      );
      continue;
    }
    // Whatever gh resolved the repository from, the URL says which issue it read.
    if (!isHomeRepo(repoOfUrl(issue.url))) foreign.push(issue.url);
    else if (!issue.milestone?.title) out.push(`gh issue edit: #${n} has no milestone after the edit; no card moved.`);
    else if (issue.state !== "OPEN") out.push(`gh issue edit: #${n} is ${issue.state}; its card stays where it is.`);
    else out.push(`${setBoardStatus(n, "Planned", cwd)} (milestone ${issue.milestone.title}).`);
  }
  if (foreign.length)
    out.push(`gh issue edit milestoned ${foreign.join(", ")}, not in ${HOME_REPO}: the Roadmap board is left alone.`);
  return out;
}

/**
 * `target` is the add's own argument (`worktreeAddTarget`), read where the
 * pre-hook's rule read it. The issue is looked up from the checkout the add
 * ran in, so an `ir-<n>` added to another repository's checkout is that
 * repository's issue and moves no card here (#1527). A `GH_REPO` the hook
 * inherited is cleared for the lookup: it names the session's default, not
 * the checkout the tree belongs to.
 */
function afterWorktreeAdd(command, target, cwd, shell) {
  const dir = gitCwd(command, cwd, GIT_WORKTREE_ADD, shell);
  const issue = issueFromWorktreePath(resolveDir(dir, target, { shell }));
  if (!issue) return [];
  const found = ghJson(["issue", "view", String(issue), "--json", "url"], dir, { env: { GH_REPO: "" } });
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
