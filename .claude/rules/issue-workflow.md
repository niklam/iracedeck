# Issue Workflow

The order an issue is worked in, and which steps are gates. Every step's *detail* lives in another rule; this file owns only the **sequence** and the **gates**, so it stays short and cannot drift.

If you are picking up an issue, read this first.

## The pipeline

| # | Step | Gate | Detail |
|---|------|------|--------|
| 1 | File the issue | — | `build-and-commit.md` (affected-artifacts list) |
| 2 | Write the spec, commit to `master` | — | `specs-and-plans.md` |
| 3 | Create the worktree `../ir-<issue>` | — | `build-and-commit.md` |
| 4 | Implement | — | the topic rules for what you touched |
| 5 | Build, lint, test **by hand** | must be green | `testing.md`, `code-style.md` |
| 6 | Document it on the website | required if user-facing | `website-action-docs.md`, `changelog.md` |
| 7 | Ask to run `code-review <level> ../ir-<issue>` | **maintainer runs it** | `code-review.md` |
| 8 | Manual testing | **blocks the PR** | below |
| 9 | Commit, push, open the PR | — | `build-and-commit.md` |
| 10 | Babysit the review | every thread answered | below |
| 11 | Merge | CodeRabbit approved + checks green | `build-and-commit.md` |
| 12 | Remove the worktree | — | `build-and-commit.md` |

## The parts that are decisions, not bookkeeping

### Assign it (step 1)

Assign the issue to the maintainer and to the **latest open milestone**, unless told otherwise. An unassigned, unmilestoned issue is invisible in release planning.

### The spec is the one thing that does not go through a PR (step 2)

Everything else reaches a target branch only through a PR. A spec is committed straight to `master` as its own `docs(specs): … (#N)` commit, and **never** on the branch implementing it. Four reasons, three of them in `specs-and-plans.md`: a spec committed on a `release/*` branch reaches `master` weeks late via back-merge; a spec on an abandoned branch dies with the branch; a file that only ever changes on one branch can never conflict; and step 7 needs it readable *before* the PR exists, because it is what tells a reviewer whether the implementation matches the intent.

### Nothing verifies your work but you (step 5)

**There is no watcher running.** `pnpm build`, `pnpm lint`, `pnpm test` — run them yourself, in the worktree, and read the output. Two traps that have cost real time here: `pnpm build` catches type errors `pnpm test` does not (Vitest's esbuild path is more permissive than `tsc`), and `pnpm build | tail` reports tail's exit code, so a failed build reads as success unless you `set -o pipefail`.

### If a user can see it, the website describes it (step 6)

A feature that ships undocumented is a feature nobody finds. Website documentation is part of the change, in the same PR — not a follow-up issue. Same for the changelog when the change is user-facing (`changelog.md`, including `pnpm generate:changelog-data`).

### Prefer the thorough solution (step 4)

SOLID over quick wins. A shortcut that leaves tech debt is not a saving; it is a loan against the next person to open the file. When the thorough option costs materially more, say so and let the maintainer choose — do not make that trade silently.

### Code review comes before manual testing (step 7)

Propose the level from the table in `code-review.md` and say which row the change landed in. Point it at the worktree, not `master`. It is **report-only** — never `--fix`. Findings are candidates: verify each against the code, apply the ones that hold, and say which you declined and why.

Review before testing, not after, because a review finding can change what there is to test.

### Manual testing gates the PR (step 8)

**Do not open a PR until the maintainer has tested the change.** Hardware behaviour, sim behaviour and deck-host behaviour are not knowable from the diff, and a PR opened before testing is one the maintainer may have to unwind.

For a change with nothing runnable to test — a rules or docs change — the gate does not disappear, it changes shape: show the drafted text **in full** and get it approved before opening the PR. The thing at risk is the same either way, wording the maintainer has not seen becoming binding. "There was nothing to test" is not an exemption.

### Babysit the review (step 10)

CodeRabbit is the reviewer. **Do not wait for a human code review** — the maintainer is the tester and the approver, not a second reviewer.

Poll the PR, fix every finding **including nitpicks**, and reply to every thread citing the fix commit. Expect a fresh review after every push. Stop polling once the review is done.

**Rejecting a finding is a normal outcome.** A review can be confidently wrong, or right in general and wrong for this project. Reject it in the thread with the reasoning stated — the same standard `code-review.md` sets for the local reviewer. What is not acceptable is silently ignoring one.

Recovery paths for a stalled or rate-limited review, and the shape of CodeRabbit's comment bodies, are worth knowing before you start; they are the kind of thing that otherwise reads as "the bot is thinking" for an hour.

### Merging (step 11)

Nothing reaches `master` or a `release/*` branch except through a PR that CodeRabbit has approved with checks green. Feature and fix PRs are **squash-merged**, so the PR title becomes the commit message — `<type>(<scope>): <description> (#<issue>)`. Branch-to-branch merges (release back-merges) are **not** squashed; see `build-and-commit.md` for why.

Then remove the worktree — and if a deck host is linked to it, relink to `master` first, or you will silently break the maintainer's installed plugin.
