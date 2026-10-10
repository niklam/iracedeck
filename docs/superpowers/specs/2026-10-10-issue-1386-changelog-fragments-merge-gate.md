> **Issue:** [#1386](https://github.com/niklam/iracedeck/issues/1386) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Changelog fragments, and CodeRabbit's summary as the head's review

The issue carries the problem: every user-facing PR edits the same changelog section and regenerates the committed `changelog.json`, so nearly every rebase conflicts, and a follow-up commit that CodeRabbit reviewed incrementally leaves no review object at the head. Both end in `--admin`. This spec settles how fragments are stored, ordered, folded and read (A), and exactly what the merge gate accepts from CodeRabbit's summary comment (B). B extends the #1307 merge gate (`2026-10-03-issue-1307-merge-gate-pure-rebase.md`) without replacing any of it; that spec's assumption that "CodeRabbit's incremental review of it is on its way" as a review object is the one B corrects.

## A. Changelog fragments

### Where a fragment lives and what it looks like

One file per bullet in `changelog.d/` at the repository root, named `<number>-<slug>.md`, where the number is the issue (or, for a PR with no issue, the PR) and the slug is lowercase words joined by hyphens. A PR with two bullets adds two files.

```markdown
---
category: Bug Fixes
weight: 60
---

**Session Info** keys now use much less CPU and memory in a race, … See [Session Info](/docs/actions/display-session/session-info/).
```

- **Root, not under the website.** Anything under `packages/website/src/content/docs/` is a Starlight page, so a fragment there would be published on its own. The fragments are consumed by root tooling (the release hook, the data generator), and the issue named `changelog.d/`.
- **Frontmatter, not the filename, for category and weight.** The towncrier shape (`1345.bugfix.md`) was weighed: it needs a category vocabulary of its own beside the five headings, and a weight in the name makes every re-ranking a rename. The filename carries only identity, which is what keeps two PRs from ever touching the same path.
- **A strict two-key parser, no YAML library.** The frontmatter is exactly `category` and `weight`, one `key: value` per line between `---` fences. A YAML parser would accept quoting, comments and anchors that nobody needs and that the strict format would then have to police. The root scripts stay dependency-free.
- **The body is one line, the bullet text without its `- ` marker.** The changelog's bullets are single lines (the parser's `BULLET_LINE`), and one spelling means the fold never has to guess whether a marker is already there.
- **`changelog.d/README.md` is the one non-fragment file.** It documents the format for whoever opens the folder and keeps it in the tree after a fold empties it. Any other file there, a mis-named fragment included, is an error rather than silently skipped.

### Order within a category

