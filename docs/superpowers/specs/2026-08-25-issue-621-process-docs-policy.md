# Process documentation policy: specs in, plans out

> **Issue:** [#621](https://github.com/niklam/iracedeck/issues/621) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`docs/superpowers/` holds 85 committed files — 43 specs (568 KB) and 42 plans (1.8 MB) — produced by the brainstorming and planning workflow. No policy governs them. Nothing in `.claude/CLAUDE.md`, `.claude/rules/`, or any contributing note says whether they belong in a pull request, so whether they appear depends on who authored it. Issue #621 asks for that choice to be made explicitly and recorded.

The issue frames the choice as binary: (a) remove the tree and keep process docs out of the repo, or (b) require them for every feature with a defined location, naming, and format.

**That binary is false.** Specs and plans are different artifacts with different lifetimes, and the evidence in this repo separates them cleanly.

## Evidence

Six places in the repo cite a file under `docs/superpowers/`:

| Citing file | Cites |
| --- | --- |
| `.claude/rules/icons.md` | `specs/2026-07-12-icon-redesign-design.md` |
| `.claude/rules/black-box-icons.md` | `specs/2026-07-12-icon-redesign-design.md` |
| `packages/iracing-actions/CLAUDE.md` | `specs/2026-07-07-paired-adjust-key-styles-design.md` |
| `packages/iracing-actions/src/shared/adjust-styles.ts` | `specs/2026-07-07-paired-adjust-key-styles-design.md` |
| `packages/iracing-actions/src/actions/comms-catalog.ts` | `specs/2026-05-31-comms-method-audit.md` |
| `packages/deck-core/src/settings-store.ts` | `specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md` |

Every one points at a **spec**. Three of them are in source files, where a comment survives only if it earns its place. In five months not one of the 42 plans has been cited from anywhere — not from a rule, not from a `CLAUDE.md`, not from code.

Naming has drifted in parallel: only **10 of 43** specs carry the issue number, and four suffix conventions coexist (`-design` ×40, plus `-redesign`, `-decision`, `-audit`) — one file is `2026-07-12-icon-redesign-design.md`.

## Decisions

### 1. Specs are kept and are required for maintainer-authored work

A spec is this repo's durable design record: the standard in-repo, public artifact that ADRs, Rust RFCs and Kubernetes KEPs all are. It answers **why this way**, and the six citations above show it already functions that way here.

Required for us; **not** expected from outside contributors. We cannot govern how others file issues, and a public tree of design docs must not imply an obligation on a drive-by pull request. This is why the operative rule lives in `.claude/rules/` and `CLAUDE.md` (maintainer- and Claude-facing) and not in a contributing guide.

### 2. Plans are produced for every implementation, and never committed

A plan's value is concentrated between "work starts" and "PR merges". After that the code is the truth, and the durable "why" belongs in `.claude/rules/`, which this repo maintains in unusual depth. Committing plans costs three things and returns nothing measurable:

- diff noise — a 100 KB plan lands on a 200-line change;
- a stale document that reads as authoritative, because a plan is a route through a tree that has since moved;
- lint nits on planning prose from PR review tooling, which is the complaint that opened #621.

So plans continue to be written — they are how execution works, and how a fresh session or subagent picks up work with review checkpoints — but `docs/superpowers/plans/` is gitignored. The 42 tracked plans are deleted. Nothing is lost: `git show <sha>:<path>` retrieves any of them.

**A plan is authored just before implementation, never at issue-filing time.** It is written against a specific state of the codebase, so a plan written weeks ahead would look authoritative while being wrong. A spec ages well because it records a decision; a plan ages badly because it records a route.

### 3. Specs are committed to master, and never inside a feature branch

Not merely "reach master eventually" — a spec goes to master as its own `docs(specs): … (#N)` commit, both when first written and whenever it is amended during implementation.

This makes the invariant absolute: no spec arrives on master weeks late by way of a release-branch back-merge, and no spec can be lost with an abandoned branch. It also removes any chance of a merge conflict on the file. Commit `b4945e2a` (the #1035 spec) already did exactly this.

### 4. Status is derived from the issue, not written in the file

The header carries only what GitHub cannot answer:

```markdown
> **Issue:** [#1035](https://github.com/niklam/iracedeck/issues/1035) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.
```

A conventional ADR `Status:` field was considered and rejected. Whether the work shipped is already tracked — the issue is open, closed, or closed as not planned — and a status field that nobody remembers to update is worse than none, because it asserts something false. `Supersedes:` / `Superseded by:` are the only hand-maintained fields, and both are one-time edits.

### 5. Editing rule: free before the work ships, frozen after

- **Before it ships** — edit freely. The spec is a working document and git history holds the diffs. This covers the common case where implementation proves the design wrong: amend the spec (on master, per decision 3) and note it in the PR. There is precedent — `719fed15` corrected the #612 spec in place after implementation showed the proposed binding helper ignored the browser/Node split.
- **After it ships** — frozen. The spec now records what was decided and why, and things in the tree cite it. A later change of direction gets a **new** spec naming the old one in `Supersedes:`; the old one takes exactly one edit, its `Superseded by:` pointer.

### 6. Which issues get a spec

Every **feature or enhancement** issue we file. Exempt: bug reports, documentation and typo fixes, dependency bumps, and batch or hygiene sweeps across many issues. A bug whose fix involves a genuine design choice gets one anyway.

The threshold is deliberately mechanical — it maps to labels already applied — rather than a per-issue judgment call, so it can actually be followed.

### 7. The issue and spec split, and the order of operations

The **issue** carries what and why: problem, goal, tasks, affected artifacts. The **spec** carries how and why-this-way: approaches weighed, alternatives rejected, load-bearing constraints. The issue links the spec; the spec does not restate the issue.

```text
file the issue  ->  get its number  ->  write the spec named with it
                ->  commit to master ->  add the master permalink to the issue body
```

Later, when implementation begins: write the plan against the current tree, then build. The plan is never committed.

### 8. Naming: YYYY-MM-DD-issue-N-topic.md

This is the newest de-facto pattern with two changes — the issue number becomes mandatory, and `-design` is dropped as redundant with the `specs/` directory it always sits in.

The date leads because it is a sort key that never needs a migration. Leading with the issue number instead would group related work and is the key specs are retrieved by, but it sorts wrongly as a string (`issue-1007` before `issue-183`) and fixing that needs zero-padding, which breaks past #10000 — not hypothetical, since GitHub shares one number space between issues and pull requests and this repo is already at #1035. The date also puts the staleness signal in the filename: a March spec is visibly a March spec.

The date is the only metadata in the name. Anything git or GitHub already knows — author, amendment history, whether it shipped — stays out of both the filename and the header.

A spec covering several issues is named for the primary one and lists the rest in its header.

### 9. Nothing existing is renamed or retrofitted

The convention is forward-only. The 43 existing specs keep their names, receive no headers, and no spec is written for an already-shipped feature.

Renaming would break the `blob/master/...` permalink in the #1035 issue body and the three source-file citations. The `README.md` notes that legacy names vary.

### 10. The directory keeps its name

`docs/superpowers/` is named after the tool that produced the files rather than what they are, and `docs/design/` would explain itself to an outside reader. It stays anyway: the superpowers skills write to this path by default, so keeping it removes any chance of a future session filing a spec somewhere else; renaming breaks the #1035 permalink and the six citations; and a `README.md` at that path solves the comprehension problem for one file instead of 43 moves.

## Changes to the repository

1. Delete the 42 files under `docs/superpowers/plans/`; keep the directory with a `.gitkeep`.
2. `.gitignore`: ignore `docs/superpowers/plans/*` with a `!docs/superpowers/plans/.gitkeep` negation, alongside the existing `.superpowers/` entry (same shape as `scripts/radio-effect/output/`).
3. Add `.claude/rules/specs-and-plans.md` — the operative rule.
4. Add its one-line entry to the `## Rule files` index in `.claude/CLAUDE.md`.
5. Add `docs/superpowers/README.md` — what these files are, that they are point-in-time records, that legacy names vary, and that outside contributors are not expected to produce one.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Option (a) as filed: delete specs and plans both | Discards the artifact six places in the repo actively cite, three of them source files. |
| Option (b) as filed: commit both, formalized | Carries 1.8 MB of plans that nothing has referenced in five months, and keeps the PR diff noise that opened the issue. |
| Commit plans, delete each on merge | Git history already provides this. The delete step is ceremony on an artifact never read after merge, and the plan still lands in the PR diff. |
| Gitignore plans but keep the 42 committed as an archive | Leaves a visibly stale tree with no rule explaining why it stopped growing. |
| ADR-style `Status:` header field | Duplicates issue state and rots the first time it is not updated. |
| Issue-number-first filenames | Sorts wrongly without zero-padding; padding breaks past #10000, which is reachable here. |
| Rename `docs/superpowers/` to `docs/design/` | Breaks the #1035 permalink and six citations, and diverges from the skills' default write path. |
| Retrofit names or headers onto the 43 existing specs | Breaks published permalinks and source-comment citations for cosmetic gain. |
| Put the policy in `CONTRIBUTING.md` | Would imply an obligation on outside contributors that we explicitly do not want. |

## Out of scope

- Rewriting or curating the content of the 43 existing specs.
- Adding a markdown linter. Prettier covers only `**/*.ts` and `**/*.json` here, and eslint covers only `packages/*/src`, `scripts`, and `vitest.config.ts`; markdown has no local gate and this change does not add one.
- Changes to the issue templates or the pull request template, both of which are contributor-facing.
