# Declined review findings go to a fresh judge

> **Issue:** [#1528](https://github.com/niklam/iracedeck/issues/1528) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Why

The reviews themselves are independent: `/code-review` and the second read run as fresh agents that never see the implementer's reasoning, and CodeRabbit is outside the system. The step after them is not. The issue lead verifies each finding and decides which hold, so a finding against the lead's own code can be declined by the lead alone, and nobody else ever sees that decision. Niklas asked for this to close (2026-10-30), picking a fresh judge over having the PO review the declines, because the PO is part of the same team.

## Decision

**What goes to the judge.** Every finding the issue lead would not fix as asked: declined, marked "no change needed", skipped as narrow, or a CodeRabbit PR thread the lead would answer with a rejection. That covers findings from `/code-review`, the second read, the CodeRabbit CLI and CodeRabbit on the PR. A finding the lead fixes is not judged: fixing it is agreeing with it, and the fix diff is verified as today.

**The judge.** One fresh agent per review round, `general-purpose`, `model: "opus"`, read-only, given only:

- the worktree path and the diff range (`origin/master...HEAD`);
- each finding verbatim, with its file and line and where it came from;
- the lead's reason for not fixing it, in a sentence or two.

It does not get the conversation, the plan, the spec rationale or the other findings' outcomes. It reads the code itself and rules on each finding separately: **upheld** (the decline stands) or **overruled** (the finding holds, fix it), with the evidence it read. One agent per round rather than one per finding keeps the cost to one call even on a round with several declines; a round with no declines spawns nothing.

**The ruling binds.** An overruled finding is fixed, and the lead does not argue it back to the judge. The one exception: when the ruling would contradict a decision a spec or a rule file records, the lead sends both to the PO, which decides. Product questions go on to Niklas as usual; technical ones do not.

**The record.** The PR body carries one line per review source: `Judged declines: N, U upheld, O overruled.` A PR thread the judge upheld is answered with the lead's reasoning plus "upheld by an independent judge"; an overruled one is answered with the fix commit.

## Where it lives

- `.claude/skills/issue-lead/SKILL.md`, steps 7 and 10: the judge step after each review round, the brief, and the binding rule.
- `.claude/rules/code-review.md`, *Report only*: one sentence saying a finding its author would decline goes to a fresh judge (the brief lives in the skill), because the rule also governs reviews run outside the agent team.
- `.claude/skills/second-read/SKILL.md`, step 5: "decline it with the reason" becomes "send it to the judge with the reason".

The always-loaded growth is that one sentence in `code-review.md`.

## Alternatives rejected

- **The PO reviews declines.** Cheaper, but the PO is part of the team that wants the branch merged; Niklas preferred a party with no stake.
- **Separate sessions for reviewers.** The reviewers are already context-free; the bias was never in the review, it is in the disposal of its findings.
- **A judge for every finding, fixed ones included.** A fix is agreement, and its diff is already checked; judging it doubles the cost for nothing.

## Out of scope

- How findings are produced: the reviewers, their levels and their briefs are unchanged.
- Reviews of work outside an issue lead (a solo session) follow the same rule but are not policed by a hook.
- Any hook enforcement: whether a decline went to the judge is not visible to a hook; the PR-body tally is the record.

## Testing

- The skill and rule edits keep `scripts/claude-rules-frontmatter.test.mjs` green, and the PR records the always-loaded headroom before and after.
- The first branch where an issue lead declines a finding exercises the step end to end: the judge runs with only the inputs above, the PR body carries the tally, and an overruled finding is fixed. That run is checked by reading the issue lead's transcript, not assumed.