`weight` is a required integer from 1 to 100, and higher sorts first within its category (the maintainer's rule). It has no default: a missing weight would sort as a number nobody chose. Ties break on the issue number ascending, then on the full file name compared by code unit. Ascending issue number reproduces today's habit of appending, so older work reads first; code-unit comparison, not `localeCompare`, makes the order identical on every machine and independent of directory listing order. Categories keep `CHANGELOG_CATEGORIES`' fixed order, and a category with no fragments gets no heading.

### One composer behind every reader

A new pure module, `scripts/lib/changelog-fragments.mjs`, owns `parseFragment(fileName, text)`, the sort, `renderReleaseSection(version, dateLine, fragments)` and `composeChangelog(mdx, fragments, version, dateLine)`. The composer renders the section as changelog markdown and inserts it before the first `## ` heading. A thin impure loader reads `changelog.mdx`, `changelog.d/` and the root `package.json` version (suffix stripped, the rule `changelog.md` already states).

Every reader goes through it, so the preview and the eventual release are the same text:

- **`pnpm generate:changelog-data`** composes with `_Unreleased_`, then runs the unchanged `parseChangelog` and `buildChangelogData` over the result.
- **The website's `generate:changelog-json`** does the same, so the bytes-equal guarantee of #1016 holds by construction.
- **The website's changelog page** gets a small mdast plugin, applied to `changelog.mdx` only, that inserts `renderReleaseSection(…, "_Unreleased_", …)` before the first depth-2 heading. *Amended during implementation:* Astro 7's default Markdown processor, for `.mdx` too, is Sätteri, not unified/remark, and `markdown.remarkPlugins` would switch every page to unified; so it is a Sätteri `mdastPlugins` entry (`packages/website/src/changelog-fragments-plugin.mjs`) that splices the section as raw Markdown, parsed by the page's own parser with its smart punctuation and GFM, and `mdast-util-from-markdown` is not used. Injecting at the Markdown stage, rather than rendering an Astro component, keeps the section in Starlight's table of contents with the same anchor a hand-written one had. The alternative of generating the whole page from a renamed committed source was rejected: it moves a file the version-upgrade opener and every rule point at, for no gain over a 30-line plugin.
- **The release hook's fold**, below, composes with the real date.

With no fragments the composer returns the MDX unchanged and no in-development section exists, so a fresh `-dev.0` reads exactly like today's state after a release.

### The fold at a stable release

In `before:bump` (`scripts/release-hooks.mjs`), on a version without a `-`:

1. Load and validate every fragment, compose with `_YYYY-MM-DD_` (local date, `formatLocalDate`), and run `buildChangelogData` over the result, all before any write, so a malformed fragment aborts the release with a clean tree as a malformed section does today.
2. Refuse when any fragment is not committed, so `git restore` can always recover it. Preflight `git add --dry-run` over `changelog.mdx` beside the version files, and `git rm --dry-run` over the fragments.
3. Write `changelog.mdx`, then remove and stage every fragment with **one** `git rm`, then bump the version files. *Amended after review:* deleting the fragments one by one could stop part-way on Windows (`EBUSY`/`EPERM`) and leave a half-deleted set with nothing staged; with one `git rm` a failure leaves one state, which the error names together with its `git restore` command, and the version files untouched. A re-run on a half-folded tree is refused by the composer's existing-section check, never folded twice.

Zero fragments is a logged no-op, as a missing section is today; the pane then says it has no notes for that version, which is honest. Pre-releases skip the fold, so an `-rc` build shows the fragments as Unreleased. The dry run prints the section it would write and the fragments it would delete. `stampChangelog` is retired, and `scripts/lib/changelog-stamp.mjs` with it: after the migration `changelog.mdx` never carries `_Unreleased_`, so there is nothing to stamp. The fold lives in `scripts/lib/changelog-fold.mjs` (with `formatLocalDate`), and the composed readers in `scripts/lib/changelog-composed.mjs`. The hook stops writing and staging `changelog.json`; staging a gitignored path would now fail its own preflight, and the release-pack build regenerates the file from the tag.

### `changelog.json` becomes a build artifact

`packages/iracing-actions/src/actions/data/changelog.json` is gitignored and removed from the index. The plugins read it at build time through the settings-window partial's `require('./data/changelog.json')` (the PI template plugin's `require`, resolved against `iracing-actions/src/actions`), so it has to exist before any plugin build.

- **A root turbo task, `//#generate:changelog-data`,** runs the existing root script. Its inputs are `changelog.mdx`, `changelog.d/**`, `scripts/lib/changelog-*.mjs`, `scripts/generate-changelog-data.mjs` and the root `package.json`; its output is the JSON. Each of the three plugin builds adds it to `dependsOn`, which also folds its hash into theirs, so a fragment edit invalidates the plugin builds and a cache hit restores the file. `@iracedeck/website#build` adds `changelog.d/**` and the root `package.json` to its inputs; it already lists `scripts/lib/changelog-*.mjs`.
- **Rejected: generating in each plugin's Rollup `buildStart`.** Turbo runs the three plugin builds in parallel, and three writers to one file on Windows is a sharing-violation race.
- **Rejected: passing the data to the template in memory.** Sound, and fileless, but it changes the template plugin's contract and the partial, and breaks the convention that every partial reads shared data from `data/` with no Rollup wiring (`settings-window.md`).
- **`rollup -w` does not run turbo.** In watch mode a fragment edit needs `pnpm generate:changelog-data`, which the post-edit hook runs in a Claude Code session.

Tests that read the committed file today (the partial's "real artifact" test, `app-updates`' headroom test, the website bytes-equal test) build the data in memory through the loader instead, so `pnpm test` never depends on a prior build.

### Release branches and back-merges

The rule that resolves every case: **a fragment travels with its code**, and whatever fragments a branch holds at its stable bump are that release's notes.

- **A fix PR into `release/X.Y`** adds its fragment there. The `X.Y.Z` bump on that branch folds it. The back-merge then brings a dated `## X.Y.Z` section plus the deletions of every fragment the release branch held, including those inherited from `master` at the branch point, which did ship in `X.Y.Z`. Fragments added on `master` after the branch point are not on the release side and survive: they are `master`'s next version. This is the shape of `7eed61ecd` (v2.1.1 into `master`), whose changelog hunk used to meet `master`'s own in-development section at the top of the file; with fragments `master`'s MDX does not change between releases, so the dated section lands cleanly.
- **A `master` → `release/*` sync** brings `master`'s fragments into the release with their code, which is what that merge means.
- **A fragment edited on `master` after the branch point and folded on the release branch** is a modify/delete conflict at the back-merge. Resolve it by deleting the fragment, and carry the edit into the dated section if it matters.
- **A cherry-picked fix** would leave the same bullet both in a dated section and as a fragment on `master`. The composer refuses a fragment whose text equals a bullet already in a dated section, so the duplicate fails the build instead of shipping twice.
- **A section filed out of order** by a merge is still caught by the parser's newest-first check.

