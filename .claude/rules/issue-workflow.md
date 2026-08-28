# Issue Workflow

The order an issue is worked in, and which steps are gates.

This file owns the **sequence**, the **gates**, and **why each gate exists** — nothing else. How to perform a step belongs to the rule that owns it, linked in the table. Keeping mechanics out is what stops this file drifting from the five rules it sequences.

If you are picking up an issue, read this first.

## The pipeline

| #   | Step                                                       | Gate                    | Detail                                                                     |
| --- | ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| 1   | File the issue, assign it, milestone it                    | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 2   | Write the spec, commit to `master`                         | unless exempt           | `@.claude/rules/specs-and-plans.md`                                         |
| 3   | Create the worktree `../ir-<issue>`                        | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 4   | Implement, committing as you go                            | —                       | the topic rules for what you touched                                        |
| 5   | `install` → `build` → `format` → `lint` → `test`, by hand  | all green               | `@.claude/rules/testing.md`, `@.claude/rules/code-style.md`                  |
| 6   | Document it on the website                                 | required if user-facing | `@.claude/rules/website-action-docs.md`, `@.claude/rules/changelog.md`       |
| 7   | **Ask** to run the code review, then run it                | the ask                 | `@.claude/rules/code-review.md`                                             |
| 8   | Manual testing                                             | **blocks the PR**       | below                                                                       |
| 9   | Push, open the PR                                          | —                       | `@.claude/rules/build-and-commit.md`                                        |
| 10  | Babysit the review                                         | every thread answered   | below                                                                       |
| 11  | Merge                                                      | approved + checks green | `@.claude/rules/build-and-commit.md`                                        |
| 12  | Remove the worktree                                        | —                       | `@.claude/rules/build-and-commit.md`                                        |

## Why these gates exist

### Assign it and milestone it (1)

To the maintainer, and to the milestone of **the next unreleased version** — not necessarily the newest-created or nearest-due one, since versions here do not always run in creation order (1.24 was skipped for 2.0). An unassigned, unmilestoned issue is invisible in release planning.

### The spec is the one thing that does not go through a PR (2)

Where a spec is required — `@.claude/rules/specs-and-plans.md` lists the exemptions — it goes straight to `master` as its own commit, and never on the branch implementing it. That rule gives three reasons. A fourth belongs here, because it is about this sequence: step 7 needs the spec readable **before** the PR exists, since it is what tells a reviewer whether the implementation matches the intent.

### Issues are worked in a worktree (3)

Settled by the maintainer: an issue is solved in a sibling worktree, never inside the repo directory, and you do not need to ask which mode to use for issue work. The three-way question in `@.claude/rules/build-and-commit.md` still governs work that is **not** an issue, and the maintainer can direct otherwise at any time.

### Nothing verifies your work but you (5)

**Assume nothing is watching, confirm, then run everything yourself.** The repo does ship watchers and one may be running against a linked worktree, so check before firing a full build into a tree something else is writing.

The green set is the CI set plus the pre-commit checks: `install`, `build`, `format`, `lint`, `test`. CI runs format, lint and test as **separate** jobs, so a clean `lint` proves nothing about `format`. Read the build output rather than its exit code — `@.claude/rules/build-and-commit.md` explains why that distinction bites here.

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

Poll the PR, fix every finding **that holds — nitpicks included**, and reply to every thread citing the fix commit. Expect a fresh review after every push. Stop polling once the review is done.

Nitpicks are in scope precisely because they are the ones it is tempting to wave through; "it's only a nitpick" is not a reason to skip one, and it is not a reason to apply one that is wrong either.

**Rejecting a finding is a normal outcome.** A review can be confidently wrong, or right in general and wrong for this project. Reject it in the thread with the reasoning stated — the same standard `@.claude/rules/code-review.md` sets for the local reviewer. What is not acceptable is silently ignoring one.

One trap with no other home: `gh pr checks` exits non-zero (8) while any check is still pending, so a non-zero exit there is not a failure.

### Merging (11)

Once CodeRabbit has approved and the checks are green, **the agent driving the work merges** — the maintainer is not a second reviewer to wait for. A *review* step never merges; that separation is what `@.claude/rules/build-and-commit.md` protects, and it owns the merge mechanics.

Issue work reaches a target branch only through an approved PR. Two documented paths do not: a maintainer-directed **Master** work mode, and a release **back-merge**. Neither is an excuse to skip the PR on issue work.

Then remove the worktree — and if a deck host is linked to it, relink to `master` first, or you will silently break the maintainer's installed plugin.
