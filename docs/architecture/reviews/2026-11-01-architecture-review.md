# Architecture review — 2026-11-01

> **Previous:** [2026-10-25](2026-10-25-architecture-review.md) · **Follow-ups:** [#1586](https://github.com/niklam/iracedeck/issues/1586) · [#1587](https://github.com/niklam/iracedeck/issues/1587) · [#1588](https://github.com/niklam/iracedeck/issues/1588) · [#1589](https://github.com/niklam/iracedeck/issues/1589) · [#1590](https://github.com/niklam/iracedeck/issues/1590) · [#1591](https://github.com/niklam/iracedeck/issues/1591) · **Still open from earlier reviews:** [#1374](https://github.com/niklam/iracedeck/issues/1374) · [#1375](https://github.com/niklam/iracedeck/issues/1375) · [#1501](https://github.com/niklam/iracedeck/issues/1501) · [#1504](https://github.com/niklam/iracedeck/issues/1504) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#643](https://github.com/niklam/iracedeck/issues/643)
>
> Point-in-time review of `master` at `5a8d6a64d` (v3.8.0-dev.0; release 3.8.0 complete, not yet released). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

This review covers the seven days and 98 commits since the 2026-10-25 review (`6f9c0882c..5a8d6a64d`). 58 of those commits are spec edits and 40 are code. Together they make up the 3.8.0 release.

**Follow-ups from earlier reviews that merged in this window:**
- [#1499](https://github.com/niklam/iracedeck/issues/1499): the `endsOn` event order.
- [#1500](https://github.com/niklam/iracedeck/issues/1500): the session kind through the sim seam.
- [#1502](https://github.com/niklam/iracedeck/issues/1502): finishing the replay engine extraction.
- [#1503](https://github.com/niklam/iracedeck/issues/1503): the build pins.
- [#1376](https://github.com/niklam/iracedeck/issues/1376), [#1377](https://github.com/niklam/iracedeck/issues/1377), [#1378](https://github.com/niklam/iracedeck/issues/1378) and [#1468](https://github.com/niklam/iracedeck/issues/1468).

**Splits and cleanups:**
- [#1514](https://github.com/niklam/iracedeck/issues/1514) split `ScenarioEngine`, which the previous review called a real god class.
- [#1494](https://github.com/niklam/iracedeck/issues/1494) and [#1495](https://github.com/niklam/iracedeck/issues/1495) removed dead code and the keysender native module.

**Still open:** [#1374](https://github.com/niklam/iracedeck/issues/1374), [#1375](https://github.com/niklam/iracedeck/issues/1375), [#1501](https://github.com/niklam/iracedeck/issues/1501) and [#1504](https://github.com/niklam/iracedeck/issues/1504).

**Features:**
- press sounds (#269);
- the fastest lap of the race and every lap time (#1571);
- Session Info Gaps outside a race (#1515);
- seven driver names (#1579);
- Fuel Service Target Amount on the fuel step (#1483);
- the Ctrl+Alt chat-lock release (#1508);
- a new subsession counting as a session change (#1509).

**Process:**
- the agent team: PO, issue lead and role agents (#1520);
- a judge for declined findings (#1528);
- the file-issue skill (#1547);
- board automation (#1574);
- pre-commit formatting of committed paths only (#1402);
- the CI turbo cache and test shards (#1492).

The method is the one the 2026-10-25 review set down. Five read-only reviewers each took one seam: sim and telemetry; the deck platform; audio and the Race Engineer; cross-cutting build, settings and process; and the replay stack. Each re-ran the previous counts on both trees, which were pinned as extracted copies, using the recorded scripts. Each finding was then checked against the code before it was kept. Deliberate, documented choices are listed under *Trade-offs, not defects*, not ranked. Figures marked **(verified)** were re-measured by the coordinator; the rest come from one reviewer's measurement. Judgements are marked as such.

**God module** means what the previous review defined: a module holding several unrelated responsibilities, or state shared across concerns that have nothing to do with each other. Size alone does not make one.

Line counts are physical lines of non-test `.ts` under `src/` unless stated.

## Verdict

**3.8.0 closed most of the architecture debt the last three reviews carried. Every merged follow-up delivered what its issue asked, and each new guard plants its own failure.**

- **The sim seam.** It is now one declared shape. The Race Engineer reads a declared `SimRuntime` of 23 members (#1378), and the deck host reads a separate 4-member `HostSim` (#1500). Neither widens the other, and both come out of `initSim` alone.
  - Three sim boundaries are lint-guarded with planted positive controls: `deck-core`, the device shells and the catalog.
  - No device shell imports a sim package (verified).
  - No catalog file imports a value from `sim-events-iracing`.
- **The god modules.** `ScenarioEngine` is a 377-line facade over twelve modules with one writer per field (#1514). The translator lost its second job (#1468), and `initSettings` and `initVoicePacks` are 21 and 49 lines (#1377).
- **The drift guards.** Untyped settings casts went from 38 to 0, and a lint rule now refuses them (#1376). Every callout key added since the baseline is guarded. The `endsOn` order is checked for every contract against a tick-order table that a test proves is the code (#1499).

**What needs attention:**

- **The always-loaded instructions are growing at about 1k characters a day.** That includes the two sections #1501, still open, was filed to move out. Headroom fell from 18.4k to 11.1k (verified).
- **The process layer drifted in two places.** An always-loaded rule forbids a review step that the issue-lead skill requires, and the Bash hook module doubled to 2,731 lines with three subsystems in it (verified).
- **One god module remains, by the second clause of the definition.** Every diff function in the translator takes the whole 251-member `TranslatorState`, and the newest family's state went in flat.

## What moved since 2026-10-25

| #   | Previous finding                                         | Status                         | Now                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A device shell knows the sim                             | **Fixed** (#1500)              | `HostSim` handed to `PluginExtension.start(context)`. The tick order is now the translator's after-tick contract, the session-kind unions are checked both ways, and a lint rule with a planted control guards the shells |
| 2   | `ScenarioEngine` god class; `endsOn` order held by prose | **Fixed** (#1514, #1499)       | A 377-line facade over twelve single-concern modules with one writer per field. The `endsOn` check runs every contract against `CONTROLLER_TICK_ORDER`                                              |
| 3   | Always-loaded set regrowing                              | **Worse** (#1501 open)         | 111.6k → 118.9k of 130k (verified, item 1)                                                                                                                                                         |
| 4   | Drift the compiler cannot see                            | **Fixed** (#1376)              | Append-only key baseline, a floor that tracks contracts, one shared translator-options builder, mirrors tied by a test, casts 38 → 0 and lint-refused, harness lists checked                         |
| 5   | #1467's unfinished promises                              | **Fixed** (#1502)              | Six of seven settle loops on `pollUntil` (the seventh is documented), one declaration per speed constant, test hooks off the barrel, a reset-completeness scan and a camera-send guard. Each guard plants its own failure |
| 6   | Test fakes copied by hand                                | **Worse by two** (#1504 open)  | 37 → 39 copies of `createFakeAudio`, both new ones from #1571                                                                                                                                       |
| 7   | Bundled-profile reader duplicated                        | **Unchanged** (#1375)          | Identical copies in `switch-profile.ts:140` and `race-admin-selector.ts:72`                                                                                                                         |
| 8   | Build pins not pinned                                    | **Fixed** (#1503, #1513)       | All 7 `setup-node` steps read `.nvmrc`. The turbo-inputs test pins `MODELLED_TURBO_VERSION` four ways and compares its model against `turbo run --dry=json` both ways                                |
| 9   | Documentation drift                                      | **Partly fixed**               | `architecture.md:316` and the #1351 pointers were corrected; the rest of #1374 is open (item 8)                                                                                                     |
| —   | Translator's second job (#1468); setup phases (#1377)    | **Fixed**                      | Recorders run as their own subscriber with their own state, and all 19 `replay*` members left `TranslatorState`. The two phases are now sequences of named, tested steps                            |

## Baseline figures

The numbers a later review should re-measure. Both columns use the same method.

| Measure | 6f9c0882c | 5a8d6a64d | Method |
| --- | --- | --- | --- |
| Packages / `@iracedeck` edges (dep ∪ dev) / longest chain | 39 / 188 / 7 | 39 / 178 / 7 | `graph.mjs`; −9 shell→sim edges |
| Package cycles | 0 | 0 | DFS, with a positive control |
| `deck-core` lines / files / barrel; sim imports | 6,620 / 32 / 350; 0 | 7,117 / 33 / 357; 0 | git objects; + `press-sounds.ts` |
| Device-shell files importing a sim package (incl. tests) | 1 + 3 | 0 (verified) | grep |
| Sim-boundary lint blocks with planted controls | deck-core, replay-engine | + shells, + catalog | `eslint.config.js` |
| `plugin-runtime` lines / files; files importing a sim package | 2,622 / 21; 10 | 3,172 / 33; 11 | the +1 is a file split (#1377), not a new dependency |
| `initSettings` / `initVoicePacks` / largest step | 445 / 452 / — | 21 / 49 / `buildVoicePackScan` 229 | function span |
| `translator.ts` / `handleTick` / `TranslatorState` members | 3,293 / 734 / 261 | 3,391 / 723 / 251 | `wc -l`; span; members |
| `replay*` members in `TranslatorState` | 19 | 0 | AST |
| Diff signatures typed on the whole `TranslatorState` / narrowed with `Pick<>` | — | 87 lines / 0 (verified) | grep over `diff/` |
| `SimRuntime` members / `HostSim` members | 19 (`typeof`) / — | 23 (declared) / 4 | interface members |
| Catalog files importing a sim package / with a `sim-events-iracing` value import | 14 / 12 | 13 / 0 | import regex |
| Direct `getLatestTelemetry()` calls outside the translator and wiring | 9 files | 1 (`telemetry-control.ts:510`) | grep |
| `SimEventMap` events / keyed by `subSessionId` | 91 / 5 | 92 / 5 | quoted keys |
| `ScenarioEngine` span / methods / fields | 2,647 / 75 / 29 | 377 / 24 / 15 | AST |
| Engine modules / total lines / largest class | 1 / 3,710 / `ScenarioEngine` | 13 / 4,905 / `Scheduler` 738 | `wc -l`; AST |
| `interpreter.ts` | 3,710 | 865 (verified) | `wc -l` |
| `pit-crew/index.ts` / `registerPitCrew` / `PitCrewDeps` | 1,971 / 792 / 30 | 2,098 / 837 / 34 | `wc -l`; AST; +4 from #1378 |
| `calloutEnabled*` keys / baseline rows | 103 / 100 | 105 / 105 | registry vs fixture |
| Contracts / `CATALOG_FLOOR` | 168 / 159 | 170 / 170 | `pack-reference.json`; `bundled-scripts.test.ts:130` |
| Untyped `getGlobalSettings() as Record` (repo) | 38 | 0 (verified) | exact string, non-test |
| Copied `createFakeAudio` fakes / lines | 37 / 1,589 | 39 / 1,649 | AST spans |
| Replay stack lines / test ratio | 23,947 / 1.80 | 24,536 / 2.02 | `measure.cjs` plus the recorder files it missed |
| `replay-engine` barrel names / test hooks on it | 195 / 12 | 90 / 0 | `used.cjs` |
| `pollUntil` callers / hand-polled settle loops | 2 / 7 | 10 / 1 (documented) | grep |
| `walkToLapStart` / replay gate / `replay-control.ts` | 1,007 / 2,598 / 1,599 | 1,018 / 2,621 / 1,617 | AST span; `wc -l` |
| `iracing-actions` non-test lines / files | 47,484 / 138 | 49,621 / 140 | git objects |
| Dial surfaces / `inputContext` copies / verbatim lines shared by ≥9 surfaces | 18 / 18 / 1,807 | 18 / 18 / 1,930 | `dup.mjs` |
| Test files importing another package's `src` | 22 (+2 prod) | 20 (+2 prod) | resolved paths |
| Always-loaded rules + `.claude/CLAUDE.md` | 111,609 ch | **118,923 ch** (verified) of 130,000 | as `claude-rules-frontmatter.test.mjs` measures |
| `.claude/rules` total / largest file | 901,600 B / 270,533 B | 946,578 B / 278,144 B | `git ls-tree -l` |
| `CLAUDE.md` files / bytes; `.claude/skills` bytes; `.claude/agents` bytes | 37 / 603k; 145k; 22k | 37 / 654k; 195k; 13k | `git ls-tree` |
| `rules-bash.mjs` lines / top-level functions | 1,401 / 26 | 2,731 (verified) / 58 | `wc -l`; regex |
| `hook-internals.md` | 9.5k | 22.3k | `wc -c` |
| Commits / `docs(specs)` | 53 / 30 | 98 / 58 | `git log` |
| Master push CI runs on spec-only heads | 0 of 72 | 0 on 58 spec-only commits; 204/204 runs green | `gh run list` |
| Local turbo cache | 97 GB | 103 GB | `du -sh .turbo` |

### Corrections to the earlier reviews

- **"Harness lists: all 91 events have a template, by convention only"** (2026-10-25). Only the shortcut half was convention. `scenario-harness/src/event-names.ts:469` already carried a compile-time, both-ways `_coverageCheck` at `6f9c0882c` (verified).
- **README package count.** The README table has 29 package rows on both trees (verified). The 2026-10-25 correction gave 28 for the tree and table.
- **"The dial still drives the key class"** (2026-10-25, item 5). At `6f9c0882c` it was already a commented, deliberate pass through an object of callbacks (`replay-control.ts:590-593`). It belongs under trade-offs.
- **"The mixer has four channels" as stale** (2026-10-25, item 9). `race-engineer-callout-examples.md:73` is the pattern record for #912, when the mixer had four channels. It is history, not drift.
- **Method notes, not errors:**
  - "11 casts in 7 files" counted lines; by sites it is 12.
  - "Relative reaches 21" used another method; by resolved paths it is 22 tests plus 2 production files.
  - "Shell files importing a sim package: 1" counted production files only; there were also 3 test files.
  - `measure.cjs`'s globs miss `sim-events-iracing/src/replay-recorder*.ts` (495 source lines); later reviews should add them.
  - `GlobalSettingsSchema`'s field count is literal fields plus the spread callout keys (152 = 47 + 105).

## What is good

- **#1500 and #1378 decided the sim seam's shape once.**
  - The Race Engineer reads a declared `SimRuntime` (`race-engineer-wiring/src/sim-runtime.ts`). The host reads a separate `HostSim` (`plugin-runtime/src/types.ts:40-56`). Both are built only in `initSim`.
  - The tick order the Stream Deck extension relies on is the translator's after-tick hook (`translator.ts:340-386`), tested in `translator-tick-listeners.test.ts`, no longer subscriber insertion order.
  - The two session-kind unions are checked both ways (`phases/sim.ts:36-42`).
  - `plugin-shell-sim-boundary.test.mjs` discovers the shells and plants a value import and a type-only import in each.
  - `audio-scenarios-sim-boundary.test.mjs` guards the catalog.
  - The four sim packages are named once (`SIM_PACKAGES`).
- **#1514 is a model split.**
  - The orderings were pinned by tests that fail under inversion before any code moved.
  - It was a pure move: the old tests were kept unchanged and gained 207 and 97 lines.
  - Shared state is one declared `BusTable` with narrow views per module (`engine-types.ts:189`), and each runtime field has one writer.
  - `interpreter-facade.test.ts` fails if the facade gains a field.
  - `scheduler.test.ts` drives arbitration with stubbed playback and expansion.
- **#1468 left the recorder small.** `replay-recorder.ts` is 274 lines with its own state and one publish site. It reads session info once per tick, so in-tick casts went from 9 to 5. `tick-order.test.ts:573` proves the subscription table, with negative controls. It also fixed a real startup loss: `replay.sessionStarted` used to be published before the store subscribed. And it put the #1509 session-identity rule in one place, `session-identity.ts`.
- **#1376 closed a three-review-old issue completely.**
  - Every guard has a positive control or a vacuity check, including `scripts/global-settings-cast-lint.test.mjs`, the append-only baseline with `retiredBy`, `translator-options.test.ts` and `harness-lists.test.ts`.
  - The typed reads surfaced two dead branches.
- **#1502 delivered every task, and went further on camera sends.** Its guard also covers key-binding taps, switches passed through callback objects and the engine's own camera access, with 13 planted-source controls (`camera-switch-waiter.single-policy.test.ts`). The barrel went from 195 names to 90, and the only names on it without a production consumer are types that exported signatures need, guarded by `index.test.ts`.
- **#1499 chose the general check.** `ends-on-order.test.ts` runs every registered `endsOn` contract through `CONTROLLER_TICK_ORDER`, checks it found at least one, and has positive controls for a reversed pair, a missing end event, a same-stage pair and a contract without a trigger.
- **#1503 went beyond its issue.** `turbo-inputs.test.mjs` pins `MODELLED_TURBO_VERSION` against `package.json`, `node_modules`, the dry run and the `$schema` URL. It compares its model with `turbo run build typecheck --dry=json` in both directions. Its dry-run helpers fail rather than skip. `workflow-setup-node.test.mjs` refuses a literal version, a missing `with` or another version file.
- **#1402 reproduces its incident as its own positive control.** `format-staged.test.mjs` runs a real git sandbox: a sibling's save mid-hook under `--only`, a linked worktree, a partially staged file and `core.autocrlf`. `lint-staged` is gone.
- **#269 crossed the deck/audio boundary cleanly.**
  - `deck-core/src/press-sounds.ts` owns the timing and plays through an injected `PressSoundPlayer`, so `deck-core` gained no audio or sim dependency (verified).
  - The player lives in `iracing-actions/src/audio/press-sounds.ts` and reuses the Feedback channel.
  - `plugin-runtime` wraps every handler once. Its `EveryHandlerMember` type makes a future `IDeckActionHandler` member fail to compile until it is forwarded.
  - `press-shape-coverage.test.ts` refuses a missing member.
- **The declarative catalog paid off.** #1571 (a new family plus a callout and a new event) touched no engine module and added no `PitCrewDeps` key. #1579 was data only. `audio-native`, `audio-service` and `callout-script` are byte-identical across the window.
- **#1494 and #1495 were a real cleanup.** The dead barrel and the stray tests are gone, the root devDependencies were trimmed, and with keysender gone `deck-core` has no native dependency.
- **#1466 holds.** No CI run on 58 spec-only commits, and all 204 post-merge runs green.

## Large modules

Sorted by the definition. A large cohesive module is not a finding.

| Module | Size | Responsibilities | Verdict |
| --- | --- | --- | --- |
| `sim-events-iracing` `translator.ts` + `TranslatorState` | 3,391 lines; 251 members | Runs 33 diff stages over one flat state object every stage receives whole | **God module, second clause only.** #1468 removed the unrelated second job; the shared flat state remains (item 2) |
| `scripts/claude-hooks/rules-bash.mjs` | 2,731 lines, 58 functions | The shell lexer and masker; the merge-gate and issue-edit parsers; a recursive interpreter of package scripts | **Becoming a god module** (item 4) |
| `audio-scenarios` `ScenarioEngine` | 377 lines, 24 methods | A facade over twelve modules | **No longer a god class** (#1514) |
| `audio-scenarios` `Scheduler` / `Expansion` | 738 / 568 lines | Arbitration / sequence expansion | Large, one concern each |
| `plugin-runtime` `initSettings` / `initVoicePacks` | 21 / 49 lines | Sequences of named steps | **Fixed** (#1377) |
| `replay-engine` gate / `walkToLapStart` | 2,621 / 1,018 lines | Deciding when a replay command goes out / walking to a lap start | Cohesive. The walk's closure-shared helpers still cannot be tested alone, a testability note |
| `iracing-actions` `fuel-dial-surface.ts`, `camera-dial-surface.ts`, `session-info.ts`, `car-control.ts`, `replay-control.ts` | 2,365 / 1,814 / 1,760 / 1,733 / 1,617 | One action or surface each | Large, cohesive. `fuel-dial-surface.ts` grew 334 lines with the Target Amount monitor (#1483); the fuel stepping itself lives in `fuel-step.ts` |
| `replay-store` `createReplaySessionStore` | 1,050 lines | One store | Cohesive; byte-identical, no section added |
| `audio-scenarios` `registerPitCrew` | 837 lines | The catalog's composition list | Grows by about 25 lines per family, by design |
| `scenario-harness` `scenario-shortcuts.ts` | 4,374 lines | Shortcut data | A data file |

## What is bad, ranked

### 1. The always-loaded instructions grow about 1k characters a day, including the sections #1501 was filed to move — medium (process)

The always-loaded set (the rules with no `paths:` frontmatter, plus `.claude/CLAUDE.md`) went from 111,609 to 118,923 characters in seven days (verified). Headroom against the 130,000 `REPO_BUDGET` fell from 18.4k to 11.1k.

**Growth by commit:**

| Commit | Change | Characters added |
| --- | --- | --- |
| #1574 | board mechanics | +1,745 |
| #1492 | the "CI keeps turbo's cache" paragraph (`build-and-commit.md:55`) | +1,156 |
| #1520 | the agent team | +1,062 |
| #1532 | QA agents test dev tooling | +824 |
| #1503 | the build pins | +723 |
| #1513 | release CI | +648 |
| #1547 | the file-issue skill | +432 |
| #1402 | pre-commit formatting | +412 |

**#1501's own two target sections grew from 2,186 to 3,557 characters:**
- "Turbo task inputs" went from 1,206 to 2,282.
- The Node worker-crash section in `testing.md` went from 980 to 1,275.

Part of that came from #1503, the fix for the previous review's item 8.

At this rate the budget test fails in about ten days. The test fails only at the edge and gives no warning before it. Each of the paragraphs above matters only when touching particular files: workflows, `turbo.json`, `lib.mjs` and the board helpers, or `vitest.config.ts`. So each can be path-scoped, as #1465 did for the merge gate.

### 2. `TranslatorState` is still state shared across unrelated concerns — low-medium

#1468 removed the translator's unrelated second job, so the first clause of the definition no longer applies. The second still does:

- **Every diff function takes the whole state.** All diff-function signatures in `sim-events-iracing/src/diff/` take the whole 251-member `TranslatorState` (87 signature lines), and none narrows it (verified). So the caution, fuel, gap, overtake and fastest-lap modules can each read and write each other's state.
- **Feature growth resumed straight after the split.** In the same window five features added 205 lines to `translator.ts`, more than the 107 #1468 removed.
- **The two newest families took opposite shapes.**
  - #1571 added six flat `fastestLap*` members (`state.ts:1376-1415`, verified).
  - #1515 added one nested slice, `trackGaps: TrackGapsState` (`state.ts:1301`), the same shape `ReplayRecorderState` has.

Judgement: this does not need a split. It needs a convention, stated where a new diff module is written: a new state cluster arrives as a nested slice, and a diff function takes its slice. Moving `fastestLap*` into one would be the first application.

### 3. An always-loaded rule forbids a review step the issue-lead skill requires — low-medium (process)

- **The rule.** `code-review.md:59` (always loaded) gives a branch "exactly one full read" and says "do not run a second full-branch reviewer beside it", naming the second read as the only exception (verified). `.claude/CLAUDE.md` repeats it.
- **The skill.** `skills/issue-lead/SKILL.md:67` makes the CodeRabbit CLI review "on the final branch, after every fix commit" (`coderabbit review --agent --committed --base master`) a step of every issue, with its declines going to the #1528 judge (verified).
- **The conflict.** No rule file names the CLI review. So a session that follows the rules, and is not running the skill, is told not to do what the skill does.

### 4. `rules-bash.mjs` doubled in a week and now holds three subsystems — low-medium

It went from 1,401 to 2,731 lines and from 26 to 58 functions (verified), almost all from #1520 (+549) and #1526 (+733). It now holds three things:

- **The shell lexer and masker** that every rule reads through (`:1-560`).
- **The merge-gate and issue-edit parsers** (`:565-1050`).
- **A recursive interpreter of package scripts** (`pnpmRuns`, `npmRuns`, `rollupRuns`, `turboRuns`, `nodeRuns`, `wrapperRuns`, `powershellRuns`, `deckFindings`, at `:1715-2329`, verified). It follows six runners and four shell-wrapper languages up to depth 8, and serves one *ask* rule: the deck-host restart guard.

`hook-internals.md` went from 9.5k to 22.3k, mostly to describe that interpreter. By the definition this is becoming a god module: the lexer is infrastructure, the parsers serve specific denies, and the interpreter is a subsystem of its own. The repo already extracted the same kind of thing once, as `coderabbit-summary.mjs`.

Judgement: about 1,000 lines now guard one prompt. That is worth weighing before the interpreter grows further, and an extraction would make the weight visible.

### 5. The catalog still classifies session types against a comment-only mirror — low-medium

- **A private original and a comment-only mirror.** `audio-scenarios/.../race-start.ts:251` `classifySessionType` "mirrors the translator's own `classifySessionType` … which must stay in agreement" (`:244-246`, verified). The translator's copy (`translator.ts:3090`) is module-private, so no test can compare the two.
- **Raw iRacing strings in the catalog.** `radar-engine.ts:187` and `spotter-engine.ts` string-match `"Lone Qualify"` on `deps.getSessionType()`.
- **Nothing tracks it.** The 2026-10-25 review raised the mirror (item 1), but #1500 did not task the catalog side, and no issue carries it.

With a declared `SimRuntime`, the classified kind can now be a member, as `HostSim.getSessionKind` already is for the host.

### 6. Press sounds added another copied pair to the dial family — low-medium

#269 put its logic in shared functions (`dialGestureShape` / `touchGestureShape` in `shared/dial-release.ts`), a shared test suite and a coverage test. But it also added near-identical `pressShape` / `touchShape` methods to 17 of the 18 dial surfaces (verified), 13 of them opening with the same `contextsState.has` guard. 21 action files gained delegating members too.

The dial surfaces gained 713 lines in total, and the verbatim lines shared by nine or more surfaces went from 1,807 to 1,930. This is the dial family's missing base, recorded since the 2026-10-09 review, now measured on a second cross-cutting feature: each one costs about 18 copies.

### 7. Four small drifts — low

Each is verified and narrow.

- **The family-coverage table has no completeness check.** `GATED` in `catalog/pit-crew/callout-settings-coverage.test.ts:94-128` is a hand-kept row per `SCENARIO_ID_TO_*` map. It is what proves every contract id resolves to a registry key. All 29 maps are present today, and #1571 remembered its row. But nothing compares the rows with the exported map names, so a family that forgets its row goes unchecked.
- **One `PitCrewDeps` key now serves two families under one family's name.** `getOpponentPitLivePosition` and `getOpponentFlagLivePosition` are both bound to `resolvePendingCarLivePosition` (`pit-crew-deps.ts:156,159`). #1571 handed the opponent-flag key to the fastest-lap family so it would add no key (`index.ts:1722-1730`, verified). A test or harness override of the opponent-flag read now silently changes the fastest-lap holder line. Already tracked as [#1577](https://github.com/niklam/iracedeck/issues/1577), filed from #1571's own review.
- **The replay record's key is read under two contracts.** `WeekendInfo.SubSessionID` is read in four places:
  - Three accept a number or a numeric string: `replay-engine/src/fastest-lap-press.ts:78`, `replay-markers-ops.ts:133`, and the store's opener in `deck-iracing/src/replay-session-subscriber.ts:23,54`.
  - The fourth, `sim-events-iracing/src/diff/replay-record-gate.ts:149`, accepts numbers only and returns `null` (verified). It is the reader that stamps every `replay.*` event.

  If the value ever arrived as a string, the store would open the session while the recorder stamped 0, and nothing would be recorded. There is no live bug, because `yaml` parses the unquoted integer as a number, but nothing ties the writer's reader to the opener's.
- **A topic rule describes the recorder as it was before #1468.** `race-engineer-callouts.md:284` still lists `diffReplayLaps` among the "pre-guard emissions" in `translator.ts` (verified), but the translator no longer calls any `diffReplay*` function. The rule loads for `packages/sim-events-iracing/**`, so it is read exactly when someone adds a recorder. Seven comments in `replay-store` and `replay-engine` still credit the `replay.*` events to "the translator".

### 8. Documentation drift — low (#1374, #1375)

- **Still open in #1374:**
  - `architecture.md:6` ("nothing else changes").
  - `architecture.md:490`: "15 action files call `getCommands()`", against 10 that import it.
  - The Mermaid graph without `audio-scenarios → iracing-sdk` (7 production importers). The "omitted edges" sentence at `:477` does not name that edge either. The graph also lacks `iracing-actions → iracing-sdk` / `→ audio-service` and `plugin-runtime → callout-script` / `→ iracing-native`.
  - `audio-assets` in the "Foundation — no internal deps" box (`:362`), although it declares three.
  - `translator.ts:6-7` ("the only package allowed to import `@iracedeck/iracing-sdk`").
  - `deck-core/src/index.ts:103`.
  - `audio-scenarios/CLAUDE.md:41` (`position-range.ts`).
  - "Replay busy marks" in `icon-composer`.
  - The README: 33 and 32 actions against 35 classes, and a package table missing the audio stack, `event-bus` and `sim-events-iracing`.
- **Still open in #1375:**
  - The `deck-core` sim-boundary lint block still uses `paths` only and misses `settings` and `voice-packs`. It is now inconsistent with the new shell block, which also closes subpaths (`eslint.config.js:135-155` against `:209-226`).
  - There is no alias-completeness test, and 20 test files still reach into another package's `src`.
  - The `pi-components` reverse read, the `audio-assets` → `callout-script` devDependency, the twin loggers, the three copied plugin turbo blocks and `fake-sim-connection.ts` in `dist`.
  - The duplicated profile reader (item 7 of the previous review).
  - New this window: `iracing-plugin-stream-deck/src/shared/svg.d.ts` duplicates `src/svg.d.ts` in the same program, left behind by #1494 (verified).

## Trade-offs, not defects

Raised during the review, checked, and kept out of the ranking because each is a deliberate, documented choice.

- **The replay dial runs the keypad's Jump to Live and Race Start through an object of callbacks** (`replay-control.ts:590-595`, commented).
- **A translator throw skips that tick's recorder.** Documented at `replay-recorder.ts:44-45` and tracked in #1558. Before #1468 a throw skipped the recorders inside `handleTick` too.
- **The translator and the recorder read the replay state separately.** They can differ for one tick at the end of the exit grace, which `replay-recorder.ts:32-43` documents. Each also keeps its own baseline for the one session-identity rule.
- **`replay-engine/testing` ships in `dist` and imports vitest.** A test refuses any production import of it (`index.test.ts:95`).
- **iRacing's Ctrl+Alt chat-lock release lives in sim-neutral `deck-core`.** It is documented as deliberate, so that direct `getKeyboard()` callers are covered (`keyboard-shortcuts.md`, `deck-core/CLAUDE.md`). If a second sim arrives, it should become an injected delegate, like the focuser.
- **Deck feedback audio lives in `iracing-actions/src/audio`** (press sounds, the volume tick, previews). That directory imports no sim package, and the placement is documented in each module header.
- **Press sounds and the volume tick share the Feedback channel,** so one can replace the other; documented.
- **Press-shape coverage reads only the Elgato manifest.** No other host declares a dial for an action that lacks a shape.
- **Engine modules import public types from the facade,** type-only, as `audio-scenarios/CLAUDE.md` describes. The split also made the engine 32% longer, mostly in headers and interfaces.
- **`CATALOG_FLOOR` is a floor, not an exact count;** the reasoning is at `bundled-scripts.test.ts:118-129`. The pause-mark rule (#1518) grandfathers existing text in a list that only shrinks.
- **Actions read 11 translator getters directly** (#1515 added `getTrackGaps`). The #1515 and #1378 specs record this as the next leak, listed on #714.
- **The catalog's lint block allows `iracing-sdk` helpers,** on purpose (#1378 spec). It could allow-list the helper names rather than the package.
- **`HostSim.getRawSessionType`** is iRacing's raw string, documented as diagnostics only. `fastestLap.set` carries a `carIdx`, as ten events already did, under a pairing rule written for every translator.
- **The plugins declare workspace dependencies their shells do not import** (7 / 10 / 10), possibly for native externals or build ordering. #1375 already says to check each.
- **Skills restate rule text** as operational checklists that cite the owning rule. They are consistent apart from item 3.
- **Skills and agents sit outside the budget test,** correctly: they load on demand.
- **Spec churn** is 59% of commits but costs no CI. **The local turbo cache** is 103 GB and unpruned; turbo does not evict it.

## Extensibility

| Change | 2026-10-25 | Now | Why |
| --- | --- | --- | --- |
| New first-party voice pack | Low-moderate | Same | Parity-guarded scripts, a floor per voice, the pause-mark rule from day one |
| Third-party voice pack | Low, by design | Same | Unchanged |
| New action | Moderate, linear | Same | A key with a long press also declares `keyPressShape`, which the coverage test enforces |
| Dial on an existing action | Low | Low-moderate | Two more press-shape members per action and per surface, copied, though guarded and backed by shared tests (item 6) |
| New Elgato-only feature | Low | Low, cleaner | A new sim need is a `HostSim` member; lint refuses a shell import |
| New callout in an existing family | Low-moderate | Same | Every hand list now fails loudly except `GATED`; the `endsOn` order is checked automatically |
| New callout family | Moderate-high | **Moderate** | #1571 needed no engine file and no deps key, and every list but `GATED` is guarded |
| New mixer channel | Low | Same | Two enums and `IRD_MAX_CHANNELS`, plus 39 copied fakes (#1504). #269 showed reusing a channel often beats adding one |
| New replay mode | Low-moderate | Same | The engine's surface is narrow (90 names) and its conventions are guarded |
| New deck host | Medium | Medium, slightly better | Press sounds and the shell sim boundary come free; the adapter seam is unchanged |
| Second sim | High, about the same | **Better** | A second sim swaps `initSim`'s two declared surfaces, a translator that must pass one ordered `endsOn` check, and an optional recorder, and edits no device shell. Unchanged: iRacing payload types and 7 `iracing-sdk` helper files in the catalog, 12 casts, 26 `SimIRacingAction` subclasses, 11 `getCommands()` files, 11 direct translator getters in actions, and the flat `TranslatorState` |

## The process layer

Judgement, not a defect.

- **Most follow-ups landed.** Eight follow-ups from earlier reviews merged in this window, plus #1514, #1494 and #1495, each meeting its stated goal with guards that plant their own failure. The cheapest one, #1501, did not, and the same window grew its target (item 1).
- **The agent team's weight is mostly on demand.** It put its weight in on-demand skills (+49k) and shrank the agents (22k → 13k). Its always-loaded cost was about 4.7k, plus about 2.9k from CI and build documentation.
- **Contradictions.** Across `po`, `issue-lead`, `issue-workflow`, `build-and-commit`, `code-review` and `hooks`, the reviewers found one contradiction (item 3). The rule index in `.claude/CLAUDE.md` matches `.claude/rules/` exactly, and every Bash rule has a `hooks.md` row.
- **Process code is concentrating in the hook layer.** It is the part of the repo now growing fastest in code (item 4).

## Follow-ups

Filed or updated with this review, in the order it would take them (new issues through the file-issue skill, on Niklas's approval):

1. [#1501](https://github.com/niklam/iracedeck/issues/1501), widened by comment (item 1). Add the CI-cache paragraph (`build-and-commit.md:55`) and the lane-transition mechanics of "The board" to the sections it path-scopes. Consider having the budget test fail at a margin (for example under 10k headroom), so regrowth is caught before the edge.
2. [#1586](https://github.com/niklam/iracedeck/issues/1586): **settle the CodeRabbit CLI step** (item 3). Either name it in `code-review.md` as a second, cheap exception and say why it does not duplicate the full read, or drop it from the issue-lead skill.
3. [#1587](https://github.com/niklam/iracedeck/issues/1587): **give the catalog a classified session kind** (item 5). Add a `SimRuntime` member, retire the catalog's comment-only mirror of the translator's classifier, and remove the raw `"Lone Qualify"` matching in radar and spotter.
4. [#1588](https://github.com/niklam/iracedeck/issues/1588): **a state-slice convention for the translator** (item 2). State it in `sim-events-iracing/CLAUDE.md`: a new cluster is a nested slice, and a diff takes its slice. Then move `fastestLap*` into one as the first application.
5. [#1589](https://github.com/niklam/iracedeck/issues/1589): **a shared dial-surface base** (item 6). Move the context lifecycle, the `inputContext` wrapper and the press-shape members into one place, so the next cross-cutting dial feature is one edit instead of 18.
6. [#1590](https://github.com/niklam/iracedeck/issues/1590): **extract the package-script resolver from `rules-bash.mjs`** (item 4) into a pure, injected module with its own tests, the way `coderabbit-summary.mjs` was.
7. [#1591](https://github.com/niklam/iracedeck/issues/1591): **close the small drifts** (item 7): a completeness assertion for `GATED`, one `SubSessionID` reader contract, and `race-engineer-callouts.md:284` plus the seven recorder comments corrected. The shared live-position key was already tracked as [#1577](https://github.com/niklam/iracedeck/issues/1577).
8. **This review's additions, recorded as comments on the open issues:**
   - #1374: `architecture.md:362` and `:477`, and the README table.
   - #1375: the lint-block inconsistency and the duplicate `svg.d.ts`.
   - #1504: 39 copies now.

Not proposed: splitting `walkToLapStart` (cohesive, and splitting it carries risk), and any further engine work (#1514 just landed, and no feature has tested the split yet).
