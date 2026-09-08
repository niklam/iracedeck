/**
 * PreToolUse rules for the non-Bash tools: Skill (`/code-review`), Agent
 * (model choice, worktree isolation) and AskUserQuestion (option wording).
 * Pure: each takes the tool input and returns a deny reason or `null`.
 */
import path from "node:path";

const LEVELS = ["max", "xhigh", "high", "medium", "low"];

/**
 * `/code-review` must name its effort level, target the ir-<issue> worktree
 * by absolute path (the session cwd is the master checkout), and never carry
 * `--fix`. See .claude/rules/code-review.md.
 */
export function checkSkill({ skill, args = "" }, cwd = "") {
  if (!/(^|:)code-review$/.test(skill ?? "")) return null;
  const a = String(args);
  if (/(^|\s)--fix(\s|$)/.test(a))
    return "Never run /code-review with --fix: findings are candidates, not verdicts. Report only, then apply the ones that hold by hand.";
  if (/(^|\s)ultra(\s|$)/.test(a)) return null; // the cloud review is Niklas's to launch, and it bundles the branch itself
  const wordsIn = a.split(/\s+/).filter(Boolean);
  if (!wordsIn.some((w) => LEVELS.includes(w)))
    return `State the effort level explicitly (${LEVELS.join(" / ")}) — a bare call silently reuses the last level typed.`;
  const targetsWorktree = /[\\/]ir-\d+/.test(a) || /^ir-\d+$/.test(path.basename(cwd));
  if (!targetsWorktree)
    return "Point the review at the worktree that holds the work (absolute path to ../ir-<issue> plus the SCOPE block); a bare call reviews master's diff.";
  return null;
}

/**
 * The model is chosen per task, never inherited: an omitted `model` silently
 * runs the agent on the coordinator's (usually the most expensive) model.
 * `fork` ignores `model`, so it is exempt. And worktrees are per issue, so an
 * agent never gets one of its own.
 */
export function checkAgent({ subagent_type: type, model, isolation } = {}) {
  if (isolation === "worktree")
    return 'Worktrees are per ISSUE, not per agent: do not pass isolation: "worktree". Point the agent at the issue\'s ../ir-<issue> tree instead.';
  if (type === "fork") return null;
  if (!model)
    return "Choose the agent's model for THIS task (fable / opus / sonnet / haiku) — an omitted model inherits the coordinator's. Say the choice and the reason in one line.";
  return null;
}

/**
 * Option labels name the actor as "Claude runs it" / "You run it", never
 * "I run it": the safety classifier misreads a first-person actor and denies
 * paid commands.
 */
export function checkAsk({ questions = [] } = {}) {
  const bad = /\bI\b\s*(run|do|will|would|can|could|execute|handle|perform|start|open|launch|push|merge|'ll)/;
  for (const q of questions) {
    const texts = [q.question, ...(q.options ?? []).flatMap((o) => [o.label, o.description])];
    const hit = texts.find((t) => typeof t === "string" && bad.test(t));
    if (hit)
      return `Name the actor as "Claude …" or "You …", never "I …" (found: "${hit.slice(0, 80)}"). The classifier misreads a first-person actor and denies the command.`;
  }
  return null;
}