### Validation

Each error names the file and, where there is one, the line:

- the file name pattern, and any non-fragment file other than `README.md`; editor and OS litter (dotfiles, names ending in `~`, `Thumbs.db`, `desktop.ini`) is skipped rather than refused, since `.gitignore` already keeps it out of git and refusing it broke every build while a fragment was open in an editor
- the frontmatter fences, exactly the two keys, no duplicates
- `category` spelled exactly as one of `CHANGELOG_CATEGORIES`
- `weight` as `1`–`100`, with no sign, leading zero or decimal
- a body of exactly one non-blank line that does not open with a list marker or any other block syntax that would turn the bullet into something else: a heading, a blockquote, a fenced-code opener, a thematic break, or a link reference definition
- no `<` or `{` outside a backtick code span: the fold writes MDX, and the website preview parses plain markdown, so without this check the preview would render a bullet that breaks the build at release time
- the inline markdown that `renderInlineMarkdown` accepts
- at compose time: no `_Unreleased_` line left in `changelog.mdx`, no existing `## <in-development version>` section while fragments exist (the fix is the `-dev` bump), no fragment bullet that duplicates a dated bullet, and no two pending fragments with the same bullet (a forward-port of a release-branch fix named for its PR would otherwise ship twice)

The checks run in `changelog-fragments.test.mjs` over the real `changelog.d/`, which takes over the freshness test's real job of failing `pnpm test` on a malformed source; in the generator, and so in the post-edit hook at authoring time; and in the website build. `scripts/generate-changelog-data.test.mjs` is replaced by tests that the JSON is ignored and untracked, and that the turbo wiring above is present.

### Migration

