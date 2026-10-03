> **Issue:** [#1307](https://github.com/niklam/iracedeck/issues/1307) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The merge gate accepts a pure rebase of the reviewed head

The issue carries the problem: a rebase moves the head, CodeRabbit does not review a rebase, and the gate then refuses a PR whose change it has already approved. This spec settles what counts as "the latest change is a rebase", and where the check lives.

## The test: replay the reviewed change and get the head

Decided with the maintainer on 2026-10-03. The check replays the reviewed commit's change onto the head's base, using `git merge-tree`, and requires the result to be **the head's tree, byte for byte**. If the replay is clean and the trees match, the head is a pure rebase and the gate passes it. Otherwise it is a different change.

**The first decision, comparing added and removed lines per file, was withdrawn the same day.** The `max` review reproduced the gate accepting content CodeRabbit never saw:

- **Position was lost.** With the hunk headers dropped, a file's signature was its `+`/`-` lines in order, with nothing saying where they sat. A reviewed line moved into another function compared equal, and so did removing a different copy of an identical line.
- **Config and encoding leaked in.** Porcelain `git diff` applied Git for Windows' system textconv for `.pdf` and `.docx`, so changed bytes with the same extracted text compared equal. `diff.relative`, replace refs, and decoding as UTF-8 each hid a change as well.

A replay sidesteps both. Trees are compared by object id, so there is no parser, no diff config and no encoding involved. Position is part of the content.

## Conflicted files: line check, then the maintainer confirms

A rebase that conflicted (#1305's regenerated `changelog.json`, and most user-facing PRs, since they all touch the changelog) cannot reproduce the head's tree: the replay holds conflict markers where the head holds a resolution. For each file that differs and that the replay reported as **conflicted**, the reviewed commit's added and removed lines are compared with the head's, each against its own merge-base. The diff is plumbing `git diff-tree -p --no-renames --full-index -U0`, read byte-exact. When every such file matches, the gate **asks**: the permission prompt names the conflicted files, and the maintainer confirms. A line match cannot see position (above), so it is evidence for a human, never a pass on its own. Any differing file that did not conflict, and any conflicted file whose lines differ, is refused.

The alternatives weighed:

- **Refusing every conflicted rebase.** Strictest, but it removes most of the benefit, because most rebases here conflict in the changelog.
- **Passing conflicted files on a line match, with no prompt.** That keeps the hole the withdrawn design had, confined to the files where a human resolved something, which is exactly where the hole matters.

## When the replay is not attempted

Each of these refuses outright, before any replay, because a replay would answer the wrong question:

- **The reviewed commit is an ancestor of the head, with new non-merge commits after it.** That is a follow-up push, not a rebase, and CodeRabbit's incremental review of it is on its way. Merge commits are allowed: an "Update branch" merge of the base is a rebase by other means, and the replay covers it.
- **The PR's base branch was changed after the newest review.** That is a `BaseRefChangedEvent` in the PR timeline. Commits that were on the base side when CodeRabbit reviewed would otherwise count as part of the reviewed change. A timeline that cannot be read refuses too.
- **A `release/*` back-merge.** Its commits land on `master` one by one, not as a net diff, so a rewritten tip with the same net change is still a different merge.

## Which review, and which base

- **The compared commit is the newest CodeRabbit review, by `submittedAt`, whatever its state.** That is what CodeRabbit last saw, and an older approval must not reach past a newer review. A review at the current head passes as it always has. The bot is matched as `coderabbitai` or `coderabbitai[bot]` exactly, not any login containing the word.
- **The base is the PR's own `baseRefOid` from GitHub, not the local `origin/<base>` ref.** A stale local ref used to make the comparison fail *open*. A ref name also resolves by DWIM, so a stale branch or tag could shadow it. Each merge-base is taken against that sha.
- **Everything else is unchanged.** `reviewDecision` must be `APPROVED`, CodeRabbit must have approved at some point, and every check must be green at the current head. The replay runs only once those cheap checks have passed.
- **A merge accepted through the replay must carry `--match-head-commit <headRefOid>`.** The verdict is about that sha, and the fetching and replay widen the window in which another push could land.

## Where it lives

- **`lib.mjs`** (impure) gets `replayRebase({ reviewed, head, base, dir, deadlineAt })`. It does the following:
  1. Fetches any of the three commits that are not local in one `git fetch --no-tags --no-write-fetch-head origin <sha…>`.
  2. Takes both merge-bases.
  3. Runs `git merge-tree --write-tree --name-only --no-messages --merge-base=<mb(reviewed)> <mb(head)> <reviewed>`.
  4. Diffs the replayed tree against the head's tree with `diff-tree --name-only`.
  5. Line-checks the conflicted files that differ.

  It returns `{ ok, conflicted, differing, lineMatched }` or a failure reason. Every git call runs with `GIT_NO_REPLACE_OBJECTS=1`. `run()` gains `maxBuffer`, `encoding` and `env` options.
- **One deadline for the whole hook.** It is taken at hook start, about 50 s against the 60 s hook timeout, and clamps every spawn. When it is spent the check refuses, because a timed-out PreToolUse hook does not block the call.
- **`change-signature.mjs`** keeps the pure line parser and comparator, now used only for conflicted files. It keys files by their whole `diff --git` header, appends a repeated header (git prints a typechange as a delete block plus a create block), and splits on `\n` only.
- **`lib.mjs`** also gets `baseChangedSince(number, iso, dir)`, a `gh api graphql` read of the PR's `BaseRefChangedEvent`s.
- **The merge rule in `rules-bash.mjs`** sequences the checks: cheap first, then the refusals above, then the replay. It returns a deny, an ask naming the conflicted files, or a pass.

**Every uncertain path refuses**, and each refusal names its reason. These cases are refused:

- no CodeRabbit review
- a commit that cannot be fetched
- a `merge-tree` failure
- a spent deadline
- an unreadable timeline

A refusal for differing files names up to five of them and says whether each conflicted. `--admin` keeps its meaning: it skips the review checks, this one included. The fetch writes objects to the session's checkout, but never `FETCH_HEAD` or a ref. `hooks.md` rule 4 says so.

## Out of scope

- **The post-bash hook's unanchored triggers.** Its "after `gh pr merge`" step fires on any mention of the command (2026-10-03, several times). It is a separate fix.
- **CodeRabbit's own behaviour**, and its config.
- **Waiving the review for any other kind of change**, however small.
- **Requiring `--match-head-commit` on every merge.** This feature adds it only where the replay decided.

## Testing

- **Replay, in real repositories with a bare `origin`**:
  - A clean rebase onto a moved base passes.
  - A rebase that moves a reviewed line into another function is refused. This is the case the withdrawn design accepted.
  - A conflicted rebase resolved with the same lines yields an ask naming the file; resolved differently, it is refused.
  - A follow-up commit on top of the reviewed one is refused before any replay.
  - A multi-commit branch passes after a clean rebase.
  - A reviewed commit present only on `origin` is fetched.
  - A replace ref does not change the verdict.
  - A changed `.pdf` with the same text is refused. Trees compare by id.
- **The pure line parser:**
  - A shifted hunk compares equal, and a changed, reordered, added or dropped line differs.
  - A path containing ` b/` cannot shadow another file.
  - A typechange keeps both its blocks.
  - CR and non-UTF-8 bytes are compared exactly.
- **The rule, with the replay stubbed:**
  - Pass, ask and deny each carry the right reason.
  - The ordering holds: no git work runs when a cheap check already refuses.
  - A back-merge, a retarget, a follow-up push and a look-alike bot login each refuse.
  - The `--match-head-commit` requirement applies on the replay path only.
  - An older approval behind a newer review is not compared.
- **Real commits.** #1305's reviewed head `8b7be538c` against its rebased head `1a2187358` must yield an ask naming `changelog.json`, which is the file that conflicted.
- **Watched firing** (`.claude/rules/hooks.md` rule 6): pipe a real payload through `pre-bash.mjs` to prove the entry point loads, then use it on the next PR that needs a rebase once this is on `master`.

## Affected artifacts

- `scripts/claude-hooks/rules-bash.mjs`, `pre-bash.mjs`, `lib.mjs`, `change-signature.mjs`, and their tests.
- `.claude/rules/hooks.md`: the `gh pr merge` row, and rule 4 on the fetch.
- `.claude/rules/issue-workflow.md`: the step 11 gate cell, "An approval and a green check are both head-specific", and "Expect a fresh review after every push".
- `scripts/CLAUDE.md`: the hooks section.
