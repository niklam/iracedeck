> **Issue:** [#1307](https://github.com/niklam/iracedeck/issues/1307) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The merge gate accepts a pure rebase of the reviewed head

The issue carries the problem: a rebase moves the head, CodeRabbit does not review a rebase, and the gate then refuses a PR whose change it has already approved. This spec settles what "the latest change is a rebase" means and where the check lives.

## The test: the same added and removed lines, file by file

A head is a **pure rebase** of the reviewed commit when, for every file, the lines the branch adds and removes relative to its own merge-base with the base branch are identical, in order, at both commits. Decided with the maintainer on 2026-10-03, over two looser alternatives:

- **Rejected: exempt regenerated artifacts** (`changelog.json` and the other freshness-tested outputs). A rebase regenerates them routinely, but an exemption is a list of paths whose content the gate stops reading, and those files ship. When a regenerated file's lines do differ, a fresh review is the right price. On #1305 the regenerated `changelog.json` carried the same added lines, so the case that motivated the exemption does not need it.
- **Rejected: matching commit messages.** It is cheap, but it would let changed content through under the same subjects, which is the one thing the gate exists to stop.

What the comparison ignores, and why each is safe:

- **Hunk headers (`@@ … @@`) and context lines.** A rebase shifts line numbers and changes the surrounding text by definition. Neither is part of what the branch changes.
- **The `index <blob>..<blob>` line of a text file.** The post-image blob contains the base branch's other changes, so it differs after any rebase that touched the same file. The added and removed lines already say everything the branch did to it.

What the comparison keeps:

- **The file set.** A file added to or dropped from the change is a different change.
- **The `diff --git`, `new file`, `deleted file` and mode lines.** A mode flip or a delete has no `+`/`-` lines of its own.
- **The `index` line of a binary file**, plus git's `Binary files … differ` marker. A binary file has no lines to compare, so its post-image blob id IS its content. A rebase leaves an untouched binary's blob unchanged, so this costs nothing in the common case.

The diff is taken with `--no-renames`, so a rename is a delete plus an add, compared as such. Rename detection depends on a similarity threshold the rebase can move, and a rename that changed content would otherwise compare as a pure move.

## Which reviewed commit is compared

The **newest CodeRabbit review**, by `submittedAt`, whatever its state. That is the commit CodeRabbit last saw. Today's rule, "a CodeRabbit review exists at head", becomes "the newest CodeRabbit review is at head, or at a commit the head is a pure rebase of". Everything else in the gate is unchanged. `reviewDecision` must still be `APPROVED`, CodeRabbit must still have approved at some point (its incremental reviews after a follow-up commit are `COMMENTED`, and the standing approval counts), and every check must be green at the current head. Checks always run on a push, so a rebase never skips them.

Comparing against the newest *approved* review instead would reach past a later review that saw more. A branch approved at A, reviewed with comments at B, then rebased, must be compared against B.

## Where it lives

- **`lib.mjs`** (impure) gets `changeSignature(sha, baseRef, dir)`. It resolves `git merge-base <baseRef> <sha>`, runs `git diff --no-color --no-ext-diff --no-renames --full-index --unified=0 <base> <sha>`, and hands the text to the parser. A reviewed commit that is not in the local object store is fetched with `git fetch origin <sha>` first; a force-pushed head usually survives in the worktree's reflog, and the fetch covers a fresh clone. Any failure returns `null`.
- **A pure parser and comparator** (`parseChangeSignature(diffText)` → `Map<path, string[]>`, `changedFiles(a, b)` → the paths that differ), tested without git.
- **`pre-bash.mjs`** exposes it as `ctx.changeSignature`, memoised like the other readers.
- **The merge rule in `rules-bash.mjs`** calls it only when the newest review is not at head. It does so for both commits against `origin/<baseRefName>`. If origin is stale, the head's merge-base is an older base tip, the head's diff then includes base commits the reviewed one lacks, and the comparison fails. That fails closed, and the freshness check the hook already runs names the cause.

**Every uncertain path refuses.** That covers no CodeRabbit review at all, a signature that could not be read for either commit, and a signature that differs. The refusal names the reason. For a difference it names up to five differing paths, so the merging agent knows whether to ask `@coderabbitai review` or to look at its own conflict resolution. `--admin` keeps its meaning: it skips the review checks, this one included.

## Out of scope

- **The post-bash hook's unanchored triggers.** Its "after `gh pr merge`" step fired on a `grep` for the string and on a heredoc that quoted it (2026-10-03). That breaks `.claude/rules/hooks.md` rule 7 on the post side, and it is a separate fix.
- **CodeRabbit's own behaviour.** Making it review a rebase, or changing its config, does not belong here.
- **Waiving the review for any other kind of change**, however small: a typo fix, a regenerated file, a comment. Only a change identical to the reviewed one passes.
- **The release back-merge path** (`--merge` on a `release/*` head). It has no CodeRabbit-at-head requirement of its own to relax.

## Testing

- **Parser and comparator, without git.** Two diffs of the same change at shifted line numbers and different context compare equal. One changed `+` line, a reordered pair of lines, an added file, a dropped file, a mode change and a binary file with a different post-image blob each compare unequal and name the path. A text file whose `index` line alone differs compares equal.
- **The rule, with a stubbed `changeSignature`.** The newest review at head passes as today. A pure rebase of the newest review passes. A rebase whose conflict resolution changed one line is refused, naming the file. That case is the positive control: it is the one the exception must never let through. An unreadable signature is refused. A pure rebase of an *older* review, behind a newer review at a different commit, is refused. No CodeRabbit review is refused.
- **Real commits.** `changeSignature` over #1305's reviewed head `8b7be538c` and its rebased head `1a2187358` must compare equal. That is the case that motivated this. A scratch repository with a conflicting rebase resolved differently must compare unequal.
- **Watched firing** (`.claude/rules/hooks.md` rule 6): pipe a synthesised `gh pr merge` payload through `pre-bash.mjs` with `prView` and `changeSignature` stubbed for both outcomes, then trigger it in-session on the next PR that needs a rebase.

## Affected artifacts

- `scripts/claude-hooks/rules-bash.mjs`, `pre-bash.mjs`, `lib.mjs`, and their tests.
- `.claude/rules/hooks.md`: the `gh pr merge` row of the guard table.
- `.claude/rules/issue-workflow.md`, step 11: "An approval and a green check are both head-specific" gains the pure-rebase exception.
- `scripts/CLAUDE.md`: the hooks section, if `lib.mjs`'s description changes.
