# Issue Workflow

The order an issue is worked in, and which steps are gates.

This file owns the **sequence**, the **gates**, and **why each gate exists** — nothing else. How to perform a step belongs to the rule that owns it, linked in the table. Keeping mechanics out is what stops this file drifting from the five rules it sequences.

If you are picking up an issue, read this first.

## The pipeline

| #   | Step                                                       | Gate                    | Detail                                                                     |
| --- | ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| 1   | File the issue                                             | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 2   | Write the spec, commit to `master`                         | unless exempt           | `@.claude/rules/specs-and-plans.md`                                         |
| 3   | Create the worktree `../ir-<issue>`                        | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 4   | Implement, committing as you go                            | —                       | the topic rules for what you touched                                        |
| 5   | `install` → `build` → `typecheck` → `format` → `lint` → `test`, by hand | all green    | `@.claude/rules/testing.md`, `@.claude/rules/code-style.md`                  |
| 6   | Document it on the website                                 | required if user-facing | `@.claude/rules/website-action-docs.md`, `@.claude/rules/changelog.md`       |
| 7   | **Ask** to run the code review, then run it                | the ask                 | `@.claude/rules/code-review.md`                                             |
| 8   | Manual testing                                             | **blocks the PR**       | below                                                                       |
| 9   | Push, open the PR                                          | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 10  | Babysit the review                                         | every thread answered   | below                                                                       |
| 11  | Merge                                                      | approved + checks green **at the current head** | `@.claude/rules/build-and-commit.md`                    |
| 12  | Watch **all four** post-merge runs to completion           | a red result goes to the coordinator            | below                                                   |
| 13  | Remove the worktree                                        | —                                               | `@.claude/rules/build-and-commit.md`                    |

## Why these gates exist

### Milestone and assignee wait for implementation (1)

Filing an issue does not assign it or milestone it. Both are signals that work is *starting*, not that an idea has been captured — so they go on when the issue is picked up, alongside the worktree, not when it is written.

Filing early and often is the point: an issue is a place to put a decision so it stops living in a conversation. Milestoning it at that moment makes a promise about a release nobody has planned yet, and assigning it makes a promise about who is doing it. A backlog of unassigned, unmilestoned issues is the correct shape for work that is understood but not scheduled.

Labels are different — the issue templates apply `bug` / `enhancement` automatically, and those stay. Do not add `type:` labels to issues; those are for PRs, where they drive release notes.

### The spec is the one thing that does not go through a PR (2)

Where a spec is required — `@.claude/rules/specs-and-plans.md` lists the exemptions — it goes straight to `master` as its own commit, and never on the branch implementing it. That rule gives three reasons. A fourth belongs here, because it is about this sequence: step 7 needs the spec readable **before** the PR exists, since it is what tells a reviewer whether the implementation matches the intent.

### Issues are worked in a worktree (3)

Settled by the maintainer: an issue is solved in a sibling worktree, never inside the repo directory, and you do not need to ask which mode to use for issue work. The three-way question in `@.claude/rules/build-and-commit.md` still governs work that is **not** an issue, and the maintainer can direct otherwise at any time.

### Nothing verifies your work but you (5)

**Assume nothing is watching, confirm, then run everything yourself.** The repo does ship watchers and one may be running against a linked worktree, so check before firing a full build into a tree something else is writing.

The green set is the CI set plus the pre-commit checks: `install`, `build`, `typecheck`, `format`, `lint`, `test`. CI runs format, lint and test as **separate** jobs, so a clean `lint` proves nothing about `format`. Read the build output rather than its exit code — `@.claude/rules/build-and-commit.md` explains why that distinction bites here.

**A green PR check is not a statement about the merged result.** It proves something about your branch merged against the master that existed when the check ran. Under squash-merge the commit that lands is a tree nothing has ever built or tested, and when two PRs are in flight the gap opens silently — both green, the merge textually clean, and nothing red anywhere to notice. Since #1070 all four CI workflows also run on pushes to `master` and `release/*`, so the merged result is checked too — but *after* the merge, not before it. That is what step 12 is for.

### If a user can see it, the website describes it (6)

A feature that ships undocumented is a feature nobody finds. Website documentation is part of the change, in the same PR — not a follow-up issue. Same for the changelog when the change is user-facing.

### Prefer the thorough solution (4)

SOLID over quick wins. A shortcut that leaves tech debt is not a saving; it is a loan against the next person to open the file. When the thorough option costs materially more, say so and let the maintainer choose — do not make that trade silently.

