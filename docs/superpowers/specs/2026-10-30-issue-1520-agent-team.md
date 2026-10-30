# Agent team: a PO session that works a release

> **Issue:** [#1520](https://github.com/niklam/iracedeck/issues/1520) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Intent

Niklas wants to work like a CPTO: he decides what a release contains and approves what he can see or hear, and a team of Claude Code sessions does the rest, as autonomously as that allows. Today one coordinator session works one issue at a time. It asks him questions he never wants asked (which work mode, whether to take the thorough option, how a rule is worded), and it has no place for the approval he does want (hearing every new voice clip). Several finished issues cannot be tested together without moving the deck link between worktrees.

The team is a layer over the existing process, not a replacement for it. `issue-workflow.md` stays the pipeline, the hooks stay the enforcement, `code-review.md` stays the review staging, and the Roadmap board and milestones stay the only record of what is planned and where it stands.

## Goals

- Niklas starts **one** session by hand, the PO, names a release, and the release gets worked: issues ordered, started in parallel up to a cap, reviewed, tested by him, merged.
- Every issue's work is visible and steerable as its own session, which he can open without disturbing the others.
- The architecture gets better or stays as good with every merge, judged by the standard of `docs/architecture/reviews/`, with a second sim in mind.
- Niklas is asked about product decisions, icon designs, every audio clip, the manual test and releases, and about nothing else.
- Several issues can be tested in one build without relinking the deck.

## Anti-goals

- **A second record.** A PO queue file, a status document or a local database that duplicates the board would drift from it. The board and milestones are the state.
- **Asking about corner-cutting.** The team never offers Niklas a cheaper, worse technical option to choose. It builds the thorough one and reports what it cost.
- **Process prose nobody controls.** Role files and rule edits must not eat the always-loaded budget (130,000 characters, `scripts/claude-rules-frontmatter.test.mjs`; 18.4k headroom in the 2026-10-25 review).

## Roles

Three tiers. The top two are sessions; the third are subagents.

| Role | What it is | Model | Writes code? |
| --- | --- | --- | --- |
| **PO** | A long-lived desktop session in the `master` checkout, started by Niklas with `/po <milestone>` | the session's own | No. It files issues, writes and commits specs to `master`, moves board cards, starts and messages issue leads, builds the integration worktree |
| **Issue lead** | One session per issue, started by the PO, working in `../ir-<n>` | the session's own | Through its subagents, and its own small fixes, as today's coordinator does |
| **Architect** | Read-only subagent | `opus` | No |
| **Implementer** | Subagent; several per issue only on disjoint files | per the `CLAUDE.md` mapping, per task | Yes |
| **Documenter** | Subagent: website pages, changelog fragment, `README.md`, rule and `CLAUDE.md` sync | `opus` | Docs only |
| **QA** | Subagent: runs the scenario harness or the hands-free sim probe where they apply, builds the audio and icon review pages, writes Niklas's manual-test script | `opus` | Test scaffolding only |
| **Reviewer** | Not a new agent: `/code-review` at the level from the table, the second read where it applies, the CodeRabbit CLI run, CodeRabbit on the PR | as today | No |

**Architect, when.** Twice per issue at most. First on the spec: the PO consults it when it writes or amends a spec, and its findings are folded in before the spec is committed. Second on the diff, but only when the branch touches a seam: the `@iracedeck/event-bus` catalog, `IDeckPlatformAdapter` / `SettingsHost`, `SimConnection` / `SimRuntime`, a new package or a new edge in the internal dependency graph, or an import that crosses the sim boundary. A typo fix or an icon change gets no architect. Its brief points at the latest file in `docs/architecture/reviews/`, `packages/website/src/content/docs/docs/development/architecture.md` and the second-sim direction, and carries the rule those reviews settled on: no invented findings, and size alone is not a god module. When it finds a seam getting worse it says what the thorough fix is; the issue lead builds that fix, or the PO files it as its own issue and orders it before the work that needs it. Neither goes to Niklas as a choice.

**The reviewer stays what it is.** One full `/code-review` per branch is the rule (`code-review.md`), and a second reviewer agent would be the duplicate that rule forbids.

**Retired.** `.claude/agents/code-reviewer.md` (a generic checklist the review rules have overtaken), `.claude/agents/git-commit-prep.md` (predates pnpm 12, `pnpm typecheck` and `commit --only`) and `.claude/agents/feature-planner.md` (its useful part, Stream Deck limits for planning, moves into the PO's spec-writing brief).

## Where it lives

Committed, alongside the rules and hooks it builds on:

- `.claude/skills/po/SKILL.md`: the PO's playbook, invoked as `/po <milestone>`.
- `.claude/skills/issue-lead/SKILL.md`: the brief every issue-lead session is started with. The PO's `start_session` prompt names the issue and says to follow this skill, so a brief stays a few lines long.
- `.claude/agents/architect.md`, `implementer.md`, `documenter.md`, `qa.md`.
- `.claude/skills/review-page/SKILL.md`: the recipe for the disposable audio and icon review pages.
- `scripts/integration-build.mjs` with its tests.

Committed rather than gitignored because a gitignored file is not checked out into `../ir-<n>`, because the role files are process and get reviewed like process, and because the rules they build on are already public. Agent and skill descriptions are listed in every session's system prompt, so each is kept to one short sentence; the bodies load only when used.

Work state lives on GitHub: milestone membership, the board lanes, and issue comments for decisions. The PO's private notes go to the auto-memory directory, as now. Plans stay in the gitignored `docs/superpowers/plans/`.

## How the sessions work together

**Starting.** Niklas starts the PO session by hand and invokes `/po 3.8.0`. The PO starts each issue lead with `start_session`: `initiation: "user_asked"` (the `/po` invocation is the request), `context: "fresh"` with a brief rather than a fork of its own long conversation, named after the issue (`ir-1508`), and sharing the `master` checkout (`use_worktree: false`). The issue lead's first step is `git worktree add ../ir-<n>`, so the worktree is the repo's sibling convention, and the existing hooks (board move, base-commit check) fire as they do today. That is also why the app's own worktree option is not used: it does not create the `../ir-<n>` sibling the rules and hooks are built around.

**Hub and spoke.** Issue leads report to the PO, never to each other. A report reaches the PO automatically when an issue lead ends a turn. The PO messages an issue lead by its session id: "#1509 merged, rebase before your PR", "#1530 also changes `SimRuntime`, wait for its spec". The PO keeps the picture of who touches what; each issue lead knows only its own issue and what the PO tells it.

**Only the PO writes to `master`.** Issue leads share the `master` checkout as their working directory but never edit or commit in it. Specs are written at filing time by the PO; an amendment an issue lead needs is sent to the PO, which commits it. This keeps several sessions from writing to one checkout.

**An issue lead owns its issue to the end.** That is steps 3 to 13 of `issue-workflow.md`: implementation, gates, review, the PR, CodeRabbit, the merge, the four post-merge runs and removing the worktree. A red post-merge run goes to the PO, which takes it to Niklas; the PO is "the coordinator" step 12 hands the watch to when an issue lead's session ends first.

**From a passed test to the merge, without asking.** Once Niklas has passed the issue's manual test, the issue lead pushes and opens the PR without asking (Niklas, 2026-10-30). It then owns the PR until the merge: it binds it to the app's PR monitor with Auto-fix, which wakes it on CI failures, merge conflicts and review comments, and it also watches for **CodeRabbit's approval**, which Auto-fix does not cover, so an approved, green PR is merged promptly rather than sitting. If the approval arrives as a monitor event the issue lead acts on that; if it does not, the issue lead checks the review state on a slow interval, which is a review, not the CI polling the app forbids. The known CodeRabbit traps are part of its brief: a clean incremental review updates only the summary comment and gives no new `APPROVED`, which `@coderabbitai approve` resolves; a rate-limited review is asked for again with `@coderabbitai review` once the limit resets. Every thread is answered, nitpicks included, as `issue-workflow.md` step 10 says.

**Permissions.** Issue leads start in the PO's own permission mode (the `start_session` default). A permission prompt or a hook ask that opens in an issue-lead session is the one way a question can reach Niklas without going through the PO, so the issue lead also reports it to the PO, and the PO tells Niklas which session is waiting. The hooks' asks are not turned into denies: each guards something Niklas confirms by design (a tag push is a release). The no-spec worktree ask should not fire at all, because the PO writes the spec before starting the issue lead.

**The cap.** At most three issue leads are *in implementation* at once by default, counted from start until the issue is ready to test. An issue waiting for Niklas's test, or past it and in review or merge, does not hold a slot: the bottleneck is his testing time, which the integration build batches, and more parallel implementation would only queue for him. The PO can be told a different cap.

**When an issue lead finishes.** The PO starts the next issue in its order. The app lets a session start others freely in a turn Niklas drove, and after a long chain of turns woken only by other sessions it shows a card instead, which Niklas clicks. That is acceptable, and the PO says so rather than working around it.

**Resuming.** Everything the PO needs is on GitHub (milestone, board lanes, issue comments, PRs) plus the list of its linked sessions, so a fresh PO session that runs `/po 3.8.0` again rebuilds the picture without a handover document.

## Working a release

The release is a GitHub milestone (3.8.0 had 19 open issues when this was written). **What is in it is Niklas's decision**: the PO proposes adding, dropping or splitting an issue and waits for his answer, but never changes milestone membership itself.

**The order inside it is the PO's.** It orders the milestone's issues by dependency first (a seam before its consumers, a spec-less enhancement after its spec is written), then by value and risk. It keeps the board's `Next` lane in that order for the milestone and tells Niklas the order when it sets it or changes it. This replaces the rule that an agent never moves a card into `Next`: within a milestone Niklas has planned, the order is delegated. Moving a card into `Planned`, which says what the release contains, stays his.

`Next` can hold cards from more than one milestone. The PO orders only the cards of the milestone it is working, and places them at the top of the lane; other milestones' cards keep their relative order below them. The board helper in `scripts/claude-hooks/lib.mjs` gains what this needs, with tests: `Next` as a target of `setBoardStatus` (with `BOARD_MOVES` allowing it from `Backlog` and `Planned` only), and a position move within a lane (`updateProjectV2ItemPosition`). A raw `gh project item-edit` stays refused.

**Specs.** An enhancement without a spec gets one from the PO, with the architect's review, committed to `master`, before its issue lead starts. Niklas reads specs for the product decisions in them; a spec that settles a product question he has not answered asks him that question and nothing else.

## What Niklas is asked, and what he is never asked

Asked, each at the moment it comes up:

- **Product decisions**: what the release contains, behaviour and naming a user sees, scope questions a spec cannot settle without him.
- **Icon designs**: on a review page (below) before the icon is committed.
- **Every audio clip**: on a review page before the clip is committed. No clip is generated or regenerated without his go-ahead on the text first, since generating costs ElevenLabs credit.
- **The manual test**: it still blocks the PR (`issue-workflow.md` step 8), now usually in the integration build.
- **Releases and a red `master`**: unchanged; both are his.

Never asked:

- **The work mode.** Every piece of work happens in a sibling worktree and ends in a PR; work with no issue gets one filed first.
- **Whether to cut a corner.** The thorough option is built; its cost goes in the report.
- **The wording of `.claude/rules/` and `CLAUDE.md` files.** They are written for Claude. Their size is controlled by the budget test and the architecture reviews instead.

The PO is the only session that asks him anything. An issue lead that needs a decision sends it to the PO, which batches questions so Niklas gets one message rather than three interruptions.

## Review pages

A review page is a **disposable** Artifact: built for one review, private, not kept up to date afterwards. The QA agent builds it from the branch diff, and the `review-page` skill holds the recipe.

- **Audio.** One button per new or changed clip under `packages/audio-assets` (the `.mp3` files the branch adds or changes against `origin/master`), each labelled with its voice, group, entry and spoken text, so a click plays it. The clips are published as the artifact's files; the 32 kbps clips are small enough for the publish limits. If the artifact host refuses the audio files, the fallback is the same page as a local HTML file opened in the built-in browser. Niklas gives his verdict in chat: all approved, or the entries to redo with a note. The page has no buttons of its own beyond play.
- **Icons.** The before and after previews of each changed icon side by side, in light and dark, built the way the existing icon review gallery is (`assembleIcon` from `@iracedeck/icon-composer`). Verdict in chat, as for audio.

## The integration worktree

One permanent worktree, `../ir-integration`, on a local branch `integration` that is never pushed. Niklas links the deck to it once, himself; the PO never relinks a host, as now.

`scripts/integration-build.mjs <branch…>`:

1. Refuses a dirty `ir-integration` tree.
2. Fetches, resets `integration` to `origin/master`, and merges each named branch with `--no-ff` in the order given.
3. On a conflict, aborts that merge, reports which branch conflicted with what was already merged, and stops. A conflict between two issue branches is something the PO resolves through the issue leads, not in the integration tree.
4. Runs `pnpm install` and `pnpm build:with-restart`, and checks the build output as `build-and-commit.md` says. `build:with-restart` restarts Stream Deck; the builder checks whether Mirabox and Ulanzi can be restarted the same way, and if not the script tells Niklas which host to restart himself.
5. Prints the head sha of every branch it merged.

**No host restarts until Niklas says go; builds need no go.** Niklas may be racing, and a restart would break the session he is in (2026-10-30: "Only restart SD when I tell you to"). So the PO never restarts, stops, starts or relinks a deck host on its own. Building is different (amended 2026-10-30, #1526: "Building shouldn't require my permission. We can build even when a deck is running"). Since #1258 a running host does not fail the build, so the PO builds and installs in any tree, a linked one included, without asking. When an issue reaches "ready to test", the PO tells Niklas what the next build contains and gives him the combined manual-test script; loading it into a running host is a restart, and that is his go. Per `hooks.md` rule 1 this gets a hook too: an **ask** on `build:with-restart`, `restart:stream-deck`, `watch:stream-deck`, every host stop, start and relink, and the integration script's restart. An ask is the right verdict, not a deny: Niklas saying go and confirming the prompt is the intended path. As first shipped, the ask also covered any `pnpm build` or `pnpm install` whose tree a deck host links to, and every run of the integration script; #1526 narrows it to restarts and relinks. He passes or fails each issue in the build, not the build as a whole. A passed issue goes ahead to its PR at once. A failed one goes back to its issue lead and is fixed in its own worktree, and the next build contains the fix; the issues that already passed are not tested again unless the fix touched what they changed. The script records each branch's head sha, and the pass belongs to the issue at that sha. Later changes follow today's practice: a rebase after a sibling merges, a resolved conflict, or a CodeRabbit fix does not void the pass. The issue lead asks for a retest, through the PO, only when such a change alters behaviour Niklas tested.

The hooks need three more changes for this, each with tests:

- The worktree-name guard accepts `../ir-integration` as well as `../ir-<issue>`.
- Pushing the `integration` branch is denied.
- Merge commits on `integration` pass the spec-on-a-branch guard, which exists for commits that would carry a spec into a feature branch. The builder checks whether that guard fires on `git merge` at all before changing it.

## Keeping `master` pulled and built

After every merge, the PO fast-forwards the `master` checkout to `origin/master` and runs `pnpm install` and `pnpm build`, reading the output as `build-and-commit.md` says (Niklas, 2026-10-30). Three reasons: the hooks every session runs are read from that checkout, so a merged hook change reaches the team only once it is pulled; `git worktree add` refuses a stale `origin/master`, and the next issue lead branches from it; and a merged tree that does not build locally is a red `master`, which goes to Niklas like a red post-merge run.

The PO is the only writer to the `master` checkout, so the fast-forward cannot meet local edits; a checkout that is dirty or cannot fast-forward is reported to Niklas, never reset. The build runs straight after the pull, whether or not a deck host links to `master` (above); restarting that host to load it stays his go.

## Rule and doc changes

- `build-and-commit.md`: the "before writing any code, ask the user" paragraph goes. Work happens in a sibling worktree, always; a maintainer-directed Master mode remains only when Niklas states it himself.
- `issue-workflow.md`: "when the thorough option costs materially more, say so and let the maintainer choose" becomes "build the thorough option and report what it cost"; step 8's "show the drafted text in full" no longer applies to rule and `CLAUDE.md` prose; the audio and icon approvals join the gates; the pipeline names who does each step (PO, issue lead, role agent).
- `.claude/CLAUDE.md`: the "Work through agents" guidance names the team and points at `/po` and `issue-lead`, in a few lines.
- `hooks.md` and `hook-internals.md`: the linked-tree ask and the three integration-worktree guard changes.
- `code-review.md`: no change beyond naming the issue lead as the one who runs the review.
- `build-and-commit.md` *Issue labels* section: the `Next` paragraph matches the delegation above.
- **Auto-memory.** `MEMORY.md` loads into every session in the project, issue leads included, so memories that contradict this spec are reconciled in the same change; otherwise the old asking would persist whatever the skills say. The memory directory sits outside the repo, so this is done by hand alongside the PR rather than inside it. Already done on 2026-10-30: the work-mode memory and a new "what Niklas approves" memory. To reconcile: "Confirm before external actions" (a push or PR after his manual test needs no ask), "Show drafts in the final message" (user-facing text only, never rule prose), "Don't rush to solving" (applies to product questions, not to technical design inside a decided spec), "Route questions through coordinator" (the coordinator is the PO).

The always-loaded set must not grow by more than about 2,000 characters in total; the role mechanics go in the skills and agents, which load only when used.

## What's left to the builder

The exact wording of every skill, agent and rule edit; how the PO's status reports to Niklas are formatted; whether the PO uses a push notification when it is waiting on him; the scheduling heuristic beyond "dependencies first"; and how the `review-page` skill finds a clip's spoken text.

## Out of scope

- Cloud sessions, scheduled or cron wake-ups of the PO, and the multi-agent Workflow tool. The PO works while its session is open.
- Issue leads messaging each other.
- Any automatic relinking of a deck host.
- The PO changing milestone membership, cutting a release, or closing a milestone.
- Changes to the merge gate, CodeRabbit's role or the release procedure.
- Regenerating existing clips.

## Testing

- **Hooks:** tests for each guard change, each with a positive control: `../ir-integration` is accepted and other names are still refused; a push of `integration` is denied and a push of another branch is not; the merge-commit case behaves as decided. Each change is also proven by watching it fire in a session (`hooks.md` rule 6).
- **Linked-tree ask:** a host restart, stop, start or relink prompts; a build or install in a tree a deck host links to does not (#1526), with positive controls on both sides.
- **Master after a merge:** on the first-run issue, the PO's pull and build of `master` happen after the merge, with no wait for Niklas's go.
- **Board helper:** tests for the `Next` target (allowed from `Backlog` and `Planned`, refused from every later lane) and for a position move, run under `IRACEDECK_HOOKS_DRY_RUN=1` before anything touches the real board.
- **Integration script:** tests against a temporary git repository covering a clean multi-branch merge, a conflict (aborted, reported, nothing left half-merged), the refusal of a dirty tree, and that it never pushes.
- **Budget:** `scripts/claude-rules-frontmatter.test.mjs` stays green, and the PR records the headroom before and after.
- **Role files load:** a fresh session lists the new agents and skills with their short descriptions, and the three retired agents are gone.
- **Review page:** a smoke run on a past branch that changed clips (three or more) and one that changed icons; Niklas plays the clips from the page.
- **First run:** `/po 3.8.0` with a cap of one, taking one small issue from start to merge, before the cap is raised. Niklas checks that he was asked only what this spec says he is asked.
