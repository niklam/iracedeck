# Issue Workflow

The order an issue is worked in, and which steps are gates.

This file owns the **sequence**, the **gates**, and **why each gate exists** — nothing else. How to perform a step belongs to the rule that owns it, linked in the table. Keeping mechanics out is what stops this file drifting from the five rules it sequences.

If you are picking up an issue, read this first. In the agent team (#1520) the PO (`/po`) runs steps 1–2 and is the only team session that writes to `master` or asks Niklas anything (a session he drives directly may commit a spec there too, alone and pushed at once); the issue lead (`issue-lead` skill) runs 3–13 through its role agents and sends every question to the PO.

## The pipeline

| #   | Step                                                       | Gate                    | Detail                                                                     |
| --- | ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| 1   | File the issue                                             | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 2   | Write the spec, commit to `master`                         | unless exempt           | `@.claude/rules/specs-and-plans.md`                                         |
| 3   | Create the worktree `../ir-<issue>`                        | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 4   | Implement, committing as you go                            | Niklas approves each clip and icon | below, and the topic rules for what you touched                  |
| 5   | `install` → `build` → `typecheck` → `format` → `lint` → `test`, by hand | all green    | `@.claude/rules/testing.md`, `@.claude/rules/code-style.md`                  |
| 6   | Document it on the website                                 | required if user-facing | `@.claude/rules/website-action-docs.md`, `@.claude/rules/changelog.md`       |
| 7   | Run the code review, then the second read where it applies | —                       | `@.claude/rules/code-review.md`                                             |
| 8   | Manual testing                                             | **blocks the PR**       | below                                                                       |
| 9   | Push, open the PR                                          | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 10  | Babysit the review                                         | every thread answered   | below                                                                       |
| 11  | Merge                                                      | approved + checks green **at the current head** | `@.claude/rules/build-and-commit.md`                    |
| 12  | Watch **all four** post-merge runs to completion           | a red result goes to the PO                     | below                                                   |
| 13  | Remove the worktree                                        | —                                               | `@.claude/rules/build-and-commit.md`                    |

## Why these gates exist

### Milestone and assignee wait for implementation (1)

Filing an issue does not assign it or milestone it. Both are signals that work is *starting*, not that an idea has been captured — so they go on when the issue is picked up, alongside the worktree, not when it is written.

Filing early and often is the point: an issue is a place to put a decision so it stops living in a conversation. Milestoning it at that moment makes a promise about a release nobody has planned yet, and assigning it makes a promise about who is doing it. A backlog of unassigned, unmilestoned issues is the correct shape for work that is understood but not scheduled.

The hooks pin both ends of that: `gh issue create` is refused when it carries `--milestone` or `--assignee`, and `git worktree add ../ir-<n>` moves the card to `In progress` — which is the moment to set them. Niklas may milestone an issue earlier, when he plans a release; setting a milestone moves a `Backlog` card to `Planned` (#1574).

Labels are different — the issue templates apply `bug` / `enhancement` automatically, and those stay. Do not add `type:` labels to issues; those are for PRs, where they drive release notes.

### The spec is the one thing that does not go through a PR (2)

Where a spec is required — `@.claude/rules/specs-and-plans.md` lists the exemptions — it goes straight to `master` as its own commit, and never on the branch implementing it. That rule gives three reasons. A fourth belongs here, because it is about this sequence: step 7 needs the spec readable **before** the PR exists, since it is what tells a reviewer whether the implementation matches the intent.

### Issues are worked in a worktree (3)

Settled by the maintainer: an issue is solved in a sibling worktree, never inside the repo directory, and nobody asks which mode to use (`@.claude/rules/build-and-commit.md`).

### Nothing verifies your work but you (5)

**Assume nothing is watching, confirm, then run everything yourself.** The repo does ship watchers and one may be running against a linked worktree, so check before firing a full build into a tree something else is writing.

The green set is the CI set plus the pre-commit checks: `install`, `build`, `typecheck`, `format`, `lint`, `test`. CI runs format, lint and test as **separate** jobs, so a clean `lint` proves nothing about `format`. Read the build output rather than its exit code — `@.claude/rules/build-and-commit.md` explains why that distinction bites here.

**A green PR check is not a statement about the merged result.** It proves something about your branch merged against the master that existed when the check ran. Under squash-merge the commit that lands is a tree nothing has ever built or tested, and when two PRs are in flight the gap opens silently — both green, the merge textually clean, and nothing red anywhere to notice. Since #1070 all four CI workflows also run on pushes to `master` and `release/*`, so the merged result is checked too — but *after* the merge, not before it. That is what step 12 is for.

### If a user can see it, the website describes it (6)

A feature that ships undocumented is a feature nobody finds. Website documentation is part of the change, in the same PR — not a follow-up issue. Same for the changelog when the change is user-facing.

### Prefer the thorough solution (4)

SOLID over quick wins. A shortcut that leaves tech debt is not a saving; it is a loan against the next person to open the file. Build the thorough option and report what it cost; never offer the maintainer a cheaper, worse option to choose.

### Niklas hears every clip and sees every icon (4)

No clip is generated or regenerated before he approves its text, since generating costs ElevenLabs credit, and no clip or icon design is committed before he approves it on a review page (`review-page` skill). These and the manual test are the approvals he wants; product decisions and releases are the only other things he is asked.

### The code review: the issue lead runs it (7)

Nobody is asked whether to run it: the issue lead runs it at the level from the table in `@.claude/rules/code-review.md` and says which row the change landed in. Target the worktree explicitly, in the form that rule prescribes — the hook now refuses an untargeted call. The session's working directory is the `master` checkout, so a careless invocation reviews the wrong tree — and once wrote eight files of edits into `master`. Afterwards, check every worktree is still clean, not just the target.

Findings are candidates: verify each against the code, apply the ones that hold, and say which you declined and why — after a fresh judge has ruled on each decline (`@.claude/rules/code-review.md`).

Some diffs then get the second read, on the code with those findings applied. `@.claude/rules/code-review.md` says which, and why it is not a second full review.

Review before **manual testing**, not after, because a finding can change what there is to test.

### Manual testing gates the PR (8)

**Do not open a PR until the maintainer has tested the change** (dev tooling: its `qa` agent, below). Hardware, sim and deck-host behaviour are not knowable from the diff, and a PR opened before testing is one the maintainer may have to unwind.

**Dev tooling is tested by the issue's `qa` agent instead** (Niklas, 2026-10-30: "Yes, agents test tooling", #1532). When the manual test is commands and their output — Claude Code hooks, repo scripts, the commit hook, build or CI tooling — `qa` runs the script end to end for real: the real commands, the real hook firing in a live session, real commits, not the unit harness, with evidence per step. Its pass is the manual-test pass, at the head sha it ran against. An agent runs such steps more exactly than a person, and a by-hand run misleads easily: #1526's hook test, run in a plain terminal where no Claude Code hook fires, read as a failure. Anything Niklas sees or hears — a deck, the sim, the settings window, the website, clips, icons — stays his test, on a tooling issue too.

For a change with nothing runnable to test — a website or other user-facing docs change — the gate does not disappear, it changes shape: show the drafted text **in full** and get it approved before opening the PR. "There was nothing to test" is not an exemption. Rule and `CLAUDE.md` prose is the one exception: it is written for Claude, and its size is held by the budget test and the architecture reviews, so it needs no draft approval.

Once the test passes, the issue lead pushes and opens the PR without asking. In the integration build (`scripts/integration-build.mjs`) he passes or fails each issue, and the pass belongs to the issue at the head sha the build merged.

### Babysit the review (10)

CodeRabbit is the reviewer. **Do not wait for a human code review** — the maintainer is the tester and the approver, not a second reviewer.

Poll the PR, fix every finding **that holds — nitpicks included**, and answer every thread: cite the fix commit where you applied it, the reasoning where you did not. Expect a fresh review after every push that is not a pure rebase (CodeRabbit does not review a rebase); a clean incremental one only updates its summary comment. A summary that says CodeRabbit was **rate limited** means the follow-up was not reviewed: wait for the limit to reset, then ask `@coderabbitai review`. Stop polling once the review is done.

Nitpicks are in scope precisely because they are the ones it is tempting to wave through; "it's only a nitpick" is not a reason to skip one, and it is not a reason to apply one that is wrong either.

**Rejecting a finding is a normal outcome.** A review can be confidently wrong, or right in general and wrong for this project. Reject it in the thread with the reasoning stated, once the judge has upheld the rejection — the same standard `@.claude/rules/code-review.md` sets for the local reviewer. What is not acceptable is silently ignoring one.

One trap with no other home: `gh pr checks` exits non-zero (8) while any check is still pending, so a non-zero exit there is not a failure.

### Merging (11)

Once CodeRabbit has approved and the checks are green, **the issue lead merges** — the maintainer is not a second reviewer to wait for. A *review* step never merges; that separation is what `@.claude/rules/build-and-commit.md` protects, and it owns the merge mechanics. Merging includes the issue's Roadmap card moving to `Testing` — the post-merge hook does that and reports when it could not, in which case make the move by hand (#1065, 2026-09-05); `@.claude/rules/build-and-commit.md` has the lanes.

**An approval and a green check are both head-specific.** Neither travels with a push, while the PR still displays the old approval beside the new head, so the merge hook judges both at the **current** head (`@.claude/rules/hooks.md` has what it accepts in place of a fresh review). Each refusal names the condition that failed and what to add or ask for. A `mergeStateStatus` of `BLOCKED` while you believe everything is green means the hook will refuse.

Issue work reaches a target branch only through an approved PR. Two documented paths do not: a maintainer-directed **Master** work mode, and a release **back-merge**. Neither is an excuse to skip the PR on issue work.

### The merge is not finished until the post-merge run is (12)

Since #1070 every CI workflow also runs on pushes to `master` and `release/*` — the only thing that ever checks the tree a squash-merge actually produces. That signal is worth nothing if nobody is looking at it, which is how a new check gets added and quietly ignored. A push that changes only spec documents (`docs/superpowers/specs/**.md`) runs none of them (#1466): no step reads a spec, and the one that scanned them, the control-byte test, runs on staged specs in the husky pre-commit hook instead (`scripts/check-staged-spec-bytes.mjs`). A merge always carries code, so it always gets all four.

**Niklas owns a red master.** The agent that merged is the instrument that watches and reports; it does not own the outcome and does not decide what to do about one.

- **Whoever merges watches all four runs to completion.** Start the watch from the `master` checkout, not from the worktree — a `gh run list` loop whose cwd is the tree you remove in step 13 dies with "not a git repository" and the watch ends unnoticed. `ci-format`, `ci-lint`, `ci-test` and `ci-typecheck` are four separate workflows on the same push, so one green run answers for one of them and nothing else — and the first thing to check is that all four appeared at all (the post-merge hook lists them). Pressing the merge button does not end the step.
- **A red result goes to the PO immediately, and the PO takes it to Niklas.** No agent decides on its own to fix it, revert it, or let it stand.
- **If the merging session ends before the run finishes, the watch passes to the PO** — the one party that outlives an issue lead.

There is deliberately no flake caveat here. `gh run list` reports a run at its latest attempt, so a failure that passed on a re-run counts as a success — a green history (58 of 60 `ci-test` runs on 2026-09-01, while #1088's flake hid inside it twice) is evidence that the instrument cannot tell, not that reds are usually spurious. Treat a red as real until shown otherwise, and re-run to diagnose rather than to clear.

Then remove the worktree — unless a deck host is linked to it. **Never relink a host on your own, not even back to `master`** (Niklas, 2026-09-25): the link is his to point, and a relink swaps the plugin out from under whatever he or another session is testing. Leave the link and the worktree as they are and tell him; removing the tree under a live link would silently break his installed plugin, which is why the hook refuses it.