### The code review: the ask is the gate, and you run it (7)

Ask whether to run it, naming the level and which row of the table in `@.claude/rules/code-review.md` the change landed in. **On a yes, you run it** — the ask is the gate, not the execution.

Target the worktree explicitly, in the form that rule prescribes. The session's working directory is the `master` checkout, so a careless invocation reviews the wrong tree — and once wrote eight files of edits into `master`. Afterwards, check every worktree is still clean, not just the target.

Findings are candidates: verify each against the code, apply the ones that hold, and say which you declined and why.

Review before **manual testing**, not after, because a finding can change what there is to test.

### Manual testing gates the PR (8)

**Do not open a PR until the maintainer has tested the change.** Hardware, sim and deck-host behaviour are not knowable from the diff, and a PR opened before testing is one the maintainer may have to unwind.

For a change with nothing runnable to test — a rules or docs change — the gate does not disappear, it changes shape: show the drafted text **in full** and get it approved before opening the PR. The thing at risk is the same either way, wording the maintainer has not seen becoming binding. "There was nothing to test" is not an exemption.

### Babysit the review (10)

CodeRabbit is the reviewer. **Do not wait for a human code review** — the maintainer is the tester and the approver, not a second reviewer.

Poll the PR, fix every finding **that holds — nitpicks included**, and answer every thread: cite the fix commit where you applied it, the reasoning where you did not. Expect a fresh review after every push. Stop polling once the review is done.

Nitpicks are in scope precisely because they are the ones it is tempting to wave through; "it's only a nitpick" is not a reason to skip one, and it is not a reason to apply one that is wrong either.

**Rejecting a finding is a normal outcome.** A review can be confidently wrong, or right in general and wrong for this project. Reject it in the thread with the reasoning stated — the same standard `@.claude/rules/code-review.md` sets for the local reviewer. What is not acceptable is silently ignoring one.

One trap with no other home: `gh pr checks` exits non-zero (8) while any check is still pending, so a non-zero exit there is not a failure.

### Merging (11)

Once CodeRabbit has approved and the checks are green, **the agent driving the work merges** — the maintainer is not a second reviewer to wait for. A *review* step never merges; that separation is what `@.claude/rules/build-and-commit.md` protects, and it owns the merge mechanics.

**An approval and a green check are both head-specific, and both are re-verified at the moment of merging.** Neither travels with the branch — a push invalidates both, while the PR still displays the old approval beside the new head. Compare the approving review's `commit_id` against the PR's `headRefOid`, and read the check states for that same sha. What a stale read looks like is not an obvious error: it is a *real* approval and a *real* all-green that belong to the previous head. The PR's own `mergeStateStatus` is a cheap cross-check — `BLOCKED` while you believe everything is green means you are reading the wrong head. And `gh pr checks` exits non-zero (8) while anything is still pending, so treat that exit as "not finished", never as "failed".

Issue work reaches a target branch only through an approved PR. Two documented paths do not: a maintainer-directed **Master** work mode, and a release **back-merge**. Neither is an excuse to skip the PR on issue work.

### The merge is not finished until the post-merge run is (12)

Since #1070 every CI workflow also runs on pushes to `master` and `release/*` — the only thing that ever checks the tree a squash-merge actually produces. That signal is worth nothing if nobody is looking at it, which is how a new check gets added and quietly ignored.

**Niklas owns a red master.** The agent that merged is the instrument that watches and reports; it does not own the outcome and does not decide what to do about one.

- **Whoever merges watches all four runs to completion.** `ci-format`, `ci-lint`, `ci-test` and `ci-typecheck` are four separate workflows on the same push, so one green run answers for one of them and nothing else — and the first thing to check is that all four appeared at all. Pressing the merge button does not end the step.
- **A red result goes to the coordinator immediately, and the coordinator takes it to Niklas.** No agent decides on its own to fix it, revert it, or let it stand.
- **If the merging session ends before the run finishes, the watch passes to the coordinator** — the one party that outlives a worker session.

There is deliberately no flake caveat here. Measured on 2026-09-01, the last 60 `ci-test` runs were 58 successes, one `action_required`, and one genuine test failure on a development branch — first attempt, fixed by later commits rather than by a re-run. On that evidence a red run means something, so treat one as real until shown otherwise, not the other way round. One flake has since been observed, on 2026-09-01, in `settings-store.test.ts` — the instruction is unchanged, because treating that red as real is what identified it.

Then remove the worktree — and if a deck host is linked to it, relink to `master` first, or you will silently break the maintainer's installed plugin.
