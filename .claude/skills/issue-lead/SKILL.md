---
name: issue-lead
description: Use when a PO session starts you on an issue: own it from worktree to merge in ../ir-<n> through role agents, reporting every state change to the PO and asking Niklas nothing directly.
---

# Issue lead

You own one issue, steps 3 to 13 of `.claude/rules/issue-workflow.md`, and report to the PO session that started you. Design record: `docs/superpowers/specs/2026-10-30-issue-1520-agent-team.md`. Read the issue (`gh issue view <n> --comments`), its spec on `master` (`docs/superpowers/specs/*-issue-<n>-*.md`) and `issue-workflow.md` before anything else.

## Where you work

Your session's cwd is the shared `master` checkout. Work only in `<repo parent>/ir-<n>`: absolute paths for files, `git -C <tree>` for git, and an explicit `cd <tree> &&` before any `pnpm` command (the shell's cwd resets).

Never, in the `master` checkout: edit, commit, stage, switch branch or pull. A spec amendment goes to the PO. `git worktree add` and `gh` from there are fine.

Never: restart or relink a deck host; run `pnpm build:with-restart`, `restart:*`, `watch:*`, `link:*`, `relink:*`, `unlink:*` or `node scripts/integration-build.mjs` (the PO's); message another issue lead; ask Niklas anything yourself (no AskUserQuestion); offer a cheaper, worse option. Build the thorough fix and report what it cost.

## Reporting to the PO

End every turn that changes your issue's state with a report whose first line is `#<n> <state>: <one line>`. It reaches the PO as a note. States: `started`, `amend-spec` (the change and why), `question` (one decision, the options and your recommendation), `audio-text`, `review-page`, `waiting-prompt`, `ready-to-test`, `pr-open`, `merged`, `red-run`, `done`, `blocked`.

Before running a command a hook will ask on (`hooks.md` lists the asks), send `#<n> waiting-prompt: <the command>` to the PO with `SendMessage` (`to` = the PO address in your brief), then run the command in the same turn, so the prompt is open while the PO tells Niklas. Never end the turn to report it: the command would not have run, and nothing would resume it. Messages from the PO arrive by `SendMessage`; act on them.

## Resuming

If the brief says resume, or `../ir-<n>` already exists: read `git -C <tree> status`, `git -C <tree> log --oneline origin/master..HEAD`, the PR if any (`gh pr view <branch> --json state,reviewDecision,statusCheckRollup,headRefOid`) and the issue's comments, then continue from the first step not done.

## 3. Worktree

```bash
git fetch origin
git worktree add ../ir-<n> -b <type>/<n>-<short-description> origin/master
gh issue edit <n> --add-assignee @me
```

Branch naming: `build-and-commit.md`. The hook moves the card to `In progress`; if it reports it could not, make the move with its helper. If the issue needs audio generation, copy `.env.local` from the `master` checkout into the tree. Write the plan to `<tree>/docs/superpowers/plans/` (gitignored, `specs-and-plans.md`). Report `started`.

## 4. Implement

Through subagents, each spawned with the `model` its task needs (`CLAUDE.md` mapping, per task, never per issue), never with worktree isolation:

- `implementer` for code. Several at once only on disjoint files; tell each its files, the tree, and that it commits with `git commit --only -F <msgfile> -- <paths>` and tests only its own files.
- `documenter` for step 6.
- `qa` for test scaffolding, the scenario harness or the hands-free sim probe where they apply, review pages and the manual-test script.
- `architect` (`opus`) only when the branch touches a seam: the `@iracedeck/event-bus` catalog, `IDeckPlatformAdapter` / `SettingsHost`, `SimConnection` / `SimRuntime`, a new package, a new edge in the internal dependency graph, or an import across the sim boundary. Run it once the design is in code and before the `/code-review`. Build the thorough fix it names, or send it to the PO as `amend-spec` when it belongs in its own issue.

Review a task's output before another task builds on it; verify small fix diffs yourself (`code-review.md` *How reviews are staged*). Small edits you make yourself.

**Audio.** No clip is generated or regenerated before Niklas has approved its text: report `audio-text` with each line as voice / group / entry / text, and wait. Check the tree for hand edits before generating (`git status`, mtimes). After generating, leave the clips uncommitted, have `qa` build the review page (`review-page` skill) and report `review-page` with its link. Commit the clips only after his approval; redo the entries he names.

**Icons.** Leave the icon SVGs uncommitted until approved: `qa` builds the review page, you report `review-page`, and on approval commit the SVGs with their regenerated previews (`cd <tree> && node scripts/generate-icon-previews.mjs`).

## 5. Gates

In the tree, by hand: `pnpm install` → `pnpm build` → `pnpm typecheck` → `pnpm format` → `pnpm lint` → `pnpm test`. Read the whole build output (`build-and-commit.md` *Build verification*). Run long gates in the background wrapped in `timeout`. Fix every warning and error.

## 6. Document

`documenter` writes what a user-facing change needs: the website pages, the changelog fragment, `README.md`, the Architecture page when packages or seams changed, and the rule and `CLAUDE.md` files whose conventions moved. Re-run the gates it affects.

## 7. Review

Do not ask whether to review; it is your call, at the level from the table in `code-review.md`:

1. `/code-review <level> <tree>` with the scope block that rule prescribes. Baseline `git status --porcelain` in every worktree first and check them after. Verify each finding; apply the ones that hold.
2. The `second-read` skill when the diff is a gate or guard, a build, release or publish path, or a state machine. Same disposal.
3. The CodeRabbit CLI on the final branch, after every fix commit: from the tree, `coderabbit review --agent --committed --base master` in the background, output to your scratchpad. Check `reviewedFiles` against `git diff --stat origin/master...HEAD`.
4. **Your declines go to a judge (#1528).** You wrote the code, so you do not get the last word on a finding against it. After each of the three rounds above, collect every finding you would not fix as asked on the branch (declined, "does not hold", "no change needed", skipped, filed as an issue instead) and spawn ONE fresh `general-purpose` agent, `model: "opus"`, told it is read-only (edit nothing, run no build or test, spawn no agent) and with `git status --porcelain` baselined in every worktree before it and checked after, given only: the tree and `origin/master...HEAD`; each finding verbatim with its file, line and source; your reason in a sentence or two. Never your plan, the spec rationale or this conversation. Ask it to read the code itself and rule on each separately, **upheld** or **overruled**, with the evidence it read. A round with no declines spawns nothing; a finding you fix is not judged.
   - An **overruled** finding is fixed. Do not argue it back. The one exception: a ruling that would contradict a decision a spec or rule file records goes to the PO as `question`, with both.
   - Record one line per source in the PR body, naming it: `Judged declines (<source>): N, U upheld, O overruled.`, where `<source>` is `/code-review`, `second read`, `CodeRabbit CLI` or `CodeRabbit PR`.

## 8. Manual test

`qa` writes Niklas's manual-test script: setup, steps, the expected result of each, and what changed for a tester. Report `ready-to-test` only once every clip and icon the issue changes is approved and committed, and the tree is clean: the integration build merges the committed head sha and nothing else, so an uncommitted change would be missing from what he tests. Report the branch, its full head sha and the script. The PO builds it into the integration worktree and relays his verdict.

- **Failed:** fix in the tree, re-run the gates, report `ready-to-test` again with the new sha.
- **Passed:** the pass belongs to that sha. A later rebase, conflict resolution or CodeRabbit fix does not void it; ask the PO for a retest only when a change alters behaviour he tested.

**Dev tooling** (hooks, repo scripts, the commit hook, build or CI tooling; `issue-workflow.md` step 8): dispatch `qa` to write the script and run it for real against the committed head (its job 5), not to hand it to Niklas. Report `ready-to-test` with the branch, the full head sha it ran at, the script and the per-step evidence: each step's result and its decisive output line, and where the full output is saved. Only a run with every step PASS is ready; a FAIL is a defect to fix and rerun, and a BLOCKED step (a signed-out CLI, a missing tool) is fixed and rerun, or reported `blocked`. The PO records the pass and sends you to step 9. A later change that alters tested behaviour is retested by `qa` the same way, and reported `ready-to-test` again with the new sha. A part of the issue Niklas would see or hear still goes to him.

With nothing runnable (docs or rules only), send the user-facing text (website pages, fragment) in full for his approval instead. Rule and `CLAUDE.md` prose needs none.

## 9. Push and open the PR

Without asking, once he has passed it:

```bash
git -C <tree> push -u origin <branch>
gh pr create --base master --head <branch> --title "<type>(<scope>): <description> (#<n>)" --body-file <scratchpad>/pr-body.md
```

The body follows `.github/pull_request_template.md`, carries `Fixes #<n>`, the second-read tally line when one ran, the `Judged declines` lines, and any vacuous test condition with what covers it. No AI references. Report `pr-open`.

## 10. Babysit the PR

Load `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__get_status` and `mcp__ccd_pr__set_monitor` with ToolSearch, bind the PR and turn Auto-fix on. It wakes you on CI failures, conflicts and review comments, not on an approval.

- Fix every finding that holds, nitpicks included, and answer every thread: the fix commit, or the reason it does not hold (`issue-workflow.md` step 10). Never push while CodeRabbit's review is in progress.
- A thread you would reject goes to the judge first (step 7, item 4), batched per CodeRabbit review. Upheld: reply with your reason plus "upheld by an independent judge". Overruled: fix it and reply with the commit.
- The approval: act on it when a monitor event brings it; otherwise check `gh pr view <pr> --json reviewDecision,reviews,headRefOid` with a `Monitor` until-loop at an interval of ten minutes or more, with a timeout. That is a review check, not CI polling.
- CodeRabbit traps: a clean incremental review updates only its summary comment and posts no new `APPROVED`. Over a standing `CHANGES_REQUESTED`, `@coderabbitai approve` once. A rate-limited summary means not reviewed: wait for the reset, then `@coderabbitai review`. Read the "Recent review info" block's range, not a "between" line found anywhere in the comment.
- When the PO says a sibling merged: `git -C <tree> fetch origin`, `git -C <tree> rebase origin/master` (never merge `master` in), re-run the gates, `git -C <tree> push --force-with-lease`.

## 11. Merge

When CodeRabbit has approved and every check is green at the current head:

```bash
gh pr merge <pr> --squash --match-head-commit <full head sha>
```

The hook judges the head; act on what a refusal names. `--admin` only when Niklas has said so through the PO, after you sent the PO the evidence. Report `merged` with the merge commit's sha.

## 12. Post-merge runs

Watch all four (`ci-format`, `ci-lint`, `ci-test`, `ci-typecheck`) on the merge commit to completion from the `master` checkout: `gh run list --branch master --commit <full sha>`, in a `Monitor` until-loop with a timeout. First check all four appeared. A red one: report `red-run` at once and do nothing else about it.

## 13. Clean up

1. If a deck host links into the tree (`node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.linkTargets()))"`), leave the tree and the link and report `blocked` saying so.
2. Rescue gitignored captures under `local/` that are worth keeping, then `git worktree remove ../ir-<n>`. The remote branch is deleted on merge; `git branch -D <branch>`.
3. Report `done` with the phased token table for your session and its subagents (the `reference_phased_token_report` memory has the method).
