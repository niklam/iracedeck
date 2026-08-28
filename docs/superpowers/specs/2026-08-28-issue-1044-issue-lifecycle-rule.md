# The issue lifecycle belongs in one file, gates included

> **Issue:** [#1044](https://github.com/niklam/iracedeck/issues/1044) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Every step of working an issue here is already documented. The **order** is not, and neither is the fact that some steps are gates rather than suggestions.

`specs-and-plans.md` says a spec is written and where it goes. `build-and-commit.md` says work happens in a worktree and how commits are shaped. `code-review.md` says which level to pick. `changelog.md` says when release notes are required. `website-action-docs.md` says what an action page looks like. Read all five and an agent still cannot tell:

- whether a code review comes before or after manual testing,
- whether a PR may be opened before the maintainer has tested,
- whether website documentation is part of the change or a follow-up,
- what happens when a review finding is wrong,
- who is allowed to merge, and on what evidence.

Those are the questions that cost round trips, and they are invisible until late. An agent that skips the manual-testing gate does not produce a wrong diff — it produces a PR the maintainer has to unwind.

The repo now runs several agents on issues in parallel, so "it was explained in the session" no longer reaches everyone who needs it.

## Decision

**One new rule file, `.claude/rules/issue-workflow.md`, holding the ordered pipeline and nothing else.** Each step states the gate and links to the rule that owns its detail. The step's detail is NOT restated — a second copy of the code-review level table would drift from the first within a month, and the drift would be silent.

The pipeline, in order:

1. File the issue — assigned to the maintainer, on the latest open milestone unless directed otherwise.
2. Spec committed straight to `master`, its own `docs(specs)` commit.
3. Worktree at `../ir-<issue>`, sibling to the repo.
4. Build, lint and test by hand — no watcher runs here.
5. Every applicable rule followed; the thorough design preferred over the quick win.
6. User-facing functionality documented on the website in the same change.
7. `code-review <level> ../ir-<issue>` proposed, and run, **before** manual testing.
8. Manual testing gates the PR.
9. Commit, push, open the PR.
10. Babysit the review: poll, fix everything including nitpicks, reply to every thread, reject with reasons where a finding is wrong.
11. Merge once the review is complete.

Three points inside that are decisions rather than transcription, and the rule states each with its reason.

**Specs stay the one exception to "everything through a PR."** The general rule is that nothing reaches a target branch except through a PR with CodeRabbit's approval. Specs are carved out, and the carve-out is deliberate: `specs-and-plans.md` gives three reasons — a spec committed on a `release/*` branch reaches `master` weeks late via back-merge, a spec on an abandoned branch dies with the branch, and a file that only ever changes on one branch can never conflict. A fourth follows from step 7: the spec is the document a reviewer needs in order to judge whether the implementation matches the intent, so it must be readable before the PR exists rather than inside it. Keeping the exception costs one sentence of explanation; removing it would cost all four properties.

**The manual-testing gate changes shape; it never disappears.** Most work has something to run, and the maintainer runs it before a PR exists. A rules-or-docs-only change has nothing runnable — but the gate is not therefore waived, because the thing at risk is the same either way: wording the maintainer has not seen becoming binding. For those changes the gate is that the drafted text is shown in full and approved before any PR is opened. Stating this explicitly is what stops "there was nothing to test" from becoming a general-purpose exemption.

**Review findings are candidates, and rejecting one is a normal outcome.** The rule records that an agent may reject a finding that is wrong or that conflicts with the project's principles, provided it says so with reasoning in the thread. Without that, an agent treats every finding as an instruction and will "fix" deliberate behavior — which `code-review.md` already warns about for the local reviewer, and which applies equally to CodeRabbit.

## Alternatives rejected

**Spread the steps across the five existing rule files.** Each step would sit next to its detail, which is tidy. Rejected because the ordering and the gates are exactly what is lost when the sequence is distributed — and the ordering is the entire problem. There would still be no page that answers "what do I do next".

**Put the pipeline in `.claude/CLAUDE.md`.** That file loads in full for every session, so a page of process there is paid for on every turn of every task, including ones that never touch an issue. It already delegates topic detail to `.claude/rules/` and should keep doing so; it takes a one-line index entry instead.

**Encode it as a checklist in the PR template.** It would be seen at the wrong moment — the template is read when opening the PR, which is after four of the gates have already been passed or missed. A PR-template checklist is a reasonable *addition* later, but it cannot be the primary home.

**Leave it as conversational guidance.** It does not survive a new session and does not reach the other agents at all, which is the failure this issue was filed about.

## Consequences

An agent picking up an issue has one page to read first, and the maintainer has one page to point at when an agent deviates. The five detailed rules are unchanged; the new file only sequences them.

The obvious risk is drift: a pipeline file restating detail would fall out of step with the rules that own it. The mitigation is structural rather than diligent — the new file states each step in a sentence and links out, so there is nothing in it *to* drift except the order, and the order is what it exists to hold.

The pipeline also encodes a division of labour that only recently became true: CodeRabbit is the reviewer, and the maintainer is the tester and the approver. An agent that waits for a human code review after CodeRabbit has approved is waiting for something that is not coming.

## Verification

`.claude/CLAUDE.md` lists the new file in its rule index with a one-line summary, matching the style of the existing entries. `pnpm format:fix` leaves the file unchanged (Prettier owns markdown here), `pnpm lint` and `pnpm test` stay green — this change touches no source, so the suite is a regression check rather than a proof.

The real verification is the next issue: it should be possible to work it start to finish from this one file plus the rules it links, without asking which step comes next.
