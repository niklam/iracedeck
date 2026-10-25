# Architecture review — 2026-10-25

> **Previous:** [2026-10-20](2026-10-20-architecture-review.md) · **Follow-ups:** [#1499](https://github.com/niklam/iracedeck/issues/1499) · [#1500](https://github.com/niklam/iracedeck/issues/1500) · [#1501](https://github.com/niklam/iracedeck/issues/1501) · [#1502](https://github.com/niklam/iracedeck/issues/1502) · [#1503](https://github.com/niklam/iracedeck/issues/1503) · [#1504](https://github.com/niklam/iracedeck/issues/1504) · **Still open from earlier reviews:** [#1374](https://github.com/niklam/iracedeck/issues/1374) · [#1375](https://github.com/niklam/iracedeck/issues/1375) · [#1376](https://github.com/niklam/iracedeck/issues/1376) · [#1377](https://github.com/niklam/iracedeck/issues/1377) · [#1378](https://github.com/niklam/iracedeck/issues/1378) · [#1468](https://github.com/niklam/iracedeck/issues/1468) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#643](https://github.com/niklam/iracedeck/issues/643)
>
> Point-in-time review of `master` at `6f9c0882c` (v3.7.0-dev.0). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

This review covers the five days and 53 commits since the 2026-10-20 review (`41f815395..6f9c0882c`). 30 of those commits are spec edits and 23 are code.

Four of the earlier follow-ups have merged:
- [#1465](https://github.com/niklam/iracedeck/issues/1465): the always-loaded instructions budget.
- [#1466](https://github.com/niklam/iracedeck/issues/1466): no CI on spec-only pushes.
- [#1467](https://github.com/niklam/iracedeck/issues/1467): the replay engine extracted into its own package.
- [#1373](https://github.com/niklam/iracedeck/issues/1373), filed by the 2026-10-09 review: native addons now fail loudly.

[#1468](https://github.com/niklam/iracedeck/issues/1468) is the one follow-up from 2026-10-20 still open.

The rest of the window was feature work:
- automatic Stream Deck profile switching by session kind (#1111);
- Car Control Wipers and Visor (#1463), the Starter flash (#1438), FFB Strength on the dial (#1451) and the Fuel Service fuel grid (#1314);
- the volume step tick and paired volume key styles (#1455);
- Replay Markers' delete window (#1454), the replay dial's car modes (#1448), and car and camera keys waiting for a jump (#1428);
- the limiter-dropped warning ending at pit exit (#1407);
- every build input declared to turbo (#1491), and the Node 24.21.0 pin (#1444).

The method is the same as last time. Five read-only reviewers each took one seam: sim and telemetry; the deck platform; audio and the Race Engineer; cross-cutting build, settings and process; and the replay stack. Each re-ran the previous review's counts on both trees, using the scripts recorded last round. Both trees were pinned as extracted copies, so `master` moving could not skew them.

The coordinator then did three things:
- re-measured the figures the conclusions rest on;
- settled the one place where reviewers disagreed (the README count, see *Corrections*);
- checked every finding against the code, dropping the ones that turned out to be deliberate, documented choices. Those are listed under *Trade-offs, not defects*, so the reasoning is on record.

Figures marked **(verified)** were re-measured by the coordinator; the rest come from one reviewer's measurement. Judgements are marked as such.

**What this review calls a god module.** A module that holds several unrelated responsibilities, or state shared across concerns that have nothing to do with each other. Size alone does not make one. The earlier reviews used the term for any large, growing file; *Large modules* below sorts the large files by this definition.

Line counts are physical lines of non-test `.ts` under `src/` unless stated.

## Verdict

**The review loop worked. Every follow-up taken up met its goal, and the replay engine split is the cleanest package extraction yet.**

- **Replay engine.** `replay-control.ts` went from 3,835 to 1,599 lines (verified). The engine sits behind a lint boundary with a positive-control test. Its alias, Architecture-page edges, README row and `CLAUDE.md` all arrived in the same change, which none of the earlier splits managed.
- **Always-loaded budget.** It went from 1.1k to 18.4k characters of headroom (verified).
- **CI on spec-only pushes.** Zero CI runs have started on a spec-only push since #1466 merged (verified).
- **Native addons.** A failed load is now logged, raises a banner, and reads as disconnected rather than serving fake telemetry.

**Three things need attention:**

- **A device shell now knows the sim.** It is the first one to: the Stream Deck plugin reads the session kind for #1111, and `plugin-runtime` files that know the sim went from 8 to 10. The order this depends on is promised only by a comment.
- **The Race Engineer engine (`ScenarioEngine`) is a genuine god class, and it grew by a feature.** The fix that grew it relies on an event order between two packages that only prose states.
- **The drift issues have not moved.** None of #1374, #1375 or #1376 moved, for the third review running. The always-loaded set has started growing again, by the same pattern #1465 removed.

## What moved since 2026-10-20

| #   | Previous finding                                  | Status                       | Now                                                                                                                                                                                                       |
| --- | ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Replay engine inside `iracing-actions`            | **Mostly fixed** (#1467)     | Own package, with a guarded boundary. One leave-replay event, one camera-switch policy, one telemetry path, one speed view. Still open: the shared settle helper the spec promised, and the dial still calling the key's `executeMode` (item 5) |
| 2   | Always-loaded instructions near the budget        | **Fixed** (#1465), regrowing | 128.9k → 111.6k of 130k (verified); back up 3.5k since the merge (item 3)                                                                                                                                |
| 3   | "God modules absorbing features"                  | **Reclassified**             | By the definition above, two of the files listed are god modules: the translator with `TranslatorState`, which did not grow (+19 lines), and `ScenarioEngine`, which did (item 2). The rest are large but cohesive (*Large modules*) |
| 4   | Sim seam above the deck layer                     | **Slightly worse**           | `plugin-runtime` files that know the sim went 8 → 10, and a host shell imports two sim packages (item 1). `SimRuntime` (19), the catalog files (14) and the casts (11) are unchanged                     |
| 5   | Spec churn dominates `master`                     | **Fixed** (#1466)            | 0 CI runs on 29 spec-only pushes (verified). Spec commits are 57% of the window; no issue had more than 5                                                                                                |
| 6   | Drift no compiler sees                            | **Unchanged, casts worse**   | All #1376 bullets still open; untyped settings casts went 17 → 19 (verified, item 4)                                                                                                                     |
| 7   | Callout family cost                               | **Unchanged**                | `pit-crew/index.ts` is byte-identical. #1407's `endsOn` is the first lifecycle rule a contract declares instead of code                                                                                  |
| 8   | Dial family without a base                        | **Unchanged**                | 18 `inputContext` copies, about 14% verbatim lines; relative `dial-gesture` reaches 13 → 14                                                                                                              |
| 9   | Silent native mock fallback                       | **Fixed** (#1373)            | `loadNativeAddon` returns `native` / `mock` / `load-failed`; `initCore` logs `ERROR NativeAddons:`, and settings shows a banner                                                                           |
| 10  | Merge gate parses a third-party format            | **Unchanged in code**        | Its prose moved out of the always-loaded set (the table cell went from 2,532 to 590 bytes)                                                                                                               |
| 11  | Documentation and hygiene                         | **Unchanged**                | Only the two `.claude/CLAUDE.md` counts were fixed, by #1465's rewrite. The rest of #1374 and #1375 is open (item 9)                                                                                     |

## Baseline figures

The numbers a later review should re-measure. Both columns use the same method.

| Measure | 41f815395 | 6f9c0882c | Method |
| --- | --- | --- | --- |
| Packages / `@iracedeck` edges (dep ∪ dev) / longest chain | 38 / 180 / 7 | 39 / 188 / 7 | `graph.mjs` |
| Package cycles | 0 | 0 | DFS, with a positive control |
| `deck-core` lines / files / barrel; sim imports | 6,579 / 32 / 347; 0 | 6,620 / 32 / 350; 0 | git objects |
| `plugin.ts` Stream Deck / Mirabox / Ulanzi | 22 / 23 / 24 | 22 / 23 / 24 | `wc -l` |
| Host-shell files importing a sim package | 0 | 1 (verified) | `elgato-extension.ts:14,18` |
| `plugin-runtime` lines / files; files importing a sim package | 2,421 / 19; 8 | 2,622 / 21; 10 | + `native-addons.ts` (type-only), `phases/replay.ts` |
| `initSettings` / `initVoicePacks` / `initCore` | 472 / 452 / 75 | 445 / 452 / 101 | first line to the first column-0 `}` |
| `iracing-actions` non-test lines / files | 54,012 / 146 | 47,484 / 138 | git objects |
| Replay stack lines / test ratio | 21,338 / 1.71 | 23,947 / 1.80 | `measure.cjs`, plus `replay-engine` and the `plugin-runtime` replay files |
| `replay-engine` lines / files; barrel names | — | 11,132 / 31; 195 names, 12 of them `_reset`/`_configure` test hooks (verified) | same; `index.ts` |
| `replay-control.ts` / `executeMode` | 3,835 / 468 | 1,599 (verified) / 330 | `wc -l`; AST |
| `walkToLapStart` | 803 (in the class) | 1,007 (`lap-walk.ts:609-1615`) | AST span |
| Replay command gate lines | 2,591 | 2,598 (verified) | `wc -l` |
| Replay stack module `let`s / reset + configure hooks | 36 / 11 | 40 / 14 | `measure.cjs`; regex |
| `translator.ts` / `handleTick` / `TranslatorState` members | 3,274 / 734 / 261 | 3,293 / 734 / 261 | `wc -l`; span; members |
| `event-bus` / `iracing-sdk` / `track-data` sources | — | byte-identical | `diff -r` |
| `SimRuntime` getters; catalog files importing a sim package; unchecked casts | 19; 14; 11 in 7 | 19; 14; 11 in 7 | unchanged files |
| `SimEventMap` events / keyed by `subSessionId` | 91 / 5 | 91 / 5 | quoted keys (see *Corrections*) |
| Session-type classifiers | 3 | 4 | + `classifySessionKind` (`session-kind.ts`) |
| `interpreter.ts` / `ScenarioEngine` span / methods | 3,300 / 2,337 / 71 | 3,710 (verified) / 2,647 / 75 | `wc -l`; AST |
| `pit-crew/index.ts` / `registerPitCrew` / `PitCrewDeps` | 1,971 / 792 / 30 | 1,971 / 792 / 30 | byte-identical |
| `calloutEnabled*` keys / frozen fixture | 103 / 100 | 103 / 100 | registry vs fixture |
| `GlobalSettingsSchema` fields | 143 | 149 | AST; the +6 are #1111 profile keys |
| Contracts / `CATALOG_FLOOR` | 168 / 159 | 168 / 159 | `pack-reference.json`; `bundled-scripts.test.ts:123` |
| `scenario-shortcuts.ts` / entries | 4,100 / 226 | 4,205 / 228 | `wc -l`; AST |
| Mixer channels (`IRD_MAX_CHANNELS`) | 4 | 5 (verified) | `addon.cc:148` |
| Hand-copied `createFakeAudio` fakes / lines | 36 / 1,523 | 37 / 1,589 | AST spans |
| Untyped `getGlobalSettings() as Record` (repo / `plugin-runtime`) | 38 / 13 | 38 / 15 | exact string; the two moved in from `iracing-actions` |
| `car-control.ts` / largest `iracing-actions` file | 1,286 / `replay-control.ts` 3,835 | 1,683 (verified) / `fuel-dial-surface.ts` 2,031 | `wc -l` |
| Dial surfaces / `inputContext` copies / verbatim shared lines | 18 / 18 / 1,808 | 18 / 18 / 1,807 | `dup.mjs` |
| Test files importing another package's `src` | 20 | 21 | resolved paths |
| `_reset*` hooks / module-level nullable `let`s (repo) | 40 / 78 | 45 / 79 | regex |
| Vitest alias entries / packages aliased | 24 / 23 | 26 / 24 | `vitest.config.ts` |
| Always-loaded rules + `.claude/CLAUDE.md` | 128,889 ch | **111,609 ch** (verified) of 130,000 | as `claude-rules-frontmatter.test.mjs` measures |
| `.claude/CLAUDE.md` chars / longest package bullet | 14,565 / 1,982 | 5,694 / ~360 | `^- \`@iracedeck/` lines |
| `.claude/rules` total / largest file | 876,640 B / 267,954 B | 901,600 B / 270,533 B | `wc -c` |
| `CLAUDE.md` files / bytes | 30 / 565,932 | 37 / 603,282 | `git ls-tree` |
| Commits / `docs(specs)` | 195 / 159 | 53 / 30 | `git log` |
| Master push CI runs on a spec-only head since #1466 | — | 0 of 72 (verified) | `gh run list` |
| Local turbo cache | 94 GB | 97 GB | `du -sh .turbo` |

### Corrections to the earlier reviews

- **"God modules".** The 2026-10-09 and 2026-10-20 reviews filed every large, growing file under that label. By the definition above, the replay gate, `replay-control.ts`, `scenario-shortcuts.ts` and `createReplaySessionStore` are large but cohesive. Their size was never the defect. The defect in `replay-control.ts` was where the replay domain logic lived, and #1467 fixed that.
- **"90 catalog events" (and "84" at `3d8cc28b9`).** These are 91 and 85. The old pattern matched letters and dots only, so it dropped `carControl.p2pToggled` (`event-catalog.ts:723`).
- **"All 78 bus events have an `EVENT_TEMPLATES` entry".** It is 91, and all 91 have one; 78 counted single-line keys only.
- **"README lists 29 of 38 packages".** Both counts are right by their own method. 28 packages are in the structure tree and table; `audio-assets` appears only in prose paths, which the 2026-10-20 count included.
- **"Mirabox and Ulanzi loggers differ in 6 code lines".** A plain `diff` shows 44 changed lines, comments and log prefixes included. The files have not changed since.
- **Replay figures: method notes, not errors.** With `*.test-support.ts` counted as source, the previous `shared/replay-*` and `replay-control/` figures are 5,314 and 9,381. "16 mutable containers" excludes constant `Set`s and memo `WeakMap`s (27 raw). "18 timer call sites" excludes the clears (31 with them). "60 files importing `iracing-sdk`" includes test-support files (57 production).
- **`getCommands()` action files.** "11 → 11" hid a change: one of the 11 was the replay gate, which moved to `replay-engine`. HEAD has 10 production files.
- **The extraction was not a pure move.** #1467 took the replay stack from 21,338 to 22,643 lines. The 1,305 added lines are the env, the leave-replay event, the reset hooks, `testing` and the phase.

## What is good

- **#1467 is the model for a package split.**
  - **Guards and docs in the same change:** the alias (`vitest.config.ts:67-68`), a reverse lint rule with a positive-control test (`scripts/replay-engine-boundary.test.mjs`), the Architecture page's prose and edges, the README row, a `.claude/CLAUDE.md` bullet, its own `CLAUDE.md`, and a `/testing` subpath rather than relative reaches.
  - **Clean imports:** the engine imports only `iracing-sdk`, `logger`, `replay-store` and `app-constants` (verified).
  - **Fails loudly when misconfigured:** an unconfigured engine throws (`replay-engine-env.ts:85-95`).
  - **Paid off at once:** #1428 put 1,027 lines in the engine and 296 in actions, and #1448 and #1454 touched no engine file at all.
- **The previous review's replay findings were mostly closed.**
  - **Leaving the replay** is one event (`replay-left.ts`) with five subscribers.
  - **Camera switches** from the key, the dial, Camera Controls and Race Admin all go through one `requestCameraSwitch` (`camera-switch-waiter.ts:332`).
  - **Reads and time:** telemetry goes through `engineReads()`, time through `engine-clock.ts`, and speed through one view (`shownReplaySpeed`).
  - **Composition root:** the loggers are set there, and the store's bus wiring moved out of `initSettings` into `phases/replay.ts`.
- **#1373 is a model fix.** `loadNativeAddon` is pure and injectable, so the failed path is unit-tested without un-mocking the suite. A failed load reads as disconnected, not fake. One wording module in `plugin-runtime` covers the log, the banner and the snapshot. It added no workspace edge: the status union is duplicated deliberately, with a comment saying so.
- **#1465 and #1466 hit their stated goals.**
  - **#1465:** 21.9k characters of headroom at merge and 18.4k now, against a 15k goal. The package list is an index (no bullet over about 360 characters). The mechanics live in path-scoped `hook-internals.md` and `changelog-internals.md`. The budget test now logs the remaining headroom.
  - **#1466:** zero CI runs on 29 spec-only heads. It also left one control-byte class where there had been two.
- **#1491 fixed real stale-cache bugs.** `audio-assets#build` now hashes `sfx/`, `catalog/` and the manifests, and `tsconfig.base.json` is a global dependency. Every check in `turbo-inputs.test.mjs` has a positive control and a floor, and its header lists its own blind spots.
- **The core held still.**
  - `event-bus`, `iracing-sdk` and `track-data` are byte-identical across 53 commits, and `deck-iracing` changed only comments.
  - `deck-core` changed by 41 lines.
  - #1463, #1438, #1451, #1314 and #1407 added no catalog event, no `SimRuntime` getter and no catalog sim import.
- **`endsOn` (#1407) is the declarative shape the earlier reviews asked for.**
  - A contract declares when its line ends.
  - It is validated, and published in the pack reference.
  - It is covered by an 816-line engine test and by a harness test of what is actually heard.
  - It reused `pitLane.exited`, so it needed no bus, translator or wiring change.
- **#1111's reactor is pure and injected** (`session-profile-reactor.ts`, with a 449-line test). An unknown session type returns null, so the deck never switches on a guess. `IDeckPlatformAdapter` was not widened, and `plugin-runtime` was not touched.
- **The new features reuse code rather than copying it:**
  - the volume keys reuse the adjust-style catalog through an svg-free leaf;
  - `race-position-cycling.ts` moved to `shared/` and reads the canonical live order;
  - `ffb-readout.ts` is shared by the dial and the keypad;
  - `fuel-step.ts` takes an injected host;
  - a new mixer channel is two enum entries plus `IRD_MAX_CHANNELS`, with a type-level test tying the two enum copies.

## Large modules

The ten or so largest modules, sorted by the definition in *Scope and method*. A large cohesive module is not a finding. Where a narrower point applies, it is stated.

| Module | Size | Responsibilities | Verdict |
| --- | --- | --- | --- |
| `sim-events-iracing` `translator.ts` + `TranslatorState` | 3,293 lines; 261 members | Orchestrates 35 diff modules over one flat state object they all share, and also records replay data for `replay-store` | **God module.** It did not grow in this window (+19 lines, for #1111). The recorder half is #1468 |
| `audio-scenarios` `ScenarioEngine` | 2,647 lines, 75 methods | Registration, vocabulary, compilation, arbitration and playback | **God class**, and it grew by an engine feature (item 2) |
| `plugin-runtime` `initSettings` / `initVoicePacks` | 445 / 452 lines, one function each | Several startup concerns in one body (store, banners, settings window, update check, changelog; scan, install, catalog, labels) | Several concerns per function; tracked by #1377 |
| `replay-engine` `replay-command-gate.ts` | 2,598 lines | Decides when a replay command may be sent; one decision table in its header | Large, cohesive |
| `replay-engine` `walkToLapStart` | 1,007 lines | Walking to a lap start: about 25 nested helpers (session map, search, crossing bisection, nudge, checkpoint) serving one job | Cohesive; in effect a module written as one closure. Its helpers share closure state, so none can be unit-tested alone, and #1428 added 212 lines to it in one fix. A testability note, not a defect. Splitting it carries risk, because iRacing's measured timing lives in it |
| `iracing-actions` `replay-control.ts` | 1,599 lines | One action; `executeMode` dispatches its 28 modes | Large, cohesive |
| `iracing-actions` `fuel-dial-surface.ts`, `session-info.ts`, `car-control.ts` | 2,031 / 1,744 / 1,683 lines | One action or dial surface each | Large, cohesive |
| `replay-store` `createReplaySessionStore` | 1,050 lines | One store; each record section repeats its wiring by hand | Cohesive. The per-section repetition costs about 100 lines per new section; no section was added in this window |
| `scenario-harness` `scenario-shortcuts.ts` | 4,205 lines | A list of shortcuts plus helpers | A data file; grows with each callout by design |

## What is bad, ranked

### 1. A device shell now knows the sim — medium for a second sim

#1111 put automatic profile switching where Elgato-only behaviour belongs, on the `PluginExtension`, and widened no shared interface. What it cost:

- **The shell now imports sim packages.** `iracing-plugin-stream-deck/src/elgato-extension.ts:14,18` imports `deck-iracing` (`getController`, `onIRacingTerminated`) and `sim-events-iracing` (`getSessionKind`, `getSessionType`), and `:15` imports `iracing-actions` (verified). The extension subscribes its own tick listener on the SDK controller. That makes the Stream Deck shell a second place that composes the sim.
- **An order guaranteed only by a comment.** `PluginExtension.start()` takes no arguments (`plugin-runtime/src/types.ts:47`, verified). The order it depends on ("the translator subscribed first", `elgato-extension.ts:58-62`) rests on subscriber insertion order in `SDKController`, and no test checks it.
- **More `plugin-runtime` files know the sim: 8 → 10.**
  - `phases/replay.ts` injects `getCommands` into the engine, which is correct composition for #1467.
  - `native-addons.ts` takes a type-only import.
  - `architecture.md:315` still says "`initSim` is the only phase that knows which sim is running". The page's graph was updated for #1111; that sentence was not.
- **Session-kind vocabulary that can drift.**
  - **Three types.** `SessionKind` in `sim-events-iracing` (5 values), a different `SessionKind` in the catalog's `race-start.ts` (3 values, another meaning), and `ProfileSwitchSessionKind` in `app-constants`.
  - **A one-way check.** The `app-constants` union is pinned to the translator's only by assignability at `elgato-extension.ts:70`. A kind the sim adds fails to compile; a kind `app-constants` adds is never produced, and nothing flags it.
  - **A comment-only mirror.** The catalog's `classifySessionType` mirrors the translator's and must agree with it; only a comment says so (`race-start.ts:15-17`, verified).

Judgement: the session kind belongs on `SimRuntime`, or in a context `startPlugin` hands to `PluginExtension.start(ctx)`. Then a second sim swaps `initSim` rather than editing a device shell. This overlaps #1378.

### 2. `ScenarioEngine` is a god class that grows by engine features, and one cross-package order is held only by prose — medium

- **The god class grew by a feature.** `interpreter.ts` went from 3,300 to 3,710 lines (verified), and `ScenarioEngine` now spans 2,647 lines. #1407 added 437 lines there, out of about 740 source lines for the whole fix. It owns five responsibilities: registration, vocabulary, compilation, arbitration and playback. Until now it grew mostly through callouts; this time an engine feature (ending a line) went in alongside them. The end handling is spread across `prepareOps` (83 → 98 lines), the new `expandFrame` (88) and `pending-queue.ts`.
- **An order between packages that only prose states.** The `EndsOn` doc in `dsl.ts` requires that a contract's trigger event is never published after its end event in the same tick.
  - For `limiter-dropped` that holds only because `diffLimiter` runs before `diffPitLane` (`translator.ts:2657-2658`, verified).
  - The translator's comment gives a different reason for that order, the stall flag (`:2596-2598`).
  - Validation checks only that the two events differ (`validation.ts:113-119`).

  A reorder in the translator would silently bring #1407's bug back.

### 3. The always-loaded set is growing again — medium-low (process)

#1465 cut the always-loaded set to 108,072 characters. Five days later it is 111,609 (verified), 3.5k more. Two sections account for most of that:

- **"Turbo task inputs"**, added to `build-and-commit.md` by #1491 (+1.2k).
- **The Node 24.15 worker-crash section**, added to `testing.md` by #1444 (+1.1k).

Each is a single topic that matters only when touching `turbo.json` / `scripts/turbo-inputs*` or `vitest.config.ts`, so each could be path-scoped, exactly as #1465 did for the merge gate and the changelog internals. The budget test fails only at the 130k edge.

### 4. Drift the compiler cannot see is unchanged, and two casts were added — medium-low

Every #1376 bullet is still open:

- **Unguarded keys.** Three persisted callout keys are outside the frozen baseline: 103 registry keys against 100 in the fixture.
- **A stale floor.** `CATALOG_FLOOR` is 159 against 168 contracts.
- **Harness options.** The harness passes 0 of the 6 translator options.
- **Mirrored constants.** Two settings ↔ translator constants are tied by comment only.
- **Untyped settings casts** went from 17 to 19 (`phases/replay.ts:26-27`, verified). `replayJumpPlayback` is in `GlobalSettingsSchema` (`global-settings.ts:524`), so that cast hides a rename the type would catch.
- **Harness lists.** All 91 events have a template today, but by convention only.

### 5. What #1467 promised and did not deliver, and two boundary conventions — low-medium

- **The shared settle helper.** The spec's Decision 2 says the settle-polling loops "share one engine poll helper where their exit conditions are the same" (verified). `pollUntil` has two callers. Seven loops still poll with their own `sleep`:
  - the gate at `:2363`, `:2433` and `:2498`;
  - seek `:164`;
  - jump playback `:443`;
  - the incident observer `:134`;
  - the search queue `:762`.
- **The dial still drives the key class.** `replay-control.ts:592,594` call `executeMode`. #1467 did not task this; the previous review raised it.
- **Test hooks in the public surface.** The main barrel exports 195 names, 12 of them `_reset` / `_configure` test hooks (verified), and 125 have no production consumer. A `./testing` subpath exists, but it ships in `dist` like the main entry. Production code can therefore import the test hooks, and the single-sender test has to scan for `engineEnv().replay()` misuse instead of the boundary preventing it.
- **The reset list is checked for behaviour, not completeness.** `_resetReplayEngine` is a hand-kept list ("A module that keeps state adds its reset here", `replay-engine-reset.ts:1-4`, verified). Its test checks that the listed modules reset. Nothing fails when a new stateful module is left off the list, unlike the diagnostics registry's directory-scan test.
- **Camera sends are unguarded.** Decision 3 routes every camera switch through `requestCameraSwitch`, and every send is wrapped today (checked by hand). But the single-sender test explicitly allows a bare `camera.switchNum` (verified), and no other test checks it.

### 6. Test scaffolding is copied by hand — low-medium

- **Fake audio services.** `createFakeAudio` exists as 37 hand-written copies totalling 1,589 lines (36 in `audio-scenarios`, 1 in the harness). Adding the fifth mixer channel in #1455 meant editing 36 test files.
- **Family test edits.** #1407 touched 30 family tests only to swap in `familyReferences`, because voice-level frames leaked into exact-list assertions.

### 7. The bundled-profile reader is duplicated, and a comment says it is not — low

`availableProfilesForDevice` and `deviceProfileEntries` are byte-for-byte the same in `switch-profile.ts:140-162` and `race-admin-selector.ts:72-90` (verified). #1111 exported the first copy for the Stream Deck shell, with the comment "so the one reader of `profiles.json` stays here" (`switch-profile.ts:138`). Camera Controls imports the second copy (`camera-controls.ts:90`). Elgato-only data (`data/profiles.json`) also lives in the shared actions package, so the shell now imports `iracing-actions` to read it.

### 8. Build pins that are not pinned — low

- **Release builds use an unpinned Node.** `release-pack.yml:32` and `publish-voice-packs.yml:51` use `node-version: 24` (verified), while CI uses `.nvmrc`'s 24.21.0, pinned by #1444 because 24.15.0 crashes. The shipped bundle is built on whatever 24.x the runner resolves.
- **The turbo-inputs test models turbo without pinning it.** `scripts/turbo-inputs.test.mjs` re-implements turbo's hashing "as this test models it (turbo 2.11…)" (`:24`, verified). Nothing ties that model to the installed turbo 2.11.9, so a turbo bump that changes the semantics passes silently.

### 9. Documentation drift — low

- **Still in place:**
  - `architecture.md:6` ("one new adapter … nothing else changes");
  - `:315` ("`initSim` is the only phase", now wrong in 10 files);
  - `:490` ("15 catalog files / 15 `getCommands()` files"; the counts are 14 and 10);
  - the Mermaid graph without `audio-scenarios → iracing-sdk`;
  - `translator.ts:6-7` ("only package allowed to import `iracing-sdk`", with 19 `replay-engine` importers now);
  - `sim-runtime.ts:6-8` and `race-engineer-wiring/CLAUDE.md:10` pointing at #1351;
  - `audio-scenarios/CLAUDE.md:28` (`position-range.ts`);
  - "Replay busy marks" in `icon-composer`;
  - the README's "33" and "32" actions against 35 `SHARED_ACTIONS` classes.
- **Unchanged since the previous review:**
  - #1375 has not moved at all: 21 relative reaches, `shared/index.ts` (now also #1494), the twin loggers and `fake-sim-connection.ts`.
  - The three plugin turbo blocks are still copied; #1491 had to edit all three.
  - The sim-boundary lint still misses `settings` and `voice-packs`.
- **The commit-trailer rule has no enforcement.** `hooks.md` says it belongs to husky, but there is no `commit-msg` hook. No new violations appeared in this window.
- **One stale line.** `race-engineer-callout-examples.md:73` still says "The mixer has four channels".

## Trade-offs, not defects

Raised during the review, checked, and kept out of the ranking because each is a deliberate, documented choice. They are recorded here so a later review does not raise them again as defects.

- **The callout grammar is strict.** An unknown key drops the whole voice, so #1407's optional `cut` key moved both packs to `minPluginVersion` 3.7.0. This fails closed, and the version mechanism handled it. It becomes a policy question only if third-party packs appear.
- **The spec control-byte scan runs in local hooks** (husky and the Claude hook) since #1466. A commit that skips both is still caught by `no-control-bytes.test.mjs` on the next code push.
- **A `.mock` file forces the native mock without a log line.** `native-addons.ts:10` documents that only `load-failed` speaks, and the snapshot records `forced`.
- **The replay engine's speed functions take `nowMs` from their callers,** which pass `Date.now()`. The package `CLAUDE.md` documents it.
- **The replay engine's lint rule refuses five packages rather than allowing a list.** The four declared dependencies hold the boundary at build time.
- **Fresh-key style seeding has two orderings** (the volume actions before `super.onWillAppear`, the setup actions after). The #1453 spec records this and leaves it.
- **Path-scoped instruction text grew 62k in five days.** That is the shape #1465 intended: detail moved out of the always-loaded set into files that load only with their code.
- **Different per-key timers in actions** (Replay Markers' confirmation flash, Session Info's change flash, the Starter's cranking frames). They look alike but do different things, so they are not duplicates.

## Extensibility

| Change | 2026-10-20 | Now | Why |
| --- | --- | --- | --- |
| New first-party voice pack | Low-moderate | Same | Parity-guarded scripts, a floor entry, 168 contracts; a frame may now carry a `cut` tail |
| Third-party voice pack | Low, by design | Same | An optional grammar addition makes older plugins drop the voice, by design (*Trade-offs*) |
| New action | Moderate, linear | Same | No action added in the window |
| Dial on an existing action | Low-moderate | Low | #1451 touched 11 files, all in `iracing-actions` plus docs; the 18-copy lifecycle is still copied |
| New Elgato-only feature | — | Low | `PluginExtension.start` absorbed #1111 without touching shared code, at the price of sim imports in the shell |
| New callout in an existing family | Low-moderate | Same | A line that should end with its condition is one `endsOn` field, but the translator's event order must be checked by hand |
| New callout family | Moderate-high | Same | Nothing moved |
| New mixer channel | — | Low | Two enum entries and `IRD_MAX_CHANNELS`, but about 36 copied test fakes |
| New replay mode | Moderate-high | Low-moderate | Two dial modes (#1448) and a Markers feature (#1454) touched no engine file |
| New deck host | Medium | Same | The adapter seam did not move; a host without profiles correctly gets no auto-switch |
| Second sim | High, slightly worse | High, about the same | Better: the replay engine is a named iRacing package behind a lint rule, and session-kind classification is sim-side. Worse: a device shell and two more `plugin-runtime` files know the sim, and the session kind is not on `SimRuntime`. Unchanged: 19 `SimRuntime` getters, 14 catalog files, 11 casts, 5 events keyed on iRacing identities |

## The process layer

Judgement, not a defect.

- **Follow-ups are landing.** Four of the four follow-ups filed five days ago merged within that window, each meeting the goal its issue stated, and #1373 from two reviews back merged too.
- **What has not moved.** The hygiene and drift issues (#1374–#1378) have now been carried through three reviews.
- **Spec churn has eased.** Spec commits fell to 57% of the window, no issue took more than five, and spec-only pushes no longer run CI.

## Follow-ups

Filed or updated with this review, in the order it would take them:

1. [#1499](https://github.com/niklam/iracedeck/issues/1499): **pin the event order `endsOn` relies on** (item 2). Add a validation that an end event cannot follow its trigger in the same tick, or at least a test that fails if `diffLimiter` stops running before `diffPitLane`. Correct the translator comment's stated reason. Small, and it guards a fix that just shipped.
2. [#1500](https://github.com/niklam/iracedeck/issues/1500): **put the session kind on `SimRuntime` and hand it to the extension** (item 1). Give `PluginExtension.start` a context from `startPlugin`, and remove the sim imports from `elgato-extension.ts`. Make the `app-constants` session-kind union two-way checked, and correct `architecture.md:315`. It could be folded into #1378.
3. [#1501](https://github.com/niklam/iracedeck/issues/1501): **path-scope the two new always-loaded sections** (item 3), as #1465 did for the others.
4. [#1502](https://github.com/niklam/iracedeck/issues/1502): **finish #1467's promises and close its two conventions** (item 5):
   - the shared settle helper Decision 2 describes;
   - keep the test hooks out of the main barrel;
   - a completeness test for `_resetReplayEngine`;
   - a test that camera sends go through the waiter.

   No change to the walk's shape.
5. [#1503](https://github.com/niklam/iracedeck/issues/1503): **pin the build toolchain** (item 8): `node-version-file: .nvmrc` in the release and voice-pack workflows, and a turbo version assertion in `turbo-inputs.test.mjs`.
6. [#1504](https://github.com/niklam/iracedeck/issues/1504): **one shared fake audio service** (item 6), in a test-support module used by the catalog and the harness.
7. **This review's additions, recorded as comments on the existing issues:**
   - #1376: the casts went from 17 to 19.
   - #1374: the line numbers and counts.
   - #1375: 21 reaches, the duplicated profile reader, and `replay-engine/testing` in `dist`.
   - #1377: its replay-store part was done by #1467.
   - #1378: overlaps follow-up 2.
   - #1468: still open.

Not proposed:

- **Splitting `ScenarioEngine`.** It is a real god class, but the split is large; the right moment is the next engine feature, and follow-up 1 guards the feature that just went in.
- **Splitting the walk.** It is cohesive, and splitting it carries risk.
- **A dial-surface base class, and contract-level quiet conditions.** Both are still worth doing, but neither got worse in this window.
