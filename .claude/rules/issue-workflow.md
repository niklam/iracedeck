# Issue Workflow

The order an issue is worked in, and which steps are gates. Every step's *detail* lives in another rule; this file owns only the **sequence** and the **gates**, so it stays short and cannot drift.

If you are picking up an issue, read this first.

## The pipeline

| # | Step | Gate | Detail |
|---|------|------|--------|
| 1 | File the issue, assign it, milestone it | — | `build-and-commit.md` (affected-artifacts list) |
| 2 | Write the spec, commit to `master` | unless exempt | `specs-and-plans.md` |
| 3 | Create the worktree `../ir-<issue>` | — | `build-and-commit.md` |
| 4 | Implement, committing as you go | — | the topic rules for what you touched |
| 5 | `install` → `build` → `format` → `lint` → `test`, **by hand** | all green | `testing.md`, `code-style.md` |
| 6 | Document it on the website | required if user-facing | `website-action-docs.md`, `changelog.md` |
| 7 | **Ask** to run the code review, then run it | the ask | `code-review.md` |
| 8 | Manual testing | **blocks the PR** | below |
| 9 | Push, open the PR | — | `build-and-commit.md` |
| 10 | Babysit the review | every thread answered | below |
| 11 | Merge | CodeRabbit approved + checks green | below |
| 12 | Remove the worktree | — | `build-and-commit.md` |

## The parts that are decisions, not bookkeeping

### Assign it and milestone it (1)

Assign the issue to the maintainer, and to the milestone of **the next unreleased version** — not necessarily the newest-created or nearest-due one, since versions here do not always run in creation order (1.24 was skipped for 2.0). An unassigned, unmilestoned issue is invisible in release planning.

### The spec is the one thing that does not go through a PR (2)

Where a spec is required (`specs-and-plans.md` exempts bug reports, documentation and typo fixes, dependency bumps, and hygiene sweeps — and a bug whose fix involves a real design choice is *not* exempt), it is committed straight to `master` as its own `docs(specs): … (#N)` commit, and **never** on the branch implementing it.

Four reasons, three of them in `specs-and-plans.md`: a spec committed on a `release/*` branch reaches `master` weeks late via back-merge; a spec on an abandoned branch dies with the branch; a file that only ever changes on one branch can never conflict; and step 7 needs it readable *before* the PR exists, because it is what tells a reviewer whether the implementation matches the intent.

### Issues are worked in a worktree (3)

Settled by the maintainer: an issue is solved in a sibling worktree `../ir-<issue>`, never inside the repo directory. You do not need to ask which mode to use for issue work.

`build-and-commit.md`'s three-way question — worktree, branch, or master — still governs work that is **not** an issue, and the maintainer can still direct otherwise. Verify the worktree's base commit when you create it: a stale `origin/master` silently branches you behind, and it surfaces much later as a PR conflict.

### Nothing verifies your work but you (5)

**Assume nothing is watching, confirm, then run everything yourself.** The repo does ship watchers (`pnpm dev`, `watch:stream-deck`, `test:watch`) and one may be running against a linked worktree — so check before firing a full build into a tree something else is writing.

The green set is the CI set plus the pre-commit checks: `pnpm install`, `pnpm build`, `pnpm format`, `pnpm lint`, `pnpm test`. CI runs the last four as separate jobs, so a clean `lint` proves nothing about `format`.

Two traps that have cost real time: `pnpm build` catches type errors `pnpm test` does not (Vitest's esbuild path is more permissive than `tsc`), and `pnpm build | tail` reports tail's exit code, so a failed build reads as success unless you `set -o pipefail`.

### If a user can see it, the website describes it (6)

A feature that ships undocumented is a feature nobody finds. Website documentation is part of the change, in the same PR — not a follow-up issue. Same for the changelog when the change is user-facing (`changelog.md`, including `pnpm generate:changelog-data`).

### Prefer the thorough solution (4)

SOLID over quick wins. A shortcut that leaves tech debt is not a saving; it is a loan against the next person to open the file. When the thorough option costs materially more, say so and let the maintainer choose — do not make that trade silently.

### The code review: the ask is the gate, and you run it (7)

Ask *"Should we run the code review agent for these changes?"*, naming the level from the table in `code-review.md` and which row the change landed in. **On a yes, you run it** — the ask is the gate, not the execution.

Invoke it with the **absolute** path and an explicit SCOPE block, exactly as `code-review.md` prescribes. The session's working directory is the `master` checkout, so a bare or relative invocation reviews the wrong tree — and in the recorded incident wrote eight files of edits into `master`. Afterwards, check `git status --porcelain` in **every** worktree, not just the target.

It is **report-only** — never `--fix`. Findings are candidates: verify each against the code, apply the ones that hold, and say which you declined and why.

Review before testing, not after, because a finding can change what there is to test.

### Manual testing gates the PR (8)

**Do not open a PR until the maintainer has tested the change.** Hardware, sim and deck-host behaviour are not knowable from the diff, and a PR opened before testing is one the maintainer may have to unwind.

For a change with nothing runnable to test — a rules or docs change — the gate does not disappear, it changes shape: show the drafted text **in full** and get it approved before opening the PR. The thing at risk is the same either way, wording the maintainer has not seen becoming binding. "There was nothing to test" is not an exemption.

### Babysit the review (10)

CodeRabbit is the reviewer. **Do not wait for a human code review** — the maintainer is the tester and the approver, not a second reviewer.

Poll the PR, fix every finding **including nitpicks**, and reply to every thread citing the fix commit. Expect a fresh review after every push. Stop polling once the review is done.

**Rejecting a finding is a normal outcome.** A review can be confidently wrong, or right in general and wrong for this project. Reject it in the thread with the reasoning stated — the same standard `code-review.md` sets for the local reviewer. What is not acceptable is silently ignoring one.

One trap worth knowing before you write a polling loop: `gh pr checks` exits non-zero (8) while any check is still pending, so a non-zero exit there is not a failure and `$(gh pr checks … || echo '[]')` will concatenate the fallback onto valid output.

### Merging (11)

Once CodeRabbit has approved and the checks are green, **the agent driving the work merges** — the maintainer is not a second reviewer to wait for. A *review* step never merges; that separation is what `build-and-commit.md` protects.

Feature and fix PRs are **squash-merged**, so the PR title becomes the commit message — `<type>(<scope>): <description> (#<issue>)`. Branch-to-branch merges (release back-merges) are **not** squashed; see `build-and-commit.md` for why.

Issue work reaches a target branch only through an approved PR. Two documented paths do not: a maintainer-directed **Master** work mode, and a release **back-merge**, which forwards already-reviewed commits and may be done locally. Neither is an excuse to skip the PR on issue work.

Then remove the worktree — and if a deck host is linked to it, relink to `master` first, or you will silently break the maintainer's installed plugin.
