# Prose-only PRs skip CodeRabbit and merge with `--admin`

> **Issue:** [#1648](https://github.com/niklam/iracedeck/issues/1648), also [#1649](https://github.com/niklam/iracedeck/issues/1649) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Why

CodeRabbit's Team plan meters PR reviews per author on an adaptive refill: 8 an hour below 40 reviews in the last 7 days, 4 at 50–59, 1 at 70 or more. Every PR here is authored as niklam. In the 7 days to 2026-11-07, 63 PRs drew 127 review objects and 72 `@coderabbitai review` asks, so the repo sat at 1 review an hour. Niklas changed the CodeRabbit config the same day: a PR is reviewed once when it opens and afterwards only on `@coderabbitai review`, and a PR labelled `no-coderabbit` is not reviewed automatically at all. #1649 writes the workflow side of that. This spec decides which PRs may skip CodeRabbit and how they merge, because the second half is a change to the merge gate.

Two facts shape the merge. Master's ruleset requires one approving review, and Niklas is the only person working here, so a PR CodeRabbit never reviews has nobody who can approve it and merges only through the admin bypass. And the gate today refuses a BLOCKED `mergeStateStatus` even under `--admin`, while an unapproved PR is BLOCKED to an admin too (measured on #1633, #1640 and #1645: `REVIEW_REQUIRED`, `BLOCKED`). So no unapproved PR passes the gate today, and once the label exists nothing in the hook ties `--admin` to the PRs the label is meant for.

## Decision

**Which PRs skip CodeRabbit.** A PR whose every changed file is Claude-facing prose: a Markdown file under `.claude/rules/`, `.claude/skills/` or `.claude/agents/` (`**/*.md`), or a `CLAUDE.md` where the repo keeps them: `.claude/CLAUDE.md`, `packages/*/CLAUDE.md`, `scripts/CLAUDE.md`. Markdown only, so a script a skill carries one day is code and does not qualify; and no `CLAUDE.md` at any depth, since one under the website's content folder would be published as a page. A skill's or agent's frontmatter is configuration, not prose (`tools`, `allowed-tools`, `hooks`, a permission mode), so a file under `.claude/skills/` or `.claude/agents/` qualifies only when its frontmatter block is byte-identical at the merge base and the head; a new or deleted skill or agent file therefore needs CodeRabbit. A rule's `paths` frontmatter only scopes when it loads, and is not checked. Nothing else qualifies: not `.claude/settings.json`, which wires the hooks; not a changelog fragment, a website page or `README.md`, which users read; not a script or a test, however small. These files already need no draft approval, and their review is the local `/code-review` at `medium` plus the CodeRabbit CLI round, which draws on its own allowance rather than the PR one. Such a PR is opened with `--label no-coderabbit`, at `gh pr create`, since the review it saves is the one that runs on open.

**One list, in one module.** The globs live in a new `scripts/claude-hooks/no-review-paths.mjs`, exporting the list and a `isNoReviewPath(path)` matcher. The gate imports it, `code-review.md` states the same list in prose, and a test reads that section of `code-review.md` and fails when the two differ, so widening the list is one edit plus the rule's sentence.

**The gate under `--admin`.** Every merge that carries `--admin` is judged for whether it qualifies, whatever its `mergeStateStatus` (an unapproved PR reads `UNKNOWN` while GitHub computes mergeability, and keying on BLOCKED alone let that through unread). It qualifies when every changed file matches the list, or when Dependabot opened it and every commit on it is Dependabot's. A qualifying PR:

- must be pinned with the full `--match-head-commit <head>`, the head the files were read at, so a push between the read and the merge cannot slip a file in;
- passes a BLOCKED `mergeStateStatus` only when `reviewDecision` is `REVIEW_REQUIRED`: the missing approval is the block the bypass exists for;
- must show every status check the base branch's rules require, present and green, read from the rules API (`repos/<repo>/rules/branches/<base>`): BLOCKED also covers a required check that never reported, which the rollup cannot show, and the bypass must not skip one. An unreadable rule set refuses. A base whose rules require no check (a `release/*` branch today) passes, unless the PR is BLOCKED, where an empty set contradicts the block and refuses;
- keeps every other check: OPEN, `--squash`, every rollup entry green, not DIRTY, and the repository checks of #1393.

`CHANGES_REQUESTED` refuses every `--admin` merge, qualifying or not and whatever the merge state: a review that asked for changes was not answered, and no prompt should stand in for answering it. A non-qualifying `--admin` keeps today's checks, BLOCKED refusing, but where today it would pass it now **asks**: it skips CodeRabbit's review at the head (an approval survives a push here, `dismiss_stale_reviews_on_push` being off), so it runs only when Niklas confirms the prompt, which is the "only on Niklas's word" the `issue-lead` skill already states. A failed file read counts as non-qualifying, so it can only reach that prompt, never a silent pass. The refusal or prompt names the files outside the list, so a mislabelled PR reads as one. The gate does not read the label: the files decide, and the label only decides whether CodeRabbit spends a review.

**How the files are read.** With git, not the PR's GraphQL `files`: `git diff --no-renames --name-only <merge-base of baseRefOid and head>..<head>`, at the repository root, fetching a missing commit from `origin` by sha the way `replayRebase` already does. `--no-renames` lists both sides of a rename, so moving `scripts/x.mjs` into `.claude/rules/` shows the deleted script and refuses; GraphQL reports a rename by its new path only. The read is pinned to the head sha the merge is pinned to. Anything that fails — the fetch, the merge base, the diff, an empty list — makes the PR non-qualifying, naming what failed: it is refused when BLOCKED and otherwise can only reach the prompt.

**Dependabot.** Its PRs are never reviewed by CodeRabbit (`ignore_usernames`), so they are unapproved too, and the documented route for them is `--admin`. The author check reads the PR's `author` as `gh pr view` gives it: `is_bot: true` with login `app/dependabot` (a user login cannot hold a `/`). The author alone is not enough: a commit someone else pushes onto a Dependabot branch keeps that author, so every commit from the merge base to the head must also carry Dependabot's author identity and GitHub's committer identity (`GitHub <noreply@github.com>`, which Dependabot's commits have): a local amend or rebase keeps the author but replaces the committer, so an edit folded into Dependabot's own commit is caught too. Both lines can be written by anyone, so this stops an accidental edit, not a forged one. Their files are lockfiles and manifests, which CI covers; the list is not consulted for them.