The implementing PR moves every bullet under `## 3.6.0` into a fragment named for its issue (today #1348 under Features, #1345 and #1334 under Bug Fixes, plus whatever lands before it), with weights that reproduce the current order, and deletes the `## 3.6.0` section. The composed section must match the pre-migration text; that is checked once in the PR, not kept as a test. A PR in flight that still edits the old section conflicts one last time and is resolved by turning its bullet into a fragment.

## B. CodeRabbit's summary comment counts as the head's review

### What the comments show

CodeRabbit keeps one issue comment per PR, opened by `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->`, and edits it after every review run. After a clean incremental review (#1195, #1290, #1322) it says three consistent things: a `<!-- recent_review_start -->` … `<!-- recent_review_end -->` block holding "No actionable comments were generated in the recent review." and "Reviewing files that changed from the base of the PR and between `<a>` and `<head>`."; a hidden `<!-- change_assessment_commit:"<head>" -->`; and, since late September, a hidden `final_review_risk_coverage` JSON whose `coveredCommitId` is the head and whose `kind` is `reviewed`.

**#1383 is the counter-example, not an instance.** Its follow-up `0b0e4d758` was never reviewed: CodeRabbit hit its rate limit. The comment nevertheless contains a "Reviewing files … between `ab5e21c6f` and `0b0e4d758`." line, but inside a `rate limited by coderabbit.ai` block, as the planned range of a review that did not run. The recent-review block, `change_assessment_commit` and `final_review_risk_coverage` all stayed at `ab5e21c6f`. A naive search for the range line and "No actionable comments" anywhere in the body would have found both strings and accepted an unreviewed head. That is why the rule below reads each statement only from its own block and requires the hidden markers to agree.

### The acceptance rule

Read with one `gh api graphql` query of the PR's comments (author, editor, minimized flag, body). The head counts as reviewed by the summary only when all of these hold:

1. **Exactly one summary comment.** That means one comment whose first line is the `summarize by coderabbit.ai` marker. Its author is the `Bot` `coderabbitai`, and its last editor is either nobody or that same bot. *Amended after review:* GraphQL documents `editor` only as "the actor who edited the comment", so the comment's edit history (`userContentEdits`, at most 100) is read as well: it must be complete, newest first, every edit made by that bot, and its newest version must be the body read. It is not minimized, and the PR has at most 100 comments, so the read is complete.
2. **No other auto-generated block.** The body carries no other `auto-generated comment: … by coderabbit.ai` opener, so `rate limited` refuses, and so does any state not seen yet.
3. **One recent-review block.** Exactly one start marker and one end marker, in order. Inside it there is exactly one unquoted range line naming two full 40-hex shas. The second sha equals `headRefOid`, and the block has the "No actionable comments were generated in the recent review." line and no "Actionable comments posted" line.
4. **The hidden markers agree.** There is exactly one `change_assessment_commit` naming the head. There is also exactly one `final_review_risk_coverage` that parses as JSON, with `coveredCommitId` equal to the head, `sourceCommitId` equal to `coveredCommitId` (an assessment carried over from an older commit is a shape not seen yet, so it refuses), and `kind` equal to `reviewed`.
5. **The range's start was itself reviewed.** *Added after review:* trusting only the range's end would trust CodeRabbit's incremental chain blind for everything between the last approved commit and the start. The start must be the newest review object's commit, a clean #1307 replay of it (a conflicted one refuses here), or the end of the recent-review block of an earlier version of this same comment, recovered from its edit history (`userContentEdits.diff` holds each version's whole body, verified on six PRs), whose own start is checked the same way, at most 10 steps back. #1290 (approved `9fe7aa1a5`, a reviewed follow-up `4d33e1f32`, then the head) passes through its earlier version.
6. **The base has not moved.** A base retargeted or force-pushed since the newest review object refuses before the summary is used, as on the replay path.
7. **The merge is pinned.** It carries the full `--match-head-commit <head>`, as the replay path already requires: the verdict is about one sha, read from a comment that keeps changing.

Anything else means no review, and the refusal names the failed condition, so the agent can tell "rate-limited, wait" apart from "not reviewed yet, ask `@coderabbitai review`".

### How it sits beside the existing paths

- **Cheap checks first, unchanged.** `reviewDecision` must be `APPROVED`, CodeRabbit must have approved at some point, and every check must be green. A `CHANGES_REQUESTED` stays a deny whatever the summary says. CodeRabbit files findings as `CHANGES_REQUESTED` with "Actionable comments posted" (PR #1300), so a follow-up that drew findings is refused through `reviewDecision` before the summary is read.
- **A review object at the head keeps today's path.** The summary is read only when no CodeRabbit review object exists at the head, and before the replay. Accepting at the head ends the check without any git work.
- **The summary is also a replay source.** When the summary passes rules 1–6 for a commit `S` that is not the head, and the comment was edited after the newest review object was submitted, `S` is the reviewed commit the #1307 replay starts from. Otherwise the review object is the start, as today. Without this, the common sequence of an approval, a clean incremental review of a follow-up, then a rebase is refused as a follow-up push. The base-moved check keeps the newest review object's `submittedAt`, which is the earlier time and therefore the stricter one.
- **Unresolved threads do not block by themselves.** The `master` ruleset has `required_review_thread_resolution: false`, and a CodeRabbit finding blocks through the `CHANGES_REQUESTED` that comes with it, until CodeRabbit approves again. A thread rule would add a resolve step that neither the review object path nor GitHub requires.
- **`--admin` keeps its meaning.** It skips every review check, this one included.

### Trust

The author check holds: a `[bot]` login is reserved for its GitHub App, and checking the editor closes the one forgery an agent could attempt with the maintainer's token, which is editing the comment. The wording is the weak part. It is prose that CodeRabbit may change at any time, and the hidden markers are undocumented. The rule is built so that a change can only cost an acceptance, never create one. A reworded line, a renamed marker or a new block fails a condition, and the gate falls back to today's behaviour: ask for a review, or `--admin` by the maintainer. A misreading would need the visible block and two machine markers to name the same head while the review did not run, and #1383 shows they did not. The remaining risk is CodeRabbit asserting coverage it did not perform. That is the same trust the gate already places in its `APPROVED` review object.

## Out of scope

- **A CI check that a user-facing PR carries a fragment**, and a command that scaffolds one.
- **GitHub Release notes.** They stay generated from PR labels.
- **The format of dated sections in `changelog.mdx`**, and any rewrite of past releases.
- **Regenerating `changelog.json` inside `rollup -w`.**
- **CodeRabbit's configuration and rate limits**, and prompting it to review.
- **The existing path's acceptance of any non-empty CodeRabbit review object at the head, whatever its state.** Tightening it is #1388, sequenced after this.
- **Requiring resolved review threads**, as decided above.

## Testing

**A — fragments and the fold**

- **The parser.** Every rejection in *Validation* names its file and line. CRLF is accepted, `README.md` is exempt, and a stray or mis-named file is refused.
- **The sort.** Weight descending, then issue ascending, then code-unit name, and the result is the same for shuffled input.
- **The composer.** The section goes before the first `##`. No fragments leaves the MDX unchanged. An `_Unreleased_` line, an existing in-development section and a duplicated dated bullet are each refused. The real tree composes and parses.
- **The fold, in a temporary git repository.** A stable version writes the dated section, deletes and stages the fragments, and neither writes nor stages `changelog.json`. A pre-release and zero fragments are each a no-op. An invalid fragment aborts with the tree untouched, and the dry run writes nothing.
- **Readers agree.** The website JSON equals the generator's output, the partial renders the composed data, and the remark plugin's section matches `renderReleaseSection`. `pnpm --filter @iracedeck/website build` passes with a fixture fragment, and the section appears in the table of contents.
- **Wiring.** The JSON is ignored and untracked, all three plugin builds depend on `//#generate:changelog-data`, and its inputs cover `changelog.d/**`. Positive control: `turbo run build --dry=json` shows the plugin builds' hash changing after a fragment edit.
- **Back-merge rehearsal, in a temporary repository.** A release branch folds `X.Y.Z` while `master` adds its own fragments. The back-merge is clean, `master`'s fragments survive, the inherited ones are deleted, and the result composes.
- **Positive controls.** Drop the issue tie-break, the `<`/`{` check or the duplicate-bullet check, and a test fails.
- **By hand.** `pnpm release:dry` on a tree with fragments prints the section. A `-dev` build's What's New tab shows the fragments as the Unreleased release.

**B — the summary**

- **Real bodies as fixtures, verbatim** except the change-stack link's token-shaped `scope` value, which is redacted.
  - #1290, #1322, #1381 and #1382 are accepted at their heads.
  - #1383 is refused at `0b0e4d758` (rate limited), and its recent review yields `S = ab5e21c6f`.
  - #1195 is refused because it predates the coverage marker. That is the fail-closed direction, kept as a test.
- **Doctored variants, one per condition.** A User author, a foreign editor, a minimized comment, two summaries, a quoted or short range line, a range ending elsewhere, "Actionable comments posted", and a missing, duplicated or disagreeing marker are each refused.
- **The rule, with stubs.**
  - No GraphQL read happens when a cheap check refuses, and none when a review object is at the head.
  - The pin is required on this path.
  - `CHANGES_REQUESTED` denies even with a valid summary.
  - `--admin` skips the check.
  - `S` becomes the replay source only when the comment is newer than the review object.
- **Positive control.** Remove the marker cross-check and the #1383 fixture is accepted, so a test fails.
- **Watched firing** (`hooks.md` rule 6). Pipe a payload through `pre-bash.mjs`, then use the gate on the next PR with a reviewed follow-up commit.

## Rules and docs that change

- `.claude/rules/changelog.md`: rewritten for fragments, covering the format, weight and tie-break, "one change, one fragment" (a follow-up PR edits the existing fragment), the fold, and the post-edit validation.
- `.claude/rules/build-and-commit.md`: *Releasing* (the fold), *Back-merging a release branch* (fragment deletions and the modify/delete case), and the changelog bullet under *Merging*.
- `.claude/rules/hooks.md`: the `gh pr merge` row, and the PostToolUse generators line.
- `.claude/rules/issue-workflow.md`: step 11's gate cell, plus "Expect a fresh review after every push" in step 10.
- `.claude/rules/code-review.md`: the xhigh row names the fragment format, parser and fold beside the changelog parser.
- `.claude/rules/settings-window.md` and `pi-templates.md`: `changelog.json` is generated by a turbo task and is gitignored.
- `.claude/rules/website-screenshots.md`: a fragment edit is a What's New copy change.
- `.claude/skills/release-notes/SKILL.md` and `.claude/skills/website/SKILL.md`: the in-development notes are in `changelog.d/`.
- `.claude/CLAUDE.md`: the `changelog.md` index line.
- `packages/audio-assets/CLAUDE.md`: its "regenerate, never hand-merge" contrast.
- `packages/app-updates/CLAUDE.md`, if its wording implies a committed artifact.
- `README.md` *Releasing*: step 3 and "The changelog is not generated".
- `scripts/claude-hooks/rules-post.mjs`: the generator entry matches `changelog.d/*.md` as well as `changelog.mdx`, and its comment says why, which is validation at edit time and the local build copy.
- `scripts/CLAUDE.md`: the `release-hooks.mjs` line (fold, not stamp), the `lib/` list (`changelog-fragments.mjs` in, `changelog-stamp.mjs` reduced), and the hooks section's merge-gate sentence.
- The Architecture page needs no change: it draws only the published `changelog.json`, which keeps its shape and source.
- The changelog itself: a **Maintenance** line at most, since users see no change.
