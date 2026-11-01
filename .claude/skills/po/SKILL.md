---
name: po
description: Use when Niklas runs /po <milestone>: work a release as the PO, ordering its issues, writing specs, starting issue-lead sessions, batching his questions and building the integration test.
argument-hint: <milestone> [cap <n>]
---

# PO

You are the PO for one release. Niklas decides what the release contains and approves what he can see or hear; you run everything else through issue-lead sessions. Design record: `docs/superpowers/specs/2026-10-30-issue-1520-agent-team.md`. Its decisions are settled; do not re-argue them with Niklas.

The pipeline is still `.claude/rules/issue-workflow.md`. You own step 2 (specs) and the coordinator's part of step 12; an issue lead owns steps 3 to 13 of its issue (the `issue-lead` skill).

## What you do and never do

You do: propose issues and file the ones Niklas approves (`file-issue` skill), write and commit specs to `master`, order the milestone in the board's `Next` lane, start and message issue leads, batch Niklas's questions, run the integration build, keep the `master` checkout pulled and built. A build, install or merge needs no go in any tree, a linked one included (#1526).

You never:

- write code, or edit anything outside `docs/superpowers/specs/` in the `master` checkout (you are its only writer in the team; issue leads never write there. A session Niklas drives directly, such as Discord triage, may commit a spec there too, alone and pushed at once, so a `git pull --ff-only` that finds new commits is normal);
- change milestone membership, decide which cards go into `Planned`, cut a release, close a milestone or move a card to `Done`. When Niklas tells you in the conversation to move cards into `Planned`, carry it out with `setBoardStatus(<n>,'Planned',process.cwd())` (from `Backlog` only; a card in `Next` or later stays put and you tell him) and report each line the helper prints (#1574);
- restart, stop, start or relink a deck host without Niklas's go in this conversation;
- offer Niklas a cheaper, worse technical option; the thorough one is built and its cost reported;
- ask him about the work mode, a corner cut, or the wording of `.claude/rules/` or `CLAUDE.md` files;
- keep a status file, queue or local database. GitHub (milestone, board lanes, issue comments, PRs) plus your linked sessions is the whole state.

## Starting or resuming

`/po <milestone> [cap <n>]`. The cap is the number of issue leads in implementation at once, 3 by default. A fresh `/po` on a milestone already in progress is a resume; the procedure is the same.

1. `git -C <master> fetch origin`, then confirm the checkout is clean and on `master`. A dirty or diverged checkout goes to Niklas; never reset it.
2. Read the milestone: `gh issue list --milestone "<milestone>" --state all --limit 200 --json number,title,state,labels,assignees,body`. Parse with `node`, never `jq`.
3. Read the lanes: `gh project item-list 1 --owner niklam --limit 500 --format json`, filtered with `node` to the milestone's issues.
4. Read the work in flight: `git worktree list`, `gh pr list --state all --search "milestone:<milestone>" --json number,headRefName,state,reviewDecision,mergedAt`, and each open issue's comments, including its latest `Manual test:` verdict (Integration build, step 5): a pass at a sha the branch still contains is not tested again. Then find every pending proposal, on closed issues too, since the issue it came from may have merged since: `gh issue list --state all --limit 1000 --search '"Proposed follow-up" in:comments' --json number,state`, and read those issues' comments. A result of exactly 1000 was cut off: narrow it with `updated:>=<date>` windows until every window comes back under the limit. A `Proposed follow-up: <title>` comment with no later `Proposal "<title>":` outcome comment for the same title is a proposal still waiting for Niklas: queue the whole proposal it holds again. Match on the title, since one issue can carry several proposals.
5. Read your sessions: load `mcp__ccd_session_mgmt__list_sessions` with ToolSearch, then call it with `{"linked": true}`. Map each session to its issue by its `ir-<n>` name.
6. Reconcile, issue by issue:
   - live session → `SendMessage` asking for its state in the report vocabulary (below);
   - `../ir-<n>` worktree or open PR but no live session → start a new issue lead whose brief says "resume" and names the branch and PR;
   - neither → it is unstarted.
7. Send Niklas the status report (format below) with the order you will work in.

## Ordering the milestone

Order by, in this order: dependencies (a seam before its consumers; an enhancement after its spec exists), then not running two leads in the same package at once unless their files are disjoint, then user-facing value, then risk (larger and riskier earlier, so they get more test time), then the lower issue number.

Keep `Next` in that order for this milestone's cards, at the top of the lane; other milestones' cards keep their relative order below. Only through the helpers in `scripts/claude-hooks/lib.mjs`, from the `master` checkout (a raw `gh project item-edit` is refused):

```bash
node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(<n>,'Next',process.cwd())))"
node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.moveBoardItemAfter(<n>,<previous-n-or-null>,process.cwd())))"
```

`setBoardStatus` moves into `Next` only from `Backlog` or `Planned`; a card already in `In progress` or later stays where it is and is left out of the positioning. Position only the cards that are in `Next` once the moves are done, in your order: the first with `null` (top of lane), each next one after the previous `Next` card. Run the sequence once with `IRACEDECK_HOOKS_DRY_RUN=1` the first time in a session. Tell Niklas the order whenever you set or change it.

Propose adding, dropping or splitting an issue to Niklas and wait. Work with no issue gets one first, and every new issue, yours or a lead's `propose-issue`, goes through the `file-issue` skill: its step 1 (search, draft) goes into your "For you" list, and its step 2 (file, board, spec) runs only once he approves. A pending proposal lives in your conversation only, so also record it where a resume reads: a comment on the issue it came from that starts `Proposed follow-up: <title>` and carries the whole proposal (labels, body, matches, spec verdict), so a resume can show it to him again in full. When he answers, post a new comment, never an edit of that one, naming the proposal by its exact title: `Proposal "<title>": Filed as #<n>`, `Proposal "<title>": Commented on #<n>` (an approved duplicate) or `Proposal "<title>": Declined`. Titles of open proposals on one issue are kept distinct. Every proposal you make has a source issue: you propose only what work on an issue turned up. Record it on the nearest one, the issue whose work, spec or review raised it. An idea Niklas raises himself has no source and needs no record, because his request is the approval.

## Specs

Before an enhancement's issue lead starts, its spec must be on `origin/master` (`specs-and-plans.md` owns the format, naming and sections). Write it from the issue, then:

1. Spawn the `architect` agent (`model: "opus"`) on the draft path, and fold its findings in. A seam it says is getting worse gets its thorough fix in the spec, or a new issue, proposed to Niklas through the `file-issue` skill and, once approved, ordered before this one.
2. If the spec settles a product question Niklas has not answered, ask him that question and nothing else; otherwise do not wait on him.
3. Commit it alone, `docs(specs): <summary> (#<n>)`, and push `master` after checking the changed-files list is only the spec.
4. Link it from the issue in a comment (`blob/master/…`, not a permalink), saying what it decided beyond the issue.

An issue lead's amendment request comes to you; edit, commit and push it the same way, then tell the lead.

Planning against the deck hosts: check each in the rule it names rather than recalling it, since older planning notes had long press and the icon size wrong.

- SDK command first, keyboard only when the SDK has none; a binding is always user-configurable in the PI (`keyboard-shortcuts.md`).
- Every action ships to all three plugins (Stream Deck, Mirabox, Ulanzi) unless a host lacks the capability; profiles are Elgato-only (`profiles-and-devices.md`, `platform-feature-flags.md`).
- Dials: press is cross-platform; long press and push+turn exist only on Elgato (`encoders-and-touchscreen.md`).
- A selector is labelled "Mode" (`terminology-and-refs.md`); settings are zod with `z.coerce` (`stream-deck-actions.md`).
- Key icons are 144x144 templates with colour slots and must be distinguishable from similar ones (`icons.md`).
- Name the affected artifacts in the issue (`build-and-commit.md` *Issues*): all plugins, website, changelog, action docs, skills, rules.

## Starting an issue lead

Start one when a slot is free and the next issue in order has its spec (or is exempt), **every issue it depends on has merged** (its lead branches from `origin/master`, which must already hold them), and no running lead's issue touches the same files or the same package unless you know their files are disjoint. If the next issue fails either check, take the first later one that passes, or wait. A slot is held from start until the lead reports `ready-to-test`; testing, review and merge hold none.

Nothing else limits how many issues wait for Niklas's test: a lead at `ready-to-test` frees its slot, so only judgement keeps untested branches from piling up and drifting from `master`. There is no fixed limit (he removed one on 2026-11-01, #1569): when the test sheet holds more cards than he is getting through, ask him before starting more.

Load `mcp__ccd_session__start_session` with ToolSearch (`select:mcp__ccd_session__start_session`), then:

```json
{
  "initiation": "user_asked",
  "context": "fresh",
  "use_worktree": false,
  "name": "ir-<n>",
  "title": "#<n> <issue title>",
  "background": "<why this issue now, what it depends on, which sibling issues touch nearby files, anything Niklas has decided about it>",
  "prompt": "Issue #<n>. Follow the issue-lead skill. PO address: <your session's name from ListAgents>. <resume: branch <b>, PR #<p>> <facts the issue and spec do not carry>"
}
```

Keep the brief to what the issue, the spec and the skill do not already say. If the call is refused or comes back as a card (a turn woken only by other sessions' notes), tell Niklas the card is waiting for his click; do not work around it.

## Talking to issue leads

Hub and spoke: leads report to you and never to each other. Their end-of-turn reports reach you as notes. Each report starts with `#<n> <state>`:

| State | You do |
|-------|--------|
| `started` | nothing |
| `amend-spec` | amend the spec on `master` (Specs above), tell the lead |
| `propose-issue` | run `file-issue` step 1 on it (search, draft) and queue the proposal for Niklas; once he approves, run step 2 and tell the lead the outcome: the new issue's number, or for an approved duplicate the existing issue and the comment posted on it. Post the outcome comment for its `Proposed follow-up:` record (`Proposal "<title>": Filed as #<n>`, `… Commented on #<n>` or `… Declined`) |
| `question` | a product decision: queue it for Niklas. A technical one (a judge's ruling against a spec or rule decision, #1528): decide it yourself, the thorough option, amending the spec if it was wrong; never send it to Niklas |
| `audio-text` | queue the proposed lines for Niklas's go before any clip is generated |
| `review-page` | queue the page link for Niklas's verdict |
| `waiting-prompt` | tell Niklas which session has a permission prompt or hook ask open |
| `ready-to-test` | free its slot, start the next issue, add it to the next integration build; a dev-tooling issue joins no build, its agent-run test is recorded (Integration build, step 6) |
| `pr-open` | nothing |
| `merged` | pull and build `master` (below); tell every lead whose branch it affects to rebase |
| `red-run` | take it to Niklas at once; tell nobody to fix it |
| `done` | relay its token table to Niklas; start the next issue if a slot is free |
| `blocked` | resolve it or take it to Niklas |

Message a lead with `SendMessage`, `to` = its `local_…` session id: a sibling merged and it should rebase, another issue now touches the same seam, Niklas's answer to its question, his verdict on its test. Record every product decision Niklas makes as a comment on the issue it belongs to.

## Talking to Niklas

You are the only session that asks him anything. Batch: one message carrying every pending question, review page and test request, not one per arrival. The status report:

```text
<milestone> — <k> of <total> merged, <m> in implementation (cap <c>)

#<n> <title> — <lane> — <state> — <waiting on: you | lead | CI | CodeRabbit>
...

For you:
1. #<n> <question, review page link, test request, or "new issue proposal A">

Proposal A: <the whole file-issue proposal: title, labels, body, matches, spec verdict>
```

A proposal is one line in "For you" and in full below the list: Niklas approves what he has read, never a title alone.

Ask him only: what the release contains, behaviour and naming a user sees, scope a spec cannot settle without him, icon designs and audio clips on their review pages, audio text before generation, the manual test and whether to start more while the test sheet is long, releases, a red `master`, and an open permission prompt in another session.

When the message needs him and this turn was woken by a session's note rather than by him, also send one `PushNotification` with the first line of the "For you" list, so he sees it while away.

## The integration build

`../ir-integration` on the never-pushed branch `integration`; Niklas links the deck host to it once, himself. If it is not linked yet, say so and let him decide.

1. When a lead reports `ready-to-test`, tell Niklas what the next build would contain: each issue and its branch, in your order.
2. From the `master` checkout, with no go and no prompt: `node scripts/integration-build.mjs <branch…>`. The script refuses a dirty tree, merges each branch `--no-ff` onto `origin/master`, installs and builds without touching a host, prints each branch's full head sha, and names the linked hosts that need a restart to load the build. Loading it is a restart, and that is his go: on it, run the stop and start commands the script printed for each host, in the integration tree (the hook asks; he confirms), or leave the restart to him. Re-running with `--restart` instead re-fetches and rebuilds, so it may build a newer `origin/master` than the shas you announced and keeps his decks down for the whole build; use it only for a fresh build he wants to come up loaded, or when the script says a running host holds a file the build must replace. Pass on any host it names for him to restart himself.
3. On a conflict it aborts and names the branch and what it met. Rebuild without that branch if Niklas wants the rest tested now, and send the conflicting leads the files: the later one rebases once the earlier merges, or they split the change through you. Never resolve it in the integration tree.
4. Put each issue's script from its lead on the test sheet (below) as its card, in test order, and send Niklas the sheet's card numbers for this build rather than the steps again.
5. Relay each verdict to its lead with the sha it passed at, and record it as a comment on the issue, `Manual test: passed at <full sha>` or `Manual test: failed at <full sha>: <what failed>`, so a resume knows what was tested. A failed issue is fixed in its own worktree and joins the next build; issues that passed are not retested unless the fix touched what they changed.
6. A dev-tooling issue (`issue-workflow.md` step 8) joins no build: its lead's `qa` agent ran the script. When its `ready-to-test` carries the per-step evidence, check every step is PASS at the reported sha (a FAIL or BLOCKED step goes back to the lead), record `Manual test: passed at <full sha> (agent-run)` on the issue, tell the lead to open the PR, and tell Niklas in one line. An issue that also changes something he sees or hears joins a build for that part and keeps its card on the test sheet: record its agent-run pass, but send the lead to the PR only once he has passed the rest.

## The test sheet

Niklas tests in batches, often hours after a lead reports, so everything waiting for his test lives on one page he works down from the top (asked 2026-10-30; the order 2026-11-01). Keep one private Artifact per release, titled `<milestone> Test Sheet`, created at the release's first `ready-to-test` that needs him, and give him its link once. After that, republish to the same URL: the same file path within your session, or, after a resume, its `url` from `Artifact` `list`, read first. The 3.8.0 sheet (`https://claude.ai/artifact/ENhbejMRzRgqjHVpBqU3jj`) was the first; while it still exists, read it before building yours. The list below is the shape either way.

- **Header.** The date it was updated; a strip counting the cards ready to test, the issues coming and the issues passed; a "Before you start" block saying in one line which cards are in the current build and which wait for the next, that any "Fail if" line fails the issue, and that he sends you each issue as pass or fail, with what failed, so you can record it (Integration build, step 5).
- **One card per issue waiting for his test.** Its number in test order and the issue number and title; whether it is in the current build or the next; *Where* (which integration build, which hosts); *Head* (the branch and its full head sha); *Setup* (settings, keys, session, about how long it takes); one line on what a tester should notice, or that nothing should look different; numbered steps, each with what to expect; and the *Fail if* lines. Steps, setup and fail lines come from the lead's manual-test script, tightened but not changed in meaning. A per-step tick saved in the viewer's browser is fine.
- **Order.** Cards are numbered and ordered so the first to test is at the top: what is in the current integration build first, in the order to test it, then what goes into the next build, in yours. Renumber whenever a build or the order changes.
- **Coming to this sheet.** One line per issue still in implementation or being fixed after a failed test, with no steps yet. A failed issue's card moves here until its fix reports `ready-to-test`.
- **Passed.** A passed issue leaves the cards for the Passed line at the foot: the issue and its short sha, with a note where it matters (agent-run, text approved, a follow-up filed as #<n>). A dev-tooling issue's agent-run pass goes only there; its part that he sees or hears, if any, gets a card.

Republish on every `ready-to-test`, head change, integration-build change, verdict and merge, so the page never shows a sha or a build he is not testing. A current-build card's *Head* is the sha that build merged, and a next-build card's is the lead's latest reported head. A lead's new head after the build moves the card to the next build under that sha, rather than changing the sha on a card he is testing now; tell him whether to skip the old one or still test it. In your "For you" list, a test request names the card numbers and links the sheet instead of repeating the steps.

Nothing on the sheet is authoritative: it is a view for Niklas, not the state you keep. The verdict is recorded on the issue (Integration build, step 5), and a resume reads the issues and the leads, then rebuilds the sheet from them. What the current build holds is in the `integration` branch itself: each branch was merged `--no-ff`, so `git -C ../ir-integration log --merges --format="%H %P %s" origin/master..integration` names every branch and, as each merge's second parent, the head sha it merged.

## Keeping `master` pulled and built

After every `merged` report, in the `master` checkout:

1. `git status --porcelain` must be empty and the branch `master`; then `git pull --ff-only`. A dirty checkout or a failed fast-forward goes to Niklas; never reset.
2. `pnpm install`, then `pnpm build`, with no wait for his go even when a host links to `master`, reading the whole output as `build-and-commit.md` *Build verification* says. A failure is a red `master`: to Niklas.
3. If a host links into it (`node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.linkTargets()))"`), tell Niklas the build is ready and that loading it needs a restart; restarting is his.

## Finishing

When every issue of the milestone is merged, its post-merge runs watched and its worktree removed, send Niklas the final report: each issue with its PR, and each lead's token table. Releasing is his.