## Alternatives rejected

- **Trust the label.** It is free to add and the gate would then pass a code PR someone labelled by mistake; the label stays a cost switch only.
- **Drop the BLOCKED check under `--admin` entirely.** BLOCKED also covers a required check the rollup may not show yet, and `CHANGES_REQUESTED`; keeping it except for `REVIEW_REQUIRED` keeps those refusals.
- **Path filters in the CodeRabbit config** (`reviews.path_filters`). They would drop prose from mixed PRs too, where checking a rule against the code beside it is useful, and the docs do not say whether a PR with every file filtered out still costs a review.
- **Today's pass for a non-qualifying `--admin`.** It skips the review at the head with no one confirming, and once these rules make `--admin` a routine step an agent reaching for it after a "not reviewed" refusal would merge unreviewed code. The ask keeps the escape hatch for Niklas without that.
- **GraphQL `files`.** One call and no git work, but it hides the old side of a rename and caps at 100 files per page.

## Out of scope

- Which PRs CodeRabbit reviews automatically and when to ask for a review: that is the config and #1649's prose.
- The review evidence the gate accepts on the normal path (#1388, #1386, #1307).
- Widening the list to website pages or changelog fragments. They are user-facing; a later change adds them to the module and the rule together.
- A merge Niklas makes himself outside a Claude Code session, which no hook sees.

## Testing

Unit tests in `rules-bash.test.mjs` and a new `no-review-paths.test.mjs`, with the git read injected through `ctx` as the gate's other reads are:

- a PR changing only `.claude/rules/`, `.claude/skills/`, `.claude/agents/` and nested `CLAUDE.md` files passes under `--admin --squash --match-head-commit <head>` while BLOCKED with `REVIEW_REQUIRED`;
- each of these refuses, naming the file: a script, a test, `.claude/settings.json`, a changelog fragment, a website page, `README.md`, and a rename from `scripts/` into `.claude/rules/`;
- a Dependabot PR passes on its own files;
- a qualifying PR refuses when unpinned, pinned to another sha, `CHANGES_REQUESTED`, DIRTY, with a red or pending check, or when the diff or fetch fails or lists nothing;
- a non-qualifying `--admin` refuses on BLOCKED exactly as before;
- the list in `code-review.md` matches the module, with a positive control: a mutated copy of the section fails.

Then by hand, once #1649's label exists: pipe a synthesised `gh pr merge` payload for a real prose-only PR through `pre-bash.mjs` with `IRACEDECK_HOOKS_DRY_RUN=1`, and for a real code PR, and see the pass and the refusal naming the file.
