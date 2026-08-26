# Design specs

This directory holds the design records behind iRaceDeck features — the reasoning that a diff can't carry: what was considered, what was rejected, and which constraints were load-bearing.

## For contributors: you don't need to write one

**Nothing here is expected of you.** Issues and pull requests from outside the maintainer team are never held to this — no reviewer will ask you for a spec, and its absence will never block a PR. This is an internal working practice, published because the reasoning is useful to read, not because it's a submission requirement.

If you're looking for how to contribute or how the plugin is put together, start with the repository [`README.md`](../../README.md) and the [developer documentation](https://iracedeck.com/docs/development/architecture/).

## What a spec is — and is not

A spec is a **point-in-time record**. It describes a decision as it was made, against the codebase as it was then. It is deliberately **not** updated to track the code afterwards.

So when a spec and the code disagree, **the code wins**. The living documentation is the source itself, the `.claude/rules/` files, and the [product documentation](https://iracedeck.com/docs/).

Each spec's header links the issue it belongs to. There is no status field: whether the work shipped is answered by that issue being open, closed, or closed as not planned. If a decision is later reversed, a new spec supersedes the old one and both carry a pointer to the other — specs are not rewritten after the work ships.

## Naming

```text
specs/YYYY-MM-DD-issue-<N>-<topic>.md
```

Specs written before August 2026 predate this convention and vary — most lack the issue number, and several carry a `-design` suffix. They were left as they are, because renaming them would break links published in issue threads and the spec paths cited from source-code comments.

## `plans/` is intentionally empty

Implementation plans — the step-by-step routes used while building a feature — are written for every implementation but are **not committed**. A plan's value expires when its pull request merges: after that the code is the truth, while the plan still describes a route through a tree that has moved.

42 historical plans were removed in #621. Every one remains in git history:

```bash
git show 888658d8:docs/superpowers/plans/2026-08-08-gap-support.md
```

## The policy itself

[`specs/2026-08-25-issue-621-process-docs-policy.md`](specs/2026-08-25-issue-621-process-docs-policy.md) records why this directory works the way it does, with the evidence and the alternatives that were rejected. The operative rules live in [`.claude/rules/specs-and-plans.md`](../../.claude/rules/specs-and-plans.md).
