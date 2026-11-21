# Architecture review — 2026-11-21

> **Previous:** [2026-11-08](2026-11-08-architecture-review.md) · **Follow-ups:** [#1741](https://github.com/niklam/iracedeck/issues/1741) · [#1742](https://github.com/niklam/iracedeck/issues/1742) · [#1743](https://github.com/niklam/iracedeck/issues/1743) · [#1744](https://github.com/niklam/iracedeck/issues/1744) · [#1745](https://github.com/niklam/iracedeck/issues/1745) · **Still open from the previous review:** [#1658](https://github.com/niklam/iracedeck/issues/1658) · [#1659](https://github.com/niklam/iracedeck/issues/1659) · [#1660](https://github.com/niklam/iracedeck/issues/1660) · [#1661](https://github.com/niklam/iracedeck/issues/1661) · [#1662](https://github.com/niklam/iracedeck/issues/1662) · [#1663](https://github.com/niklam/iracedeck/issues/1663) · [#1664](https://github.com/niklam/iracedeck/issues/1664) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#1271](https://github.com/niklam/iracedeck/issues/1271)
>
> Point-in-time review of `master` at `884864c8e` (v3.10.0-dev.0, just after the v3.9.0 release, `7a337abab`). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

This review covers the thirteen days and 137 commits since the 2026-11-08 review (`ce3beb3a6..884864c8e`). 102 of those commits are spec edits and 35 are code. Together they make up the 3.9.0 release.

**What 3.9.0 added:**

- **Race Engineer:**
  - sector times compared with the leader and the cars around you (#1572);
  - sector starts in practice (#1573), and the corner and sector start called together when they overlap (#1676);
  - traffic at the pit exit (#1113), a beep at the pit exit line (#1161) and a beep when the pit limiter is switched on (#1272);
  - lap times read to the thousandth (#1688);
  - one clip set per spoken driver name, with an alias map (#1580);
  - the Default engineer re-recorded (#1643), every clip loudness-normalized (#1657), and iRaceDeck's own voice named Shawn (#1716);
  - three scheduler fixes: #1681, #1696 and #1698.
- **Pit-lane landmarks.** The plugin now learns where each track's pit lane is (#1112). That added the 40th package, `@iracedeck/track-store`.
- **Deck.**
  - Keys that need iRacing are dimmed while it is not running (#1599).
  - Black Box Selector gained a mode that operates the open black box's selected control (#1585), and one that toggles the black box's size (#1238).
  - Corner Names key modes (#1699), a Minimal Drive UI mode (#1584), the pit speed limit shown in the driver's units (#1476), and Pit Crew toggles without titles (#1479).
- **Translator.**
  - The canonical race order is computed once per tick (#711).
  - One standings check is shared by the opponent diffs (#950).
- **Release path.**
  - Settings-window screenshots are captured in the stable release (#1536).
  - Voice-pack records are sealed at release, and a voice-pack change without a version bump fails (#1667).
  - Fragments merged after a stable fold compose as Unreleased (#1398).
- **Dependencies.** A 31-update dependency bump.

**None of the seven follow-ups the 2026-11-08 review filed (#1658–#1664) has merged or been started.**

**How it was done.** The method is the one the 2026-10-25 review set down.
- **Seams.** Five read-only reviewers each took one seam. The fifth now covers both persistent stores, the replay stack and the new pit-lane landmark stack, since the two share a shape. The other four are sim and telemetry; the deck platform; audio and the Race Engineer; and cross-cutting build, settings and process.
- **Pinned trees.** Each reviewer re-ran the previous counts on both trees, pinned as extracted copies.
- **A lost baseline.** A scratchpad cleanup emptied the shared baseline copy partway through, and the recorded scripts went with it. Every reviewer measured its baseline from its own `git archive` of `ce3beb3a6` and rebuilt its scripts. Each confirmed that its copy matches the re-extracted baseline byte for byte, and that the rebuilt scripts reproduce the previous review's published figures. Where a figure does not reproduce, it is listed under *Corrections*.
- **Checking.** Every finding was checked against the code before it was kept. Deliberate, documented choices are listed under *Trade-offs, not defects*.
- **Marks.** Figures marked **(verified)** were re-measured by the coordinator; the rest come from one reviewer's measurement. Judgements are marked as such.

**God module** keeps the earlier definition: a module holding several unrelated responsibilities, or state shared across concerns that have nothing to do with each other. Size alone does not make one.

Line counts are physical lines of non-test `.ts` under `src/` unless stated.

## Verdict

**The structure carried a feature release with almost no strain. The work that keeps the process layer within its budget has stalled, and that is now urgent.**

- **The new Race Engineer families and cues touched no engine module.** #1572, #1573, #1113, #1161 and #1272 all landed without one. The three scheduler fixes landed inside the scheduler, so imperative plays are now arbitrated there.
- **Every hand-kept list grew in step and is checked:**
  - 113 / 113 callout keys against the baseline;
  - `GATED` 32 / 32;
  - the contract floor equal to the contracts;
  - one shortcut per callout.
- **The sixth mixer channel needed no fake edit,** because of #1504's shared fake.
- **The translator's state convention took all the growth.** About ten new pieces of state arrived as slices, with none added flat. The pinned legacy flat list shrank by 6 and gained none. Slice-typed diff declarations went from 12 to 42.
- **All seven new bus events are sim-neutral,** and the new track identity carries a sim id.
- **The eight deck features touched no adapter or shell.** The adapters' only diff in the window is their `package.json` files.
- **#1599 is one mechanism, and sim-neutral.** It is one presence signal derived in `deck-core` from `SimConnection`, one image funnel, and one `needsSim` decision per action. It deleted a per-instance readiness state along with 57 readiness calls.
- **#1112 added a package the way the earlier reviews asked.** It came with its lint rule, alias, Architecture-page node and edges, README row and `CLAUDE.md` files. `track-data` really is sim-neutral now.
- **The release path fails closed at every step,** and its failure paths are tested in real git repositories. The 3.9.0 release went through it in one commit.

**What did not move:**

- **The always-loaded instructions are 24 characters from failing CI** (119,976 of 120,000, verified). #1658, filed to fix this, is untouched. This window's growth was honest documentation (a package row and the two new release steps), so the floor now blocks correct changes too.
- **The other six follow-ups are also untouched:** #1659–#1664. None regressed, and none moved.
- **New drift in the window.** The persisted-file discipline is now copied three times, and one copy missed a fix. Two facts each gained a second reader with a stricter rule. A Race Engineer task now loads about 600k characters of instructions.

## What moved since 2026-11-08

| #   | Previous finding                                                | Status                        | Now                                                                                                                                                                                       |
| --- | --------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Always-loaded instructions 1,130 from the floor (#1658)         | **Worse**                     | 118,870 → 119,976 of 120,000 (verified). None of #1658's tasks done (item 1)                                                                                                              |
| 2   | The merge gate spread over two hook modules (#1659)             | **Unchanged**                 | Hook code byte-identical: no `merge-gate.mjs`, no stopping rule for the lexer. Hook growth stopped completely (it was +70% last window)                                                    |
| 3   | Replay walk start's grace-only "frame is held" rule (#1660)     | **Unchanged**                 | `replay-record-walk.ts:94-96` byte-identical; Replay Markers still steps from `state.frame`                                                                                                |
| 4   | Two guards weaker than their stated invariant (#1661)           | **Unchanged, nothing drifted** | The slice pin can still grow but shrank 6, gained 0. The three test-only replay barrel values are still there                                                                             |
| 5   | The website build loads the sim stack (#1662)                   | **Unchanged**                 | The gallery still imports the two dial surfaces that value-import `iracing-sdk` and `deck-iracing`                                                                                        |
| 6   | The merge-owning rule is the stale one                          | **Unchanged**                 | `build-and-commit.md:216` still has no `--admin` exception                                                                                                                                |
| 7   | Secret-holding actions pinned by tag (#1663)                    | **Unchanged**                 | Workflows byte-identical                                                                                                                                                                  |
| 8   | Stale lines (#1664)                                             | **Unchanged, one more set**   | All three still stale; the mixer's channel count drifted in three more places (item 7)                                                                                                    |

## Baseline figures

The numbers a later review should re-measure. Both columns use the same method.

| Measure | ce3beb3a6 | 884864c8e | Method |
| --- | --- | --- | --- |
| Packages / `@iracedeck` edges (dep ∪ dev) / prod edges / longest chain | 39 / 148 / 129 / 7 | 40 / 153 / 134 / 7 | `graph.mjs`; +4 for `track-store`, +1 `iracing-actions → icon-composer` |
| Package cycles | 0 | 0 | DFS, with a positive control |
| Test reaches into a sibling's `src`, not allow-listed / vitest aliases | 0 / 36 | 0 / 37 | `reach.mjs`; alias block |
| `SIM_NEUTRAL_PACKAGES` entries | 26 | 27 (+`track-store`) | `eslint.config.js` |
| Architecture page: drawn edges / drawn but undeclared | 91 / 0 | 95 / 0 | `mermaid.mjs` |
| `deck-core` runtime lines / sim imports | 7,681 / 0 | 7,733 / 0 | `measure.mjs`, test support excluded |
| `plugin.ts` sizes / shell sim imports | 22 / 23 / 24; 0 | 22 / 23 / 24; 0 | `wc -l`; grep |
| `iracing-actions` non-test lines / files | 48,525 / 138 | 49,926 / 138 | `measure.mjs` |
| Dial surfaces / lines / lifecycle definitions | 18 / 13,194 / 1 each | 18 / 14,004 / 1 each | definitions, not call sites |
| `translator.ts` lines | 3,968 | 4,732 | `wc -l`; #1113 +228, #1572 +208, #1112 +138, #711 +89, #1573 +86 |
| `TranslatorState` members / slices / pinned flat | 239 / 4 / 235 | 243 / 14 / 229 | `members.mjs`, `pin2.mjs` |
| Diff declarations on the whole state / on a slice | 87 / 12 | 85 / 42 | `sigs2.mjs` (see *Corrections*) |
| `TranslatorInstance` members | 25 | 37 | `inst.mjs` |
| `SimRuntime` / `HostSim` members | 23 / 4 | 24 / 4 | AST |
| Bus events / `carIdx` payload fields / `subSessionId` fields | 79 / 10 / 5 | 86 / 10 / 5 | grep of `event-catalog.ts` |
| Catalog files importing a sim package / `e.telemetry` casts | 13 / 12 | 15 / 13 | `simimports.mjs`; grep |
| `ScenarioEngine` span / methods; `Scheduler` class span / methods | 377 / 23; 738 / 26 | 385 / 25; 957 / 30 | AST |
| `registerPitCrew` / `PitCrewDeps` keys | 836 / 33 | 944 / 35 | AST |
| Callout keys / baseline rows; contracts / `CATALOG_FLOOR`; `GATED` rows / maps | 105 / 105; 170 / 170; 29 / 29 | 113 / 113; 181 / 181; 32 / 32 | registry vs fixture; `pack-reference.json`; coverage test |
| `createFakeAudio` definitions / importers | 1 / 52 | 1 / 61 | grep |
| Mixer channels | 5 | 6 (verified) | `addon.cc:148` |
| `./pit-crew` subpath names / used outside `pit-crew/` | 201 / 33 | 268 / 47 | `subpath-used.cjs` |
| Replay stack lines / test ratio | 24,904 / 2.05 | 24,900 / 2.05; `replay-engine` and `replay-store` byte-identical | `measure.cjs` |
| Pit-lane landmark stack: `track-data` / `track-store` / translator detector | — | 1,098 / 1,338 / 704 lines | `wc -l` |
| Copies of the corrupt-aside and atomic-write discipline | 2 | 3 | settings-store, replay-store, track-store |
| Always-loaded rules + `.claude/CLAUDE.md` | 118,870 ch | **119,976 ch** (verified); test fails above 120,000 | as `claude-rules-frontmatter.test.mjs` measures |
| Instructions loaded on demand by touching an `audio-scenarios/src` file | 528,699 ch | 599,595 ch | `pathload.mjs`: matching path-scoped rules plus nested `CLAUDE.md` |
| `race-engineer-callout-examples.md` / `audio-scenarios/CLAUDE.md` / `sim-events-iracing/CLAUDE.md` | 292,049 B / 106k / 26.1k | 334,468 B (verified) / 125.8k (verified) / 47.4k (verified) | `wc -c` |
| `.claude/rules` total / `CLAUDE.md` bytes (count) / skills / agents | 1,024k / 725k (37) / 197k / 13.0k | 1,106k / 835k (38) / 203k / 13.3k | `wc -c` |
| Hook code, non-test / test lines | 8,361 / 10,579 | identical | `wc -l` |
| `scripts` non-test `.mjs` / package `src` non-test `.ts` (no `.d.ts`) | 21,931 / 195,532 | 24,482 / 214,777 | `wc -l` |
| Commits / `docs(specs)` | 85 / 41 | 137 / 102 (45 issues) | `git log` |
| Master push CI runs on spec-only heads / post-merge runs green | 0 / 176 of 176 | 0 / 148 of 148 | `gh run list` |
| Local turbo cache | 105 GB | 117 GB | `du -sh` |

### Corrections to the earlier reviews

- **Diff declarations "88 / 23"** (2026-11-08) come out as 87 / 12 at `ce3beb3a6` with an AST parser. The trend holds.
- **"35 steps / 11 values"** counts as 34 / 11.
- **`getCommands()` files.** There are 12 on both trees, not 11.
- **`SIM_NEUTRAL_PACKAGES`.** The list held 26 entries at `ce3beb3a6`, not 25.
- **"Lines shared by ≥9 dial surfaces: 1,737"** does not reproduce under any filter. The rebuilt method gives 2,160 → 2,146, which is flat.
- **The per-surface dial helpers.** `buildTriggerDescription` and `gestureLabel` are defined in 17 and 15 files, not 14 (the 2026-11-08 trade-off). Neither moved.
- **Package `src` 197,753** included `.d.ts`; it is 195,532 without them.
- **Units.** "Engine modules 13 / 4,905" (2026-11-01) and the 2026-11-08 class spans use different units; both are restated above in one method. `registerPitCrew` was 836, not 837.
- **`race-positions.md`** says the canonical order is "computed once per tick, readers included". In a race it is computed twice, by design: the leader check runs before the order step (#1278), which the same file explains (item 7).

## What is good

- **The engine split held through a large Race Engineer release.**
  - No new family touched an engine module. #1113's only engine edit is a comment.
  - The three scheduler fixes landed inside `Scheduler`. #1681 renamed `queuedAt` to `dueAt` through the queue, the stash and `describeState`, and no reader of the old name remains. #1696 and #1698 moved imperative plays into arbitration, so every Voice line now goes through one router to the scheduler.
  - `ScenarioEngine` gained only two delegating methods.
- **The guards that keep the catalog's lists in step held under growth:**
  - eight new callout keys, each with a baseline row;
  - three new `GATED` maps, matched by identity;
  - the floor raised with the contracts;
  - nine new test files injecting the one shared fake.
- **#1580's alias map has one owner.** `callout-script/src/driver-name-aliases.ts` is imported by the engine, the generator, `lint-pack` and the pack-reference builder; no copy exists.
- **#1667's pack-record guard can fail and is live.** It has 52 cases that plant a failure, plus a floor on each voice's clip count so an empty walk cannot pass. Both records are sealed at 2.0.0, so it already applies on `master`.
- **The translator's slice convention took the whole window's growth.** There are 10 new slices, 0 new flat members and 6 flat members moved out. None of the 12 new diff modules takes the whole state.
- **#711 left one owner of the canonical order per tick.** `resolveCanonicalOrder` writes a frozen, readonly memo, and `readCanonicalOrder` is the one reader path. #950 put the class screen, the projection and the same-lap test in one module, `diff/standings.ts`.
- **The sector comparison keeps facts and policy apart.** The catalog declares its own input type, and the wiring maps the translator's snapshot onto it with a compiler check. Its targets come from the canonical order the gaps already resolve, not a second one.
- **#1599 is one sim-neutral mechanism.**
  - `deck-core` derives "the sim is gone" once from `SimConnection` ticks, debounced and behind `createErrorBoundary`. iRacing supplies its delay from one constant, so `SimConnection` did not widen.
  - Every key image goes through one funnel, `decorateKeyImage`, and each action decides only through `needsSim(settings)`.
  - The old per-instance readiness state, shared by every key on an action, is deleted with 57 call sites and the dead "N/A" overlay.
- **#1112 is a complete package split.**
  - `track-data` has no runtime dependencies and holds the sim-neutral landmark model and learner. The translator keeps only iRacing's identity resolver and edge detector.
  - `foldSample` is the one entry point for a sample, used by both the learner and the store.
  - The shared folder is handled with care: every write re-folds the process's own samples, a settle check heals the rename race, and a newer, foreign or unreadable file is never written. An IO seam allows real two-process tests.
  - Learning happens on live ticks only, so a replay cannot teach a landmark.
  - `sim-events-iracing` does no file I/O and gained no package edge; the store's reader comes in as a function.
- **The release path (#1536, #1667, #1398) fails closed.**
  - `before:bump` refuses a bad version or an unloadable record and dry-seals every pack before it writes anything. It orders the fold, the seal and the bump so that a failure leaves the least to undo, and every failure names its exact restore.
  - `after:bump` refuses developer markers, checks the built plugin and refuses any tracked change it cannot account for.
  - The failure paths are tested in temporary git repositories: 27 hook tests and 53 capture tests.
- **The Architecture page is exact.** It draws 0 undeclared edges, and every undrawn production edge is named in its prose. The rule index matches the 37 rule files exactly.
- **CI held.** All 148 post-merge runs were green, and no spec-only push ran CI. The 102 spec commits respected the freeze rule: no shipped spec was edited.

## Large modules

Sorted by the definition. A large cohesive module is not a finding.

| Module | Size | Responsibilities | Verdict |
| --- | --- | --- | --- |
| `sim-events-iracing` `translator.ts` + `TranslatorState` | 4,732 lines; 243 members (14 slices, 229 pinned flat) | 43 guarded steps and 15 guarded values; getters; YAML resolvers | **God module, second clause, under a migration that is working.** New state arrives only as slices. `TranslatorInstance` grew to 37 members, outside the slice guard, on purpose (*Trade-offs*) |
| `scripts/claude-hooks/rules-bash.mjs` / `shell-lexer.mjs` | 2,160 / 2,845 | Rules plus merge-gate verdicts plus spec-heading grammar / lexing | Unchanged; #1659 open |
| `audio-scenarios` `Scheduler` | 957-line class, 30 methods | Bus arbitration | **One concern.** It grew by imperative plays moving into arbitration, which is a gain |
| `audio-scenarios` `ScenarioEngine` | 385 | Facade | Unchanged in shape |
| `audio-scenarios` `traffic.ts` / `sector-comparison.ts` | 949 / 844 | One family each | Cohesive family files |
| `audio-scenarios` `registerPitCrew` / `scenario-shortcuts.ts` | 944 / 4,933 | Composition list / data | By design |
| `iracing-actions` `black-box-selector-dial-surface.ts` | 1,220 (+826) | One surface: gesture model, strip and knob drawings, surface class | Cohesive, on the shared base |
| `track-store` `createTrackStore` | 665 | One store | Cohesive; holds the third copy of item 2's primitives |
| `track-data` `pit-lane-landmarks.ts` / `pit-lane-learner.ts`; translator `diff/pit-lane-landmarks.ts` | 713 / 385; 704 | Model / learner (pure); iRacing edge detector | Cohesive |
| `replay-engine` gate / `walkToLapStart`; `replay-store` `createReplaySessionStore` | 2,702 / 1,018; 1,050 | — | Byte-identical; cohesive |

## What is bad, ranked

### 1. The always-loaded instructions are 24 characters from failing CI — medium, urgent (process)

- **Where it stands.** The set measures 119,976 characters (verified). `claude-rules-frontmatter.test.mjs` fails above 120,000, so the next sentence added to any always-loaded rule or to `.claude/CLAUDE.md` turns `pnpm test` red. The floor was not lowered: the test file is byte-identical.
- **What it grew by:** #1536 +501, #1667 +348, #1112 +218 (the `track-store` row) and #1398 +39. This is honest content, the package row and the two new release steps, not restated gate mechanics. So the floor now blocks correct documentation as well as drift.
- **#1658 has not started.** It was filed for exactly this. The five files it names are the same size to the character: `hooks.md` 12,051, `code-review.md` 12,747, `specs-and-plans.md` 8,180, `code-style.md` 5,458 and `issue-workflow.md` 16,221.
- **What that means.** #1658 is now a prerequisite for any process change, #1658's own edits included: its moves out have to land before anything is added.

### 2. The persisted-file discipline is copied three times, and one copy missed a fix — low-medium

- **The three copies.** Each store hand-writes the same primitives: atomic temp-and-rename, moving a corrupt file aside with a copy fallback, a byte-compare for an identical aside, `isoStamp` and a stale-temp sweep. They are in `settings/src/settings-store.ts`, `replay-store/src/replay-session-store.ts` and the new `track-store/src/track-store.ts`. Only `WRITE_RETRY_DELAYS_MS` is shared, although both newer stores already depend on `@iracedeck/settings`.
- **How the copy drifted.** On 2026-09-26, #1036 taught settings-store that an older aside it cannot read is "not a match" (`settings-store.ts:187-190`, `.catch(() => undefined)`, verified). Replay-store had copied `findIdenticalAside` the day before and never got the change: it calls a bare `readFileSync` on each aside (`replay-session-store.ts:358-369`, verified). Track-store has the guard (`track-store.ts:582-586`, verified).
- **The failure.** The rename of a corrupt session file is refused, and one older `session_<id>.corrupt-*.json` cannot be read. The read then throws into the copy-failure branch, which logs "the session runs in memory and nothing is written" (`:654-656`, verified). From then on, that session's markers, laps and incidents are never persisted. It fails closed and needs a narrow precondition, but it is a fix that did not reach one of the copies.
- **The docs are now wrong.** `replay-store/CLAUDE.md:27` says it uses the "Same write discipline as … `settings-store.ts`" (verified). It no longer does.
- **What differs on purpose.** The deliberate differences between the three are held in prose only: whether the original is unlinked after a copy, the free aside name, and the re-read before the move.

### 3. Two facts each gained a second reader with a stricter rule, while the docs say there is one — low

- **Race progress at the start/finish line.**
  - The claim. #1572 added `readCarProgress` (`diff/car-progress.ts`). It corrects the one-tick disagreement between the lap counter and the lap fraction, which affected 8 of 24 crossings in a capture. `sim-events-iracing/CLAUDE.md:17` calls it the one place that gate lives, "so every reader sees one scale" (verified).
  - The other readers. #950's `lapProgress` (`diff/standings.ts:61-70`, verified) and the canonical order's scoring (`diff/race-finish.ts`) still use the raw `lc + dp`.
  - Where the two meet. `assessCar` (`opponent-flags.ts`) uses both scales in one decision: a raw same-lap test and the corrected `getRaceGap` range. At the line, a car can be judged a lap apart for one tick. Nothing yet shows that this produces a call.
- **Whether the player is in the pit stall.**
  - The stricter reader. `diff/traffic-pit-exit.ts` reads the stall flag and, on a tick that does not send it, falls back to the track surface reading `InPitStall` (`readInStall`, verified). It detects leaving the stall against a baseline of its own.
  - The other readers. `diff/pit-lane.ts:50` and six other diffs read `PlayerCarInPitStall ?? false` (verified).
  - The effect. On a tick without the flag, the two detectors can disagree, while traffic-pit-exit's header says its edge is the one `pitStall.departed` is read from.

### 4. Touching a Race Engineer file now loads about 600k characters of instructions — low-medium (process, judgement)

- **What loads.** Touching any `packages/audio-scenarios/**` file loads these path-scoped rules and the package's `CLAUDE.md`, on top of the 120k always loaded:
  - `race-engineer-callout-examples.md`: 334k bytes (verified), up 42k in the window;
  - `race-engineer-callouts.md`: 96k;
  - `race-positions.md`: 22k;
  - `logging.md`: 24k;
  - `audio-scenarios/CLAUDE.md`: 126k (verified), up 20k.

  That is 599,595 characters, up 13% in thirteen days.
- **Why it keeps growing.** The examples file is append-only by design ("one entry per past callout"), and it loads whole for every Race Engineer task. Single entries now run to about 10k characters (the #1405 fuel entry, the #1572 sector entry).
- **The sim package too.** `sim-events-iracing/CLAUDE.md` grew 81%, from 26.1k to 47.4k (verified). One line of it is a full paragraph on the car-progress correction.
- **Why it is ranked.** This is the place the 2026-11-08 review named as next for the pattern. It is not a code defect, but it is a measured, growing per-task cost with no guard.

Judgement: an index plus entries read on demand would stop the linear growth of the examples file.

### 5. Public surfaces with no consumer, two of them documented as the way in — low

- **The audio service's voice-sequence API has no production caller.**
  - What is unused. `IAudioService.playVoiceSequence`, `cancelVoiceSequence` and `onVoiceSequenceComplete`, and the state machine behind them (`audio-service.ts`), have no production reference outside the service (verified). The state machine is also wired into `stopChannel`, `stopAll` and the Voice end callback.
  - Why #1698 sharpened it. #1698 made `playVoiceLine` the one route for every Voice line. Its fallback is `iracing-actions`' own `playVoiceSequence` (`audio/audio-toggles.ts:90`), which has the same name as the dead service method, and the rules name "`playVoiceSequence`" without saying which.
  - The cost. A second, unarbitrated Voice route stays on the interface that every fake mocks.
- **`getPitLaneLandmarks()`** is on `sim-events-iracing`'s barrel (`index.ts:36`, verified), but only its own tests call it. Its one production consumer reads the learner on the translator instance instead.
  - What the docs say. The Architecture page and `sim-events-iracing/CLAUDE.md:19` name it as the way a consumer outside the translator reads landmarks.
  - What #1112's spec says. A consumer outside the translator "adds the `SimRuntime` member".
  - The precedent it breaks. #1573's track sectors deliberately export no getter.
  - Why it matters. It invites a twelfth direct translator getter, which earlier reviews count as second-sim debt. It is the same shape as #1661's replay barrel values, which are also still there.

### 6. A promised follow-up was never filed — low

`scripts/lib/settings-window-capture/capture-manifest.mjs:35-39` says "The 3.9.0 release ends the exemption … A follow-up deletes this constant and the branch that reads it" (`FIRST_CAPTURED_RELEASE = "3.9.0"`, verified).

3.9.0 has shipped and `capture.json` says `3.9.0`, so the branch is dead. No issue exists (verified), and `website-screenshots.md` still describes the bootstrap as a live rule.

### 7. Documentation drift — low

- **The mixer is still called five-channel in three places:** `audio-native/src/addon.cc:5` ("Provides a 5-channel mixer (IRD_MAX_CHANNELS)") and `README.md:120` and `:172` (verified). `IRD_MAX_CHANNELS` is 6 (`:148`). #1161 corrected the other mentions and missed these.
- **`race-positions.md`** says the canonical order is "computed once per tick, readers included". In a race it is computed twice, by design (the leader check before tracking, #1278).
- **#1664's three lines are still stale:** the `SDKController` subscriber-order comment, the `audio-service` `testing.ts` guard pointer and the `iracedeck-actions` skill's replay-speed line. The README's "265+ modes" is #1271's.

### 8. Carried over, unchanged — see the table above

#1659 (the merge gate spread over two hook modules), #1660 (the walk start's frame rule), #1661 (the two weak guards), #1662 (the website build loading the sim stack), #1663 (tag-pinned secret-holding actions) and the stale merge-owner line in `build-and-commit.md`. None regressed; none moved.

## Trade-offs, not defects

Raised during the review, checked, and kept out of the ranking because each is a deliberate, documented choice.

**Translator and sim**
- **`TranslatorInstance` grew from 25 to 37 members, outside the slice guard.** The pit-lane learner is instance-level so replay wipes keep it, and it is reset by hand in two places. Identity-keyed memos went from 2 to 5, each hand-written in the same shape.
- **The pit-lane landmark types exist twice,** in `event-bus` and `track-data`, so the catalog stays a leaf. A test holds them identical both ways with `expectTypeOf`, which is a compiled mirror, not a comment.
- **The pit exit beep gates in the catalog,** reading the event's own telemetry, because a beep has no later moment at which to re-check. The traffic pit-exit lines check the live track surface at speak time through `getLatestTelemetry`.
- **The identity and class-key types are iRacing-shaped** (`trackId` / `carClassId: number`), deferred to #714, with version fields reserved for the change.
- **The learning constants are tuned on one Spa capture,** as `track-data`'s `CLAUDE.md` states.

**Stores**
- **Store IO is synchronous,** including `load` from the live tick, once per identity and then on a 5–60 s back-off.
- **Two builds of one `TrackID` take turns rebuilding the file,** and the settle check never rebuilds.
- **A renamed track's file is moved aside and relearned.**
- **There is one landmark folder for every deck host,** unlike the per-ecosystem settings and replay folders.
- **Track-store keeps the original after a copy,** because a write always follows. Item 2 is about the duplication, not this rule.

**Race Engineer**
- **A development-flag seam for catalog lines (#1113).** It covers `DEVELOPMENT_FEATURES`, `release-flags.mjs` and a `PitCrewDeps` key that defaults off, with the pack reference withholding four rejoin lines. That is a one-time footprint of 41 files, decided in `race-engineer-callouts.md`.
- **An interrupting clip fire cuts at equal weight,** unlike an `interrupt` contract, and an admitted stash skips its cooldown on replay (#1698).
- **Driver-name aliases are one hop, with one map for every voice.**
- **Pit-lane cues play directly on the new `Cue` channel,** outside arbitration (#1161, #1272, following #912).

**Deck**
- **"Works without the sim" is opted into per action,** with a default of `true`. Four overrides are each pinned by a test, and the spec rejected deriving it from the comms catalog.
- **Dial screens do not dim yet.** This is out of the spec's scope and filed as #1670 and #1671.
- **The Black Box dial does not take its rotation from an input event's payload,** because the host never echoes the gesture's own `setSettings`.

**Release and process**
- **The voice-pack seal marks a pack released before the tag run publishes it,** the safe direction, and it runs on an `-rc` as well.
- **A stable release now needs Chromium, the native toolchain and the network.**
- **Spec churn is 102 commits over 45 issues** (#1113 alone 15, following the design as it moved). It ran no CI and edited no shipped spec.
- **The local turbo cache is 117 GB.**

## Extensibility

| Change | 2026-11-08 | Now | Why |
| --- | --- | --- | --- |
| New first-party voice pack | Low-moderate | Same, guarded | A stale pack record fails `pnpm test` (#1667) |
| New action | Moderate, linear | Same | One more decision: override `needsSim` if a mode works without the sim |
| Dial on an existing action | Low | Low, held | Black Box Selector's +826 lines stayed on the shared base |
| A feature every key needs | — | **One edit** | The #1599 funnel; dial screens still have 18 draw sites (#1670) |
| New callout in an existing family | Low-moderate | Same | #1688 was data plus a shared readout |
| New callout family | Moderate, fully guarded | **Same, measured** | #1572: no engine file, one `PitCrewDeps` key, one `SimRuntime` member, three registry lines, one `GATED` row, shortcuts, two voice configs |
| New imperative cue | — | Low | #1161 and #1272: one engine file each, no deps key |
| New mixer channel | Low | **Low, proven** | #1161: three code files and no fake edit; only the docs drifted |
| New persistent store | — | Moderate | A third copy of the write discipline today (item 2) |
| New replay mode | Same | Same | The replay stack is byte-identical |
| New deck host | Medium | Same | The disconnected look is composed before `setImage`, so it asks nothing new of an adapter |
| Second sim | Better | **Better** | It gets a slice template, sim-neutral traffic, landmark and sector events, a track identity with a sim field, a sim-neutral landmark learner and the presence signal. Unchanged: the 11 `iracing-sdk` values in the catalog, 26 `SimIRacingAction` subclasses, 11 direct translator getters and the concrete `SDKController`. Slightly worse: catalog casts 12 → 13, catalog files reading raw `TrkLoc` 1 → 3 |

## The process layer

Judgement, not a defect.

- **The follow-up loop stalled.** None of the 7 follow-ups closed in thirteen days, against 11 of 11 last window, while 3.9.0 shipped 23 user-facing items. That is a choice of priority, but #1658 can no longer wait: the floor it guards is 24 characters away and now blocks honest documentation.
- **Growth moved from the hooks to the on-demand documents.** Hook code and workflows were flat. Release scripts grew 11.6%, `CLAUDE.md` files 15%, and the Race Engineer's on-demand instructions 13% (item 4).
- **The spec process cost nothing measurable.** 102 commits ran no CI, and the freeze rule held.
- **Contradictions.** The reviewers found none between rule files beyond the carried-over merge-owner line.

## Follow-ups

Filed or updated with this review, in the order it would take them (new issues through the file-issue skill, on Niklas's approval):

1. **Do [#1658](https://github.com/niklam/iracedeck/issues/1658) first, before any other process change** (item 1). It now has a comment with the 24-character figure, and notes that its moves out must land before anything is added. Moving it into `Next` is Niklas's call.
2. [#1741](https://github.com/niklam/iracedeck/issues/1741): **one set of persisted-file primitives** (item 2). Put preserve-aside, identical-aside, atomic write and the stale-temp sweep in one place, each parameterised by file prefix: in `settings`, the existing common dependency, or a leaf package. Each store keeps its own policy. Give replay-store the unreadable-aside guard, and correct `replay-store/CLAUDE.md`.
3. [#1742](https://github.com/niklam/iracedeck/issues/1742): **one reader each for race progress at the line and for being in the pit stall** (item 3), used by every diff, or a stated exception beside each claim. It is linked to [#1682](https://github.com/niklam/iracedeck/issues/1682), which has the same root in the canonical order.
4. [#1745](https://github.com/niklam/iracedeck/issues/1745): **index the Race Engineer examples file** (item 4), so a task loads an index and reads the entries it needs. Set a size expectation for package `CLAUDE.md` files.
5. [#1743](https://github.com/niklam/iracedeck/issues/1743): **remove the unused public surfaces** (item 5).
   - Delete the audio service's voice-sequence API and its state machine, or record why it is kept.
   - Drop `getPitLaneLandmarks()` from the barrel until a consumer exists, and point the Architecture page and the `CLAUDE.md` at the `SimRuntime` route.
6. [#1744](https://github.com/niklam/iracedeck/issues/1744): **delete the capture-manifest bootstrap** (item 6) and its rule text.
7. **The mixer channel count and the `race-positions.md` sentence**, added to [#1664](https://github.com/niklam/iracedeck/issues/1664) by comment (item 7).

Not proposed: anything new for the six carried-over issues, which stand as filed.
