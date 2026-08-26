# Design Specs & Implementation Plans (#621)

Two artifacts come out of the brainstorming/planning workflow, and they have opposite lifetimes. Getting them mixed up is what #621 was filed about.

| Artifact | Lives at | Committed? | Lifetime |
| --- | --- | --- | --- |
| **Spec** — the design decision | `docs/superpowers/specs/YYYY-MM-DD-issue-<N>-<topic>.md` | Yes — **to `master`, always** | Durable. Cited by rules, `CLAUDE.md` files, and source comments. |
| **Plan** — the route through the code | `docs/superpowers/plans/` | **Never** — gitignored | Expires when the PR merges. |

A spec ages well because it records a *decision*; a plan ages badly because it records a *route through a tree that has since moved*. Full reasoning and the rejected alternatives: `docs/superpowers/specs/2026-08-25-issue-621-process-docs-policy.md`, which is also the worked example of the format below.

## Which issues get a spec

**Every feature or enhancement issue we file.** Write it as part of filing the issue, not later.

Exempt: bug reports, documentation/typo fixes, dependency bumps, and batch or hygiene sweeps across many issues. A bug whose fix involves a genuine design choice gets one anyway.

This is required for **maintainer-authored** work. Outside contributors are never expected to produce a spec — don't ask for one in a review, and don't hold a PR on its absence. That is why this policy lives here and in `CLAUDE.md` rather than in a contributing guide.

## Order of operations

```text
file the issue  ->  get its number  ->  write the spec named with it
                ->  commit to master ->  add the master permalink to the issue body
```

The **issue** carries what and why: problem, goal, tasks, affected artifacts. The **spec** carries how and why-this-way: approaches weighed, alternatives rejected, load-bearing constraints. The issue links the spec; the spec does not restate the issue.

## Naming

`YYYY-MM-DD-issue-<N>-<topic>.md` — the issue number is **mandatory**, and there is no `-design` suffix (the file is in `specs/`; the redundancy is what produced `2026-07-12-icon-redesign-design.md`).

The date leads because it is a sort key that never needs a migration — leading with the issue number sorts wrongly as a string (`issue-1007` before `issue-183`), and zero-padding to fix that breaks past #10000, which is reachable here since GitHub shares one number space between issues and PRs.

The date is the only metadata in the filename. Anything git or GitHub already knows — author, amendment history, whether it shipped — stays out of both the name and the header.

A spec covering several issues is named for the primary one and lists the rest in its header.

**Names before #621 vary** (only 10 of the 43 then-existing specs carried an issue number, and four suffix conventions coexisted). They were deliberately left alone: renaming breaks published `blob/master/...` permalinks in issue bodies and the spec paths cited from source comments. The convention is forward-only.

## Header

```markdown
> **Issue:** [#1035](https://github.com/niklam/iracedeck/issues/1035) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.
```

**There is no `Status:` field, deliberately.** Whether the work shipped is already tracked by the issue being open, closed, or closed as not planned — and a status field nobody remembers to update is worse than none, because it asserts something false. `Supersedes:` / `Superseded by:` are the only hand-maintained fields, and both are one-time edits.

## Specs commit to `master`, and never inside a feature branch

A spec goes to `master` as its own `docs(specs): … (#N)` commit — both when first written and whenever it is amended during implementation. Never commit one on a feature branch, even the branch implementing it.

Three reasons: a spec on a `release/*` branch reaches `master` weeks late via back-merge; a spec on an abandoned branch is lost with it; and a file that only ever changes on one branch can never conflict. `b4945e2a` (the #1035 spec) is the pattern.

## Editing a spec: free before it ships, frozen after

- **Before the work ships** — edit freely. It is a working document and git history holds the diffs. This is the common case where implementation proves the design wrong: amend the spec on `master` and note it in the PR (`719fed15` did exactly this for #612).
- **After the work ships** — frozen. It now records what was decided and why, and things in the tree cite it. A change of direction gets a **new** spec naming the old one in `Supersedes:`; the old one takes exactly one edit, its `Superseded by:` pointer.

Never retrofit a spec onto an already-shipped feature.

## Plans

Write one for every implementation — it is how execution works, and how a fresh session or subagent picks the work up with review checkpoints. Two rules:

1. **Author it just before implementation, never at issue-filing time.** It is written against a specific state of the codebase; a plan written weeks ahead looks authoritative while being wrong.
2. **Never commit it.** `docs/superpowers/plans/*` is gitignored (the directory is kept by a `.gitkeep`). A plan in a PR is diff noise on top of a document nothing has ever read back — in five months, not one of the 42 plans deleted in #621 was cited from a rule, a `CLAUDE.md`, or any source file, while specs were cited from six places including three source files.

The 42 historical plans remain retrievable: `git show 888658d8:docs/superpowers/plans/<name>.md`.
