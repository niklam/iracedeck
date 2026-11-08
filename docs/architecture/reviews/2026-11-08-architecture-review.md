# Architecture review — 2026-11-08

> **Previous:** [2026-11-01](2026-11-01-architecture-review.md) · **Follow-ups:** [#1658](https://github.com/niklam/iracedeck/issues/1658) · [#1659](https://github.com/niklam/iracedeck/issues/1659) · [#1660](https://github.com/niklam/iracedeck/issues/1660) · [#1661](https://github.com/niklam/iracedeck/issues/1661) · [#1662](https://github.com/niklam/iracedeck/issues/1662) · [#1663](https://github.com/niklam/iracedeck/issues/1663) · [#1664](https://github.com/niklam/iracedeck/issues/1664) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#643](https://github.com/niklam/iracedeck/issues/643)
>
> Point-in-time review of `master` at `ce3beb3a6` (v3.8.1-dev.0; the 3.8.1 work is done, not yet released). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

This review covers the seven days and 85 commits since the 2026-11-01 review (`5a8d6a64d..ce3beb3a6`). 41 of those commits are spec edits and 44 are code. Together they make up the 3.8.1 work.

**Every follow-up from the last two reviews is closed:**

| Issue | What it did |
| --- | --- |
| [#1501](https://github.com/niklam/iracedeck/issues/1501) | path-scoped the always-loaded sections |
| [#1586](https://github.com/niklam/iracedeck/issues/1586) | named the CodeRabbit CLI round in the review rule |
| [#1587](https://github.com/niklam/iracedeck/issues/1587) | a classified session for the catalog |
| [#1588](https://github.com/niklam/iracedeck/issues/1588) | translator state slices |
| [#1589](https://github.com/niklam/iracedeck/issues/1589) | a shared dial-surface base |
| [#1590](https://github.com/niklam/iracedeck/issues/1590) | split the hook lexer and script interpreter out of `rules-bash.mjs` |
| [#1591](https://github.com/niklam/iracedeck/issues/1591) | the small drifts |
| [#1374](https://github.com/niklam/iracedeck/issues/1374) | documentation drift |
| [#1375](https://github.com/niklam/iracedeck/issues/1375) | package boundaries, in two parts |
| [#1504](https://github.com/niklam/iracedeck/issues/1504) | one shared fake audio service |
| [#1577](https://github.com/niklam/iracedeck/issues/1577) | one neutral live-position dependency |

**The rest of the window:**

- **Error isolation.** Each telemetry subscriber (#1558), each translator tick step (#1559) and each event-bus handler (#1560) now has its throws caught and reported, behind one `createErrorBoundary` in `@iracedeck/logger`.
- **Deck adapters.** Each context's lifecycle events are now ordered the same way on every adapter (#1597), plus fixes in the Ulanzi (#1530) and Elgato (#1630) adapters.
- **Replay.** One pending replay speed (#1427), and the replay state held through the plugin's own seek (#1429).
- **Race Engineer fixes:** #1380, #1405, #1395, #1548, #1550 and #1582.
- **Hooks and guards.** A no-review merge path for prose-only PRs (#1648), the CodeRabbit allowance (#1649), and a run of hook spelling fixes (#1606, #1607, #1634, #1594, #1391, #1393).
- **Release and lint.** Voice-pack deploy guards (#1613, #1392), and lint and format for `.astro` and `.mts` files (#1616).

**Method.** It is the one the 2026-10-25 review set down.

- **Reviewers.** Five read-only reviewers each took one seam: sim and telemetry; the deck platform; audio and the Race Engineer; cross-cutting build, settings and process; and the replay stack.
- **Measurement.** Each re-ran the previous counts on both trees, which were pinned as extracted copies, using the recorded scripts.
- **Verification.** Each finding was checked against the code before it was kept.
- **What is not ranked.** Deliberate, documented choices are listed under *Trade-offs, not defects*.
- **Marks.** Figures marked **(verified)** were re-measured by the coordinator; the rest come from one reviewer's measurement. Judgements are marked as such.

**God module** keeps the earlier definition: a module holding several unrelated responsibilities, or state shared across concerns that have nothing to do with each other. Size alone does not make one.

Line counts are physical lines of non-test `.ts` under `src/` unless stated.

## Verdict

**Every follow-up landed and met its issue. The product code is now in the best shape any of these reviews has measured.**

- **Copies and reaches went to one or zero.**
  - Dial-surface lifecycle definitions went from 18 to 1, and a family-wide test reads the manifest.
  - The 39 copied fake audio services are now one, typed against `IAudioService`.
  - Test files reaching into another package's `src` went from 20 to 0.
  - There is one `SubSessionID` reader, one session classifier table and one live-position dependency.
- **Declared package edges fell from 178 to 148.**
  - One lint block now decides, for all 25 sim-neutral packages, which sim imports they refuse, with subpaths.
  - The vitest aliases are complete and tested.
- **The translator's state is a managed migration.** New state arrives as slices, enforced by a guard with more than 30 planted controls, and the legacy flat part has only shrunk.
- **One error boundary serves the SDK, the translator and the bus.** A swallowed throw still logs once, with its stack, and repeats are counted.
- **Lifecycle-event ordering is one contract.** It is defined in `deck-core` and every adapter is held to it by shared scenarios.

**The weak point has moved from the code to the process layer.**

- **The always-loaded instructions regrew 11.9k characters** in six days after #1501 cut them. They are 1,130 characters from the new 120k floor (verified), so the next process change of that size fails CI.
- **Most of the regrowth is how gates decide,** restated in always-loaded files. `hooks.md`'s own rule 1 says that belongs in `hook-internals.md`.
- **The hook code grew 70% in a week,** against 3.8% for the packages.

**Smaller items:** two guards that do not hold their own stated invariant, one replay rule left behind by #1429, the website build loading the sim stack, and a handful of stale lines.

## What moved since 2026-11-01

| #   | Previous finding                                          | Status                              | Now                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Always-loaded instructions growing ~1k a day              | **Fixed, then regrew** (#1501)      | Four sections path-scoped and a 10k headroom floor added. 118,923 → 106,961 at the merge → 118,870 now (verified), 1,130 under the floor (item 1)                                                                     |
| 2   | `TranslatorState` shared whole by every diff              | **Contained** (#1588)               | The slice convention is stated and guarded. `fastestLap` and `fuelCallout` are slices, and the legacy flat members are pinned and have only shrunk. 88 diff declarations still take the whole state (item 4)          |
| 3   | A rule forbade the CLI review the skill required          | **Fixed** (#1586)                   | `code-review.md` names the CodeRabbit CLI round as an exception, with one command everywhere                                                                                                                          |
| 4   | `rules-bash.mjs` held three subsystems                    | **Fixed, then regrew** (#1590)      | The lexer and the interpreter were split out, with 63 payloads byte-identical. `rules-bash.mjs` then regrew to 2,160 lines and the lexer to 2,845 (verified, item 2)                                                 |
| 5   | Catalog classifier mirrored by a comment                  | **Fixed** (#1587)                   | One `classifySession` table returns the sim-neutral `SessionClass`. The mirror and the raw `"Lone Qualify"` matching are gone, and `SimRuntime` no longer exposes the raw string                                       |
| 6   | Dial family without a base                                | **Fixed** (#1589)                   | Two bases; `inputContext` / `ensureContext` / `pressShape` definitions went from 18 to 1. A coverage test ties the surfaces to the manifest's Encoder actions, with about 20 planted controls                         |
| 7   | Four small drifts                                         | **Fixed** (#1591, #1577)            | `GATED` is matched by identity with positive controls. There is one `SubSessionID` reader and one neutral live-position key, and the recorder rule and comments are corrected                                         |
| 8   | Documentation drift (#1374, #1375)                        | **Fixed**                           | Every Architecture-page and README item, plus the lint, alias, reach, dependency, logger, turbo-block, profile-reader and `svg.d.ts` items                                                                            |
| —   | Test fakes copied by hand (#1504)                         | **Fixed**                           | 39 copies → 1 shared `createFakeAudio`, typed so a new `IAudioService` member breaks one file                                                                                                                         |
| —   | Trade-off: a translator throw skips that tick's recorder  | **Resolved** (#1558, #1559)         | Each subscriber and each step is isolated                                                                                                                                                                             |

## Baseline figures

The numbers a later review should re-measure. Both columns use the same method.

| Measure | 5a8d6a64d | ce3beb3a6 | Method |
| --- | --- | --- | --- |
| Packages / `@iracedeck` edges (dep ∪ dev) / prod edges / longest chain | 39 / 178 / 156 / 7 | 39 / 148 / 129 / 7 | `graph.mjs` |
| Package cycles | 0 | 0 | DFS, with a positive control |
| Test files reaching into a sibling's `src` | 20 | 0 | `reach.mjs`, resolved paths |
| Vitest aliases; completeness test | 26; none | 36; `vitest-alias-coverage.test.mjs` | regex over the alias block |
| Sim-neutral lint coverage | deck-core block (5 packages, `paths` only) | one block of 25 packages with `patterns` | `eslint.config.js:26-58` |
| Declared-but-unimported workspace deps | plugins 7 / 10 / 10, website 5 | 0 real | `usage.mjs`, each hit checked |
| `deck-core` lines (runtime only) / sim imports | 7,117 / 0 | 7,681 / 0 | `measure.mjs` minus test support; JSDoc hits excluded |
| `plugin.ts` sizes / shell sim imports | 22 / 23 / 24; 0 | 22 / 23 / 24; 0 | `wc -l`; grep |
| Dial surfaces / lines / lifecycle definitions | 18 / 13,931 / 18 | 18 / 13,194 / 1 | `m2.mjs`; definitions, not call sites |
| Verbatim lines shared by ≥9 surfaces | 1,930 | 1,737 | `dup.mjs` |
| Copied `createFakeAudio` fakes / lines | 39 / 1,649 | 1 / 55 | `fake.cjs` |
| `translator.ts` lines | 3,391 | 3,968 | `wc -l`; #1559 +273, #1380 +225, #1405 +61 |
| `TranslatorState` members / slices / pinned flat members | 251 / 1 / — | 239 / 4 / 235 | `members.mjs`; the guard's own count |
| Diff declarations typed on the whole state / on a slice | 92 / 15 | 88 / 23 | `sigs.mjs`, parsed parameter lists |
| Session classifier tables | 3 | 2 (`classifySession`, plus `classifySessionKind` by design) | grep |
| `SimRuntime` / `HostSim` members | 23 / 4 | 23 / 4 | `getSessionType` became `getSessionClass` |
| `SubSessionID` readers / contracts | 4 / 2 | 1 / 1 | grep |
| `PitCrewDeps` keys | 34 | 33 | `deps.cjs` |
| `ScenarioEngine` / engine modules | 377 / 13 | unchanged (no non-test engine edit in the window) | `diff -rq` |
| Replay stack lines / test ratio | 24,536 / 2.02 | 24,904 / 2.05 | `measure.cjs`, recorder files included |
| Records of a sent-but-unshown replay speed | 3 | 1 | grep |
| `replay-command-gate.ts` / `walkToLapStart` | 2,621 / 1,018 | 2,702 / 1,018 | `wc -l`; AST span |
| Always-loaded rules + `.claude/CLAUDE.md` | 118,923 ch | **118,870 ch** (verified); floor 120,000 | as `claude-rules-frontmatter.test.mjs` measures (`HEADROOM_FLOOR = 10_000`) |
| `.claude/rules` files / bytes / largest | 32 / 946,578 / 278,144 | 37 / 1,023,808 / 292,049 | `wc -c` |
| `CLAUDE.md` bytes; skills; agents | 654k; 195k; 13.0k | 725k; 197k; 13.0k | `wc -c` |
| Hook code, non-test / test lines | 4,926 / 6,333 | 8,361 / 10,579 | `wc -l` |
| `rules-bash.mjs` / `shell-lexer.mjs` / `script-runs.mjs` | 2,731 / — / — | 2,160 / 2,845 / 898 (verified) | `wc -l` |
| `hook-internals.md` / `hook-script-runs.md` | 22.3k / — | 48.0k / 5.7k | `wc -c` |
| `scripts` non-test `.mjs` lines / package `src` non-test lines | 16,834 / 190,466 | 21,931 / 197,753 | `wc -l` |
| Workflow lines / `firebase-hosting-release.yml` | 946 / 114 | 1,406 / 543 | `wc -l` |
| Commits / `docs(specs)` | 98 / 58 | 85 / 41 | `git log` |
| Master push CI runs on spec-only heads | 0 | 0 on 41; 176/176 runs green | `gh run list` |
| Local turbo cache | 103 GB | 105 GB | `du -sh` |

### Corrections to the earlier reviews

- **The README action count was not drift.** "33 actions" is the visible count: the Stream Deck manifest's 37 actions minus 4 hidden legacy ones. The 2026-10-20 to 2026-11-01 reviews called it wrong against 35 classes.
- **"Its consumer-less names are guarded by `index.test.ts`"** (replay barrel, 2026-11-01). That test checks only `_`-prefixed names and missing signature types, not extra values (item 4).
- **"87 diff signature lines"** (2026-11-01) does not reproduce at `5a8d6a64d`. The parsed declarations there are 92; 87 is the HEAD count by grep. The trend holds.
- **"Three copied plugin turbo blocks"** were not copies: they had drifted (different `outputs`, and Mirabox lacked an input). #1375 made them identical, and a test now holds them so.

**Method notes:**
- `measure.mjs` and `m2.mjs` count `*.test-support.ts` and `./testing` modules as source, so `deck-core` grew by 564 runtime lines, not 1,706. `m2.mjs`'s `inputContextCopies` counts call sites; count definitions instead.
- `measure.cjs` matches `iracing-sdk` files by basename, so it misses `telemetry-features.ts`, where the replay state rule lives.
- `usage.mjs` skips every `build/` directory, including `pi-components/src/build/`, which is source, and it misses `require.resolve` specifiers.
- The `deck-core` "sim importers" the scripts report are JSDoc examples.

## What is good

- **#1589 removed the dial family's copies and made the rule structural.**
  - **The bases.** Two bases in `iracing-actions/src/shared/dial-surface-base.ts` own `inputContext`, `ensureContext`, `forgetContext` and the press shapes. They stay in `iracing-actions` because they read a feature flag.
  - **The coverage test.** `dial-surface-base-coverage.test.ts` ties the surfaces to the manifest's Encoder actions by folder, so a nineteenth dial named differently is still caught. It checks each input member's statement shape and requires the late-input suite in every surface test, with about 20 planted controls.
- **#1375 closed a two-review-old issue completely.**
  - **Lint.** `SIM_NEUTRAL_PACKAGES` decides 25 packages with subpath `patterns`. `sim-boundary-coverage.test.mjs` forces a decision for every package and plants an import of each file type.
  - **Reaches.** `cross-package-reach.test.mjs` resolves `join`, `URL` and `import.meta.dirname` paths and requires a reason for each allowed reach. Both it and the alias test fail on stale entries.
  - **Edges.** Declared edges fell by 30, and the 504 built plugin files stayed byte-identical, with an `ERR_MODULE_NOT_FOUND` positive control.
- **#1588 made the translator's last god-module trait a guarded migration.**
  - **The guard.** It uses the TypeScript binder and follows aliases, containers, unions and `Object.assign`, with more than 30 planted controls and floors against a vacuous scan.
  - **Applied twice already.** #1405 applied the convention a second time (`fuelCallout`).
- **One error boundary, three dispatchers (#1558, #1559, #1560).**
  - **The pieces.** `createErrorBoundary` (`logger/src/error-boundary.ts`) is used by `SDKController`, the translator's steps (shared with the recorder through `tick-steps.ts`), the event bus and the harness mock.
  - **What a caught throw does.** A new throw site logs one `error` line with its stack, repeats are counted, recovery is logged, and passing a cap is itself logged.
  - **The step runner.** `tick-steps.ts` imports only the logger and allocates nothing per call at 60 Hz.
  - **The source check.** `tick-steps.source.test.ts` parses the translator and refuses a bare diff call, with planted fixtures.
  - **What it fixed.** One car's throw in `diffReplayLaps` used to lose every other car's crossings.
- **#1597 shows how to change a seam.**
  - **One contract.** The ordering rules live in one `deck-core` module (`context-event-order.ts`) and are documented on `IDeckPlatformAdapter.registerAction` and the Architecture page.
  - **How every adapter is held to it.** The shared `CONTEXT_EVENT_ORDER_SCENARIOS` run through each adapter's real dispatch and against four failing reference adapters, each of which must fail at least one scenario. `deck-adapter-order-contract.test.mjs` refuses an adapter whose tests skip them.
  - **A host quirk without a special case.** The Ulanzi promotion (#1530) is absorbed as an ordered step.
- **#1587 put the session vocabulary in the bus.**
  - **The types.** `SessionCategory` and `SessionClass` are typed once in `event-bus`.
  - **The table.** `classifySession` is the one table, and `session-type.test.ts` pins every session type the translator meets.
  - **The seam.** The raw string no longer crosses it.
- **#1427 and #1429 each left one owner.**
  - **#1427, the replay speed.** One record, one writer (the gate) and one hold, fed by the engine itself rather than by whichever Replay Control happens to be on screen.
  - **#1429, the replay state.** The SDK owns "in a replay" through a seek. The gate tells it once per change, and the dial's private rule is deleted.
- **#1504 replaced 39 casts with a type.**
  - **The type.** `FakeAudio` is a mapped type over `IAudioService`, so a new member fails to compile in one file.
  - **What the casts hid.** The old copies, all cast through `unknown`, had drifted: they lacked three service members.
- **#1582 put "refused lap" into the type.** `LapCompletedData` is a union, and `lapTime` is optional on the refused branch, so every reader must narrow.
- **#1648's `--admin` path fails closed at every read.**
  - **What it reads.** Git plumbing at the pinned head, and the required checks from the rules API.
  - **What refuses.** An empty list, an unreadable blob or criss-cross history.
  - **Strict comparisons.** Skill and agent frontmatter is compared byte for byte, and `isNoReviewPath` rejects `.`, `..`, empty and backslash segments.
  - **The path list.** `CHANGES_REQUESTED` always refuses. The path list is held to `code-review.md` by a test with six mutation controls.
  - **Its reviews.** The second read held 4 of 4 findings on it, and 2 of 2 on #1613.
- **#1613 and #1392 put the deploy checks in the deploying job,** so re-running that job alone cannot skip them.
- **The engine split held through six catalog-facing changes** with no non-test engine edit, and spec-only pushes ran no CI across 41 commits, with every post-merge run green.

## Large modules

Sorted by the definition. A large cohesive module is not a finding.

| Module | Size | Responsibilities | Verdict |
| --- | --- | --- | --- |
| `sim-events-iracing` `translator.ts` + `TranslatorState` | 3,968 lines; 239 members (4 slices, 235 pinned flat) | Runs 35 guarded tick steps and 11 guarded values; holds the getters and the YAML resolvers | **God module, second clause, under a guarded migration** (#1588). New state cannot arrive flat, but the pin's "only shrinks" is not enforced (item 4). The +577 lines were mostly #1559's steps and #1380's gap-horizon computation, which is pure maths placed beside the tick. That is a placement note, not a defect |
| `scripts/claude-hooks/rules-bash.mjs` | 2,160 lines, 34 functions | The Bash rules, plus the merge-gate verdicts (`:735-990`) and the spec-heading grammar (`:168-290`) | **Separable subsystems again** (item 2) |
| `scripts/claude-hooks/shell-lexer.mjs` | 2,845 lines; `maskInert` alone runs `:72-603` | Lexing and masking shell text | One job, large; each new spelling class has cost 650–900 lines (item 2) |
| `audio-scenarios` `ScenarioEngine` / `Scheduler` / `Expansion` | 377 / 738 / 568 | Facade / arbitration / expansion | Unchanged across the window; one concern each |
| `replay-engine` gate / `walkToLapStart` | 2,702 / 1,018 | When a command goes out / walking to a lap start | Cohesive; the gate's +81 is #1429's seek hold |
| `deck-core` `context-event-order.ts` | 533 | The lifecycle-event ordering contract | One concern |
| `iracing-actions` dial surfaces and large actions | 1,509–2,329 | One surface or action each, now on the shared base | Cohesive |
| `replay-store` `createReplaySessionStore` | 1,050 | One store | Cohesive; byte-identical |
| `audio-scenarios` `registerPitCrew` / `scenario-shortcuts.ts` | 836 / 4,438 | The composition list / data | By design |

## What is bad, ranked

### 1. The always-loaded instructions regrew 11.9k in six days, and are 1,130 characters from the new floor — medium (process)

#1501 did every task its issue named. It path-scoped four sections (`turbo-cache.md`, `node-version.md`, `roadmap-board.md`, `action-tests.md`) and added a 10k headroom floor, so `claude-rules-frontmatter.test.mjs` now fails above 120,000 characters. That took the set from 118,923 to 106,961. It is back at 118,870 (verified).

**Regrowth by commit since #1501:**

| Commit | Characters added |
| --- | --- |
| #1648 | +3,665 |
| #1613 | +1,592 |
| #1586 | +1,480 |
| #1391 | +1,294 |
| #1616 | +1,044 |
| #1375 | +808 |
| #1606 | +546 |

About 6.7k of it is how a gate or deploy check decides, written into always-loaded files:

- **`hooks.md`.** The merge row went from 590 to 1,174 characters. That file's own rule 1 says how a guard decides "goes in `hook-internals.md`".
- **`code-review.md`.** The #1649 and #1648 sections, 2,294 characters.
- **`build-and-commit.md`.** The #1613 deploy-check decision table, 1,591 characters.
- **`specs-and-plans.md`.** The spec-heading grammar went from 285 to 1,097 characters (#1391).
- **`code-style.md`.** The coverage paragraph went from 1,233 to 2,279 characters (#1616).
- **`issue-workflow.md`.** It gained the `--admin` merge mechanics, although its own header says it holds the sequence, the gates and why, "nothing else".

**The floor works as designed:** the next process change of about 1.1k fails CI rather than the session. But the guard only refuses at the edge. Nothing stops each gate feature from restating its mechanics in three or four always-loaded files, which is the cause of this item and of item 6.

### 2. The hook code grew 70% in a week; `rules-bash.mjs` again holds separable subsystems — low-medium

**Growth.** Non-test hook code went from 4,926 to 8,361 lines, while package `src` grew 3.8%. 72% of that growth is three fixes that each close a class of command spelling:

| Fix | Net lines |
| --- | --- |
| #1606 | +904 |
| #1607 | +651 |
| #1634 | +908 |

**`rules-bash.mjs` holds three things again.** After #1590 split out the lexer and the interpreter, it regrew from 1,322 to 2,160 lines (verified):

- the Bash rules;
- the merge-gate verdicts (`unreviewedHeadVerdict`, `adminQualifies`, `adminVerdict`, `traceSummary`, `:735-990`);
- the spec-heading grammar (`:168-290`).

**The merge gate's reads sit with the board helpers.** They are in `lib.mjs` (`prChangedFiles`, `requiredStatusChecks`, `baseChangedSince`), beside `setBoardStatus`. `hook-internals.md` went from 22.3k to 48.0k.

**The lexer grows by one spelling class at a time.** `shell-lexer.mjs` went from 630 lines at the split to 2,845 (verified).

Judgement:
- **The merge gate.** It is the one guard whose failure mode is accepting, which makes it the natural next module: `merge-gate.mjs` plus its readers, out of `rules-bash.mjs` and `lib.mjs`.
- **The lexer.** It needs a stated stopping rule: when to deny a program word that is not plain, rather than normalise one more spelling of it. Each class so far has cost 650–900 lines plus tests.

### 3. Replay Control's walk start keeps its own grace-only "frame is held" rule, which #1429 left behind — low-medium

- **The rule.** `replay-engine/src/replay-record-walk.ts:94-96` computes its own `held` from `replaySeenAt` and `REPLAY_EXIT_GRACE_MS`. When the replay flag reads false and that grace has run out, it returns `no cursor` (verified).
- **What the owner now says.** Since #1429 the SDK's `ReplayState.frame` is held through the grace *and* through the plugin's own seek hold (`iracing-sdk/src/telemetry-features.ts:250-252`).
- **Where they disagree.** During a hold that outlasts the grace with no pending target, `inReplay` is true and the frame is held. There, Replay Control's record steps (`replay-control.ts:1045`, the dial surface `:916`) get `no cursor` and fall back to a search. Replay Markers, meanwhile, steps from `state.frame` (`replay-markers-ops.ts:185-195`, verified). Before #1429 the two agreed.
- **The comment's reason is gone.** It explains the rule by a mid-seek tick "where a walk would send the list's first entry" (frame 0, `:71-77`). The state no longer reads 0 there. No record-walk test covers the hold.

Judgement: either answer is defensible, since mid-search the held frame is the pre-search frame. But it should be decided once, in one place, and both replay actions should read it.

### 4. Two guards do not hold the invariant they state — low

- **The slice guard's pin can grow.**
  - **The claim.** `state-slices.test.ts` says the legacy flat list "only shrinks".
  - **What it checks.** Rule B only checks that each pinned name still exists (`state-slices.test-support.ts`). A change that adds a flat member and pins its name passes. The importer count is a floor (`toBeGreaterThanOrEqual(28)`, verified), not a ceiling.
  - **The second rule.** `race-engineer-callouts.md` says a new diff module takes "never the whole state", but no rule refuses a new module typed on `TranslatorState`.
  - **Today.** The pin lost 5 names and gained 0, so nothing has drifted, but this is the drift #1588 was filed to stop. #1376's append-only callout baseline shows the shape that holds.
- **The replay barrel's guard checks names, not consumers.**
  - **The rule.** `replay-engine/CLAUDE.md` says the barrel carries what production imports "and no more".
  - **What it checks.** `index.test.ts` checks only `_`-prefixed names and missing signature types.
  - **The drift.** Three values are now on the production barrel only for tests: `currentReplayCursorOwner`, `REPLAY_TARGET_GIVE_UP_MS` and `isReplayMoveUnderWay`. Their one production consumer was the dial clause #1429 deleted. `isReplayMoveUnderWay` (`replay-command-gate.ts:2373`) has no production caller at all (verified).

### 5. The website is declared sim-neutral, but its build loads the sim stack — low

- **The declaration.** #1375 put `website` in `SIM_NEUTRAL_PACKAGES` (`eslint.config.js:58`, verified).
- **The reach.** `website/scripts/generate-icon-gallery.mts:37-44` imports `iracing-actions` sources by relative path, an allowed reach, for their render functions.
  - `camera-dial-surface.ts` value-imports `@iracedeck/iracing-sdk` (`:112-119`).
  - `fuel-dial-surface.ts` value-imports `@iracedeck/deck-iracing` (`:29-37`, verified).
  - `iracing-sdk` in turn value-imports `iracing-native`, whose addon loads its `.node` in module scope.
- **What runs it.** `website#build` and `#typecheck` both run `generate:gallery`.
- **Why nothing catches it.** The lint rule matches package specifiers only, and the allowed-reach entry in `cross-package-reach.test.mjs:82-87` (verified) does not mention the sim or native load it brings.

### 6. The rule named as the merge owner is the one that is stale — low

- **The stale rule.** `build-and-commit.md:216` still says the agent merges "once CodeRabbit has approved", with no `--admin` exception (verified).
- **Why it matters.** `issue-workflow.md` names that file as the owner of "the merge mechanics".
- **Where the mechanics actually are.** The `no-coderabbit` / `--admin` path is described in four other places, which agree with each other: `code-review.md`, `issue-workflow.md`, `hooks.md` and the `issue-lead` skill. So the owner is the one place that is wrong.

### 7. Third-party actions that hold secrets are pinned by tag — low, pre-existing

- **Firebase deploy.** `firebase-hosting-release.yml:537` runs `FirebaseExtended/action-hosting-deploy@v0` with the Firebase service account (verified).
- **Release upload.** `release-pack.yml:186` runs `softprops/action-gh-release@v3` with `contents: write` (verified).

**Why it matters.** A moved tag on either runs unreviewed code with those secrets. The repo holds npm to `minimumReleaseAge` and explicit `allowBuilds`, but no rule decides this. `dependabot.yml` already watches `github-actions`, so it could keep pinned commit hashes current.

### 8. Stale lines — low

- **`iracing-sdk/src/SDKController.ts:398-401`.** It says subscriber order matters because "the Elgato extension relies on the translator subscribing first" (verified). Since #1500 the extension ticks on `sim.onTick`, a contract and not an order. The order does still matter, but for the replay recorder (`tick-order.ts`).
- **`audio-service/src/testing.ts:5-7`.** It says `testing.test.ts` fails on a production import. #1375 moved that guard to `scripts/testing-entries-test-only.test.mjs` (verified).
- **`.claude/skills/iracedeck-actions/SKILL.md`.** It still says the remembered replay speed is "fed from the telemetry of every Replay Control key or dial that is showing" (verified). #1427 made the engine feed it.
- **Two descriptions of the debounced replay state miss the seek hold:** `replay-markers-ops.ts:132-136` and `replay-recorder.ts:26-31`.
- **The README.** It says "265+ modes" (`README.md:29`, verified), while its own table sums to 284, as the website says.
- **Two open issues describe code that no longer exists.** #1126 and #1148 cite three identical voice-pack blocks in the shells' `plugin.ts`. The shells are 22–24 lines, and the logic exists once, in `plugin-runtime/src/phases/voice-packs/scan.ts`. What is left of #1148 is a pure row builder, which is still a closure inside `buildVoicePackScan`.

## Trade-offs, not defects

Raised during the review, checked, and kept out of the ranking because each is a deliberate, documented choice.

**Error isolation**
- **A failed tick step keeps its partial writes.** No snapshot or restore: "a diff writes its baseline last" (#1559 spec, decision 6), and the same-tick reads a throw loses are listed (decision 3).
- **A failed canonical order skips its six consumers for that tick** rather than feeding them the last order (#1559 spec).
- **Plugin builds always run the error boundary in `"report"` mode,** development builds included; only tests choose `"rethrow"` (#1558 spec, decision 5).

**Replay**
- **The seek hold ends at the target's `giveUpMs`** (`replay-command-gate.ts:550-561`).
- **A speed change made from iRacing's own replay bar inside the lag is masked** until the 500 ms hold runs out (`replay-speed-state.ts`).
- **A jump picks its speed from four sources in a fixed order,** and these are distinct concepts (`replay-jump-playback.ts:236-246`).
- **`toldSeekHold` dedupes what the gate told the SDK;** it is not a second record.
- **`readSubSessionId` accepts numeric strings,** with the reason stated.

**Deck**
- **#1597 is one mechanism wired three times.** Each adapter keeps its own enqueue sites and its "appear while live" branch, and the shared scenarios hold all three to the contract.
- **The dial base leaves some members per surface on purpose:** `down`, the start of `up`, rendering and throttling. Two helpers also stay per surface, `buildTriggerDescription` / `gestureLabel` (14 copies) and `seedDialFromLegacySetting` (11 copies), and 19 delegating press-shape pairs stay in the actions (#1589 spec, *Out of scope* and decision 4).
- **The Ulanzi promotion step is fire-and-forget** and catches its own errors. `knownEncoderContexts` is never pruned, by design.
- **`deck-core` ships its contract suite as `./testing`,** which imports no vitest. `fake-sim-connection.test-support.ts` is compiled into `dist` but not exported.

**Race Engineer and sim**
- **`lapTime.wasInvalid` stays registered for pack compatibility.**
- **The limiter speak gates read part of what the emitter reads,** sharing its engaged-bit helper and leaving out its creep check on purpose.
- **`SessionClass` lives in `event-bus` but is never published.**
- **There are two clocked fakes with different semantics,** both built on the shared fake.
- **`isTrackGapSession` keeps exact `"Lone Qualify"` / `"Lone Practice"` strings** inside the sim package, as an allow-list.

**Release and tooling**
- **The live voice-catalog check is 292 lines of JavaScript inline in the workflow YAML,** where no linter or type gate reads it. The publish path runs that file from `master` against an older tag's checkout; a test runs the step, and the cost is documented (`firebase-hosting-release.yml:223-226`).
- **A release branch cut before #1613 has no such check.**
- **Dependabot PRs merge under `--admin` with no review,** gated on the author and on every commit being Dependabot's.
- **The three plugin turbo build entries stay three copies,** since turbo has no wildcard package key, and a test holds them to one shape.
- **The website declares `iracing-actions` and `voice-packs` only for build ordering.**
- **`hook-internals.md` (48k) loads with any hook file,** which is an on-demand cost, not a budget one.
- **The local turbo cache is 105 GB.**

## Extensibility

| Change | 2026-11-01 | Now | Why |
| --- | --- | --- | --- |
| New first-party voice pack | Low-moderate | Same | Unchanged |
| New action | Moderate, linear | Same | Unchanged |
| Dial on an existing action | Low-moderate | **Low** | Extend the base, implement its hooks; the guard forces the late-input suite and the Encoder pairing |
| A feature every dial surface needs | ~18 copies | **One edit** for lifecycle or press shapes | Release, render and appearance fields are still per surface (*Trade-offs*) |
| New callout in an existing family | Low-moderate | Same | Every hand list and the `endsOn` order are checked |
| New callout family | Moderate | **Moderate, fully guarded** | `GATED` is checked by identity, and a per-car position takes the neutral key |
| New mixer channel | Low + 39 fakes | **Low** | No fake edit; a new `IAudioService` member breaks one file |
| New replay mode | Low-moderate | Same | One speed owner, one replay-state owner |
| New deck host | Medium | **Medium, better defined** | The lifecycle-ordering contract is explicit and enforced by tests, and the file sink is shared; an adapter still writes about 15 enqueue sites |
| Second sim | Better | **Better** | It gains a sim-neutral `SessionClass` on `SimRuntime`, a sim-neutral step runner and error boundary, and a slice convention to copy. Unchanged: iRacing payload types and 11 `iracing-sdk` helper values in the catalog, 12 casts, 26 `SimIRacingAction` subclasses, 11 `getCommands()` files and 11 direct translator getters in actions, a translator typed on the concrete `SDKController`, and 235 flat legacy members |

## The process layer

Judgement, not a defect.

- **The follow-up loop works.** All eleven follow-ups from the last two reviews merged within a week, each meeting its issue bullet by bullet, with guards that plant their own failure.
- **The product code grew 3.8% in the window.** The tooling grew faster: scripts by 30%, workflows by 49% and hook code by 70%.
- **The weak point is where gate mechanics get written.** Each gate feature restates how it decides in three or four always-loaded files, which `hooks.md`'s rule 1 already forbids, and no review enforced it. That is the cause of items 1 and 6.
- **The on-demand documents grew too.** `CLAUDE.md` files grew 72k (`sim-events-iracing` +15.3k, `deck-core` +14.6k). They load on demand, but they are the next place this pattern will show.
- **Contradictions.** The reviewers found one between rule files (item 6). The rule index in `.claude/CLAUDE.md` matches `.claude/rules/` exactly.

## Follow-ups

Filed or updated with this review, in the order it would take them (new issues through the file-issue skill, on Niklas's approval):

1. [#1658](https://github.com/niklam/iracedeck/issues/1658): **move the gate and deploy mechanics out of the always-loaded rules** (items 1, 6).
   - Move the `--admin` and no-review mechanics, the #1649 allowance detail, the #1613 deploy decision table, the spec-heading grammar, the `.astro` / `.mts` coverage detail and `issue-workflow.md`'s merge mechanics into path-scoped rules or `hook-internals.md`, leaving one line and a pointer in each always-loaded file.
   - Bring `build-and-commit.md`'s merge rule up to date as the owner.
   - Urgent: the floor is 1,130 characters away.
2. [#1659](https://github.com/niklam/iracedeck/issues/1659): **extract the merge gate from `rules-bash.mjs` and `lib.mjs`** into `merge-gate.mjs` with its readers. Move the spec-heading grammar to its own module. Write down a stopping rule for the lexer (item 2).
3. [#1660](https://github.com/niklam/iracedeck/issues/1660): **one "frame is held" rule for the replay walk start** (item 3). Decide it once, in the SDK state or the engine; have Replay Control and Replay Markers read it; and test it through a seek hold.
4. [#1661](https://github.com/niklam/iracedeck/issues/1661): **make the two guards hold what they state** (item 4).
   - The slice guard: a frozen ceiling on the pin, and a rule refusing a new diff module typed on the whole state.
   - The replay barrel: a check that every value has a production consumer. Move the three test-only values to `./testing`, and delete `isReplayMoveUnderWay`.
5. [#1662](https://github.com/niklam/iracedeck/issues/1662): **keep the website build sim-free** (item 5). Have the gallery take its render functions from sim-free modules, or state the exception beside `website` and in the allowed-reach reason.
6. [#1663](https://github.com/niklam/iracedeck/issues/1663): **pin the secret-holding third-party actions by commit hash** (item 7), kept current by Dependabot.
7. [#1664](https://github.com/niklam/iracedeck/issues/1664): **correct the stale lines** (item 8): the `SDKController` comment, the `audio-service` `testing.ts` pointer and the skill's speed line. The two replay-state descriptions went into [#1660](https://github.com/niklam/iracedeck/issues/1660), and the README mode count is already tracked in [#1271](https://github.com/niklam/iracedeck/issues/1271), where it is now commented. Comments on #1126 (propose closing) and #1148 (propose re-scoping to the row builder) record that the copies are gone.

Not proposed: moving the gap-horizon maths out of `translator.ts` (a placement note), the remaining per-surface dial helpers (deferred in #1589's spec), and pruning the turbo cache (operational).
