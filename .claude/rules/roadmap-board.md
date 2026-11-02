---
paths:
  - "scripts/claude-hooks/lib.mjs"
  - "scripts/claude-hooks/lib.test.mjs"
  - "scripts/claude-hooks/post-bash*"
  - "scripts/claude-hooks/rules-bash*"
  - "scripts/claude-hooks/rules-post*"
  - "scripts/claude-hooks/rules-tools.test.mjs"
  - ".claude/skills/po/**"
  - ".claude/skills/issue-lead/**"
  - ".claude/skills/file-issue/**"
---

# The Roadmap board — how cards move

The mechanics behind the lanes, for whoever edits the board helpers or the post-bash hook, or moves cards as the PO. The board's purpose, its lanes and who decides what are in *Issue labels* in `@.claude/rules/build-and-commit.md`; this file was moved out of it in #1501 to keep the always-loaded set inside its budget.

## The four hook moves

The post-bash hook (`@.claude/rules/hooks.md`) moves a card four times: an issue filed with `gh issue create` goes onto the board in `Backlog`; `gh issue edit <n> --milestone <m>` moves its card from `Backlog` to `Planned`; `git worktree add ../ir-<n>` moves it to `In progress`; and `gh pr merge` moves the issues the PR closes to `Testing`. Each reports when it could not, and the move is then made by hand through the same helper, from the repo root:

```bash
node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(<n>,'In progress',process.cwd())))"
```

A raw `gh project item-edit` is refused (#1574). The worktree hook moves only the issue the tree is named for: a second issue solved in the same worktree gets its card, milestone and assignee by hand when the tree is created, and the merge hook then moves both.

The `Testing` move is a hook rather than a board workflow because the project's built-in "pull request merged" workflow acts on a PR that is itself an item on the board, not on the issue the PR closes — which left #1065's card in `In progress` after PR #1128 merged.

## `Planned`, `Next` and the moves back

Which cards go into `Planned` is Niklas's call alone; an agent carries it out with `setBoardStatus(<n>,'Planned',…)` only on his word in the conversation, never on its own judgement (#1574). An open issue with a milestone sits in `Planned` until work starts, or in `Next` where the PO keeps its milestone in order, then moves on as above. Setting the milestone moves the card; removing one moves nothing back, and the move back is Niklas's, in the board UI. The helper takes a card into `Planned` from `Backlog` (or no lane) only, never back from `Next` or later.

The order inside a milestone he has planned is delegated to the PO (#1520): it keeps that milestone's cards at the top of `Next`, in its order, with `setBoardStatus` and `moveBoardItemAfter`, leaves other milestones' cards in their order below, and tells him the order whenever it sets or changes it. The lanes each helper move may start from are `BOARD_MOVES` in `lib.mjs`; none goes backwards (`hooks.md`, rule 3).

## `Done` and the field itself

`Done` is a release step, not a merge step: cutting a stable release closes its milestone and moves every card of that milestone from `Testing` to `Done` — the step and its helper call are in *Releasing* in `build-and-commit.md`.

Lanes need the `project` token scope (`gh auth refresh -s project,read:project`). Never rewrite the `Status` field's option list through the API — the hook refuses it, because `updateProjectV2Field` replaces the options and regenerates their ids, which clears every card's lane; add a lane in the UI instead.
