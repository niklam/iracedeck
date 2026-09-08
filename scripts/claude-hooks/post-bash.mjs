/**
 * PostToolUse hook for Bash: the follow-through steps that used to be
 * reminders — the board move after a merge, a worktree or an issue filing,
 * the post-merge CI run list, and a diff after a scripted edit.
 */
import path from "node:path";

import { addToBoard, gh, ghJson, git, postContext, readInput, setBoardStatus } from "./lib.mjs";
import { gitCwd, words } from "./rules-bash.mjs";
import { issueFromWorktreePath, missingWorkflows, prRefFrom } from "./rules-post.mjs";

const input = await readInput();
const command = input.tool_input?.command;
if (typeof command === "string") {
  const cwd = input.cwd ?? process.cwd();
  const resp = input.tool_response ?? {};
  const stdout = typeof resp === "string" ? resp : (resp.stdout ?? resp.output ?? "");
  const notes = [];
  try {
    if (/\bsed\s+(-[a-zA-Z]*i|--in-place)/.test(command)) {
      const r = git(["diff", "--stat"], gitCwd(command, cwd));
      notes.push(`sed -i ran; git diff --stat:\n${r.out.trim() || "(no tracked changes)"}`);
    }
    if (/\bgh\s+pr\s+merge\b/.test(command)) notes.push(...afterMerge(command, cwd));
    if (/\bgh\s+issue\s+create\b/.test(command)) notes.push(...afterIssueCreate(stdout, cwd));
    if (/\bgit\s+(-C\s+\S+\s+)?worktree\s+add\b/.test(command)) notes.push(...afterWorktreeAdd(command, cwd));
  } catch (e) {
    notes.push(`post-bash hook error: ${e?.stack ?? e}`);
  }
  if (notes.length) postContext(`[hook] ${notes.join("\n[hook] ")}`);
}

function afterMerge(command, cwd) {
  const ref = prRefFrom(command, "merge");
  const pr = ghJson(
    ["pr", "view", ...(ref ? [ref] : []), "--json", "number,state,title,mergeCommit,closingIssuesReferences"],
    cwd,
  );
  if (!pr) return ["gh pr merge: could not read the PR back; check by hand whether it merged."];
  if (pr.state !== "MERGED") return [`PR #${pr.number} is ${pr.state}, not MERGED — the merge did not go through.`];
  const out = [];
  const issues = (pr.closingIssuesReferences ?? []).map((i) => i.number);
  const fromTitle = pr.title.match(/\(#(\d+)\)\s*$/);
  if (issues.length === 0 && fromTitle) issues.push(Number(fromTitle[1]));
  for (const n of issues) out.push(setBoardStatus(n, "Testing", cwd));
  if (issues.length === 0)
    out.push("No closing issue on the PR; move its Roadmap card to Testing by hand if there is one.");
  const sha = pr.mergeCommit?.oid;
  if (sha) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000); // give Actions a moment to create the runs
    const runs =
      ghJson(["run", "list", "--commit", sha, "--json", "workflowName,status,conclusion,url", "--limit", "20"], cwd) ??
      [];
    const missing = missingWorkflows(runs);
    const lines = runs.map(
      (r) => `  ${r.workflowName}: ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""} ${r.url}`,
    );
    out.push(
      `Post-merge runs for ${sha.slice(0, 9)}:\n${lines.join("\n") || "  (none created yet)"}` +
        (missing.length ? `\n  not yet started: ${missing.join(", ")}` : "") +
        `\nThe merge is not finished until all four are green. Watch them: gh run list --commit ${sha} --json workflowName,status,conclusion — a red goes to the coordinator, then to Niklas; never fix or revert on your own.`,
    );
  }
  return out;
}

function afterIssueCreate(stdout, cwd) {
  const url = String(stdout).match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/);
  if (!url)
    return ["gh issue create: no issue URL in the output; add the card to the Roadmap board by hand (Backlog)."];
  const itemId = addToBoard(url[0], cwd);
  if (!itemId)
    return [`Filed ${url[0]} but could not add it to the Roadmap board (gh project item-add failed — token scope?).`];
  return [
    `Added ${url[0]} to the Roadmap board; ${setBoardStatus(Number(url[1]), "Backlog", cwd)}. Milestone and assignee stay empty until implementation starts.`,
  ];
}

function afterWorktreeAdd(command, cwd) {
  const m = command.match(/worktree\s+add\b(.*)$/m);
  const args = words(m?.[1] ?? "");
  let target;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-b" || args[i] === "-B") i++;
    else if (!args[i].startsWith("-")) {
      target = args[i];
      break;
    }
  }
  if (!target) return [];
  const resolved = path.resolve(gitCwd(command, cwd), target);
  const issue = issueFromWorktreePath(resolved);
  if (!issue) return [];
  const r = gh(["issue", "view", String(issue), "--json", "number"], cwd);
  if (!r.ok)
    return [`Worktree for #${issue} created, but gh cannot see that issue; move its card to In progress by hand.`];
  return [
    `${setBoardStatus(issue, "In progress", cwd)}. Now set the issue's milestone and assignee (implementation is starting).`,
  ];
}
