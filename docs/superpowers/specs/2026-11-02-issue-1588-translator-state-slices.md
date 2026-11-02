# Translator state arrives in slices, and a diff takes its slice

> **Issue:** [#1588](https://github.com/niklam/iracedeck/issues/1588) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `c62f1eaae`. Line numbers are `packages/sim-events-iracing/src/` unless named otherwise. Two branches change this area first and merge before this starts: #1582 (`../ir-1582`, which adds the `lapCrossing` slice) and #1559 (`../ir-1559`, which puts every `handleTick` call behind a step boundary). Their line numbers will have moved by then; the shapes cited here will not.

## The problem

`TranslatorState` (`state.ts:214-1755`) is one flat type of 250 members (counted as `^  name:` lines; the 2026-11-01 review measured 251), and 91 signature lines across 32 modules under `diff/` take it whole (`state: TranslatorState`, test files excluded). Nothing says which fields belong to which family, so a signature cannot tell a reader what a diff touches, and every diff can read and write every other family's fields.

Two families show the two shapes side by side:

- #1515 added one nested member, `trackGaps: TrackGapsState` (`state.ts:170-202`, `:1301`), built by `createTrackGapsState()` in `createInitialState` (`state.ts:1974`). Its diff still takes the whole state (`diff/track-gaps.ts:140-156`), because it replaces the slice through the parent (`state.trackGaps = createTrackGapsState()`, `:151`).
- #1571 added six flat `fastestLap*` members (`state.ts:1366-1415`, initialised at `:1982-1987`). Their partial survival across a replay glance is spelled field by field in the translator's wipe (`translator.ts:2205-2214`).

`ReplayRecorderState` (`replay-recorder-state.ts:66`, factory `:180`, partial reset `resetReplayRecorderBaselines` `:214-221`) is the third precedent: a state of its own whose diffs take it rather than `TranslatorState` (`diff/replay-laps.ts:121-127`).

The fastest-lap diff also shows the one thing a slice convention must answer besides shape: it reads another family's state. `playerLapAwaitsJudgement` (`diff/fastest-lap.ts:229-249`) reads `lapCompletedInitialized` and `lastLapCompletedCounter`, which only `diff/laps.ts` writes. Cross-family reads are common: `cautionPhase` is read by `diff/flags.ts`, `diff/laps.ts` and `diff/start-lights.ts`, `flagCheckeredTakenLap` by `diff/laps.ts`, and `playerFinalLapStarted` by `diff/fuel-laps-left.ts` (the #1559 spec, decision 4, lists the same-tick ones).

## Decisions

### 1. The convention

**When.** Every new cluster of translator state is a slice: the fields a new family adds, or a new concern inside an existing family. An existing flat cluster becomes a slice when its family is next changed in substance, never in a sweep (decision 2). The guard of decision 3 makes the first half mechanical.

**Shape.** A slice is one `TranslatorState` member `<family>: <Family>State`. The key is camelCase and the slice's own fields drop the family prefix: `fastestLap.record`, not `fastestLap.fastestLapRecord`. The type and its factory `create<Family>State()` are declared in `state.ts`, beside the member, with the cluster's documentation on the type and each field documented inside it. The factory sets every field, and `createInitialState` builds the member by calling it with no arguments.

- **Why `state.ts` and not the diff module.** `state.ts` already makes one value import from `diff/` (`createPitLapLatch`, `state.ts:20`), from a module that imports nothing back. A diff module imports `state.ts` (`diff/fastest-lap.ts:83`, `diff/laps.ts:74`), so a factory in the diff module closes a cycle `state.ts` → `diff/x.ts` → `state.ts` as soon as the diff imports a value from it (#1582's `laps.ts` imports `createLapCrossing` as a value). The plugin builds fail on a cycle among workspace sources (`.claude/rules/plugin-structure.md:103`, `scripts/lib/rollup-logs.mjs:22`).
- **Naming.** `TrackGapsState` / `createTrackGapsState` already conform. #1582 names its slice `LapCrossing` / `createLapCrossing` (`ir-1582` `state.ts`, uncommitted at this measure). This change renames them to `LapCrossingState` / `createLapCrossingState`, a mechanical rename, unless #1582 adopts the names before it merges. The suffix is what the guard reads (decision 3), and it is the name every precedent has.

**What a diff receives: its slice, plus values.** A diff function that owns a slice takes the slice as its first parameter and never takes `TranslatorState`, whole, `Readonly`, or narrowed with `Pick<>`.

- **A read of another family's state is a value.** `handleTick` reads it and hands it in as an argument, typed with its unknown case (`null`), and the parameter's JSDoc says which fact it is and who writes it. For the fastest-lap hold this is `lapsJudgedThrough: number | null`, the `LapCompleted` count `diffLaps` last emitted for, `null` while the lap diff is unseeded. `handleTick` passes `self.state.lapCompletedInitialized ? self.state.lastLapCompletedCounter : null`, read at the call. Today's pending test (`initialised && laps >= 1 && laps > counter`, `diff/fastest-lap.ts:231-236`) becomes `lapsJudgedThrough !== null && laps >= 1 && laps > lapsJudgedThrough`, which is the same predicate.
- **A write into another family's slice goes only through a closure `handleTick` builds over that slice.** The fastest-lap judge is the one case today, and the one sanctioned cross-step writer of the `fastestLap` slice: `createFastestLapJudge(self.state.fastestLap, …)` is handed to `diffLaps` (`translator.ts:2711`), so the judge writes `record` and `claim` from inside the lap diff's call, and `diffFastestLap` reads them later in the tick. So a slice is not owned by one step: the `fastestLap` slice has two writers, `diffFastestLap` and the judge, and `CLAUDE.md` names the judge as that exception rather than claiming single-step ownership. `laps.ts` still reaches the record only through `FastestLapJudge` (`(lap, lapTime) => boolean` once #1582 lands) and never imports the slice. A new cross-step writer needs the same justification and its own line in `CLAUDE.md`.
- **A diff mutates its slice in place.** A diff that must clear its slice writes `Object.assign(slice, create<Family>State())`, never a new object through the parent (rule D of decision 3 checks it). That keeps every reference taken during a tick valid: the judge closes over the `fastestLap` slice when `diffLaps` runs and is still writing the same object `diffFastestLap` reads later in the tick. `diffTrackGaps`' reset (`diff/track-gaps.ts:151`) becomes the in-place form, and its signature takes `TrackGapsState`. No reader holds the slice across ticks: `getTrackGaps` reads `instance.state.trackGaps` on each call (`translator.ts:1211-1214`), and no test depends on the slice's identity.

**Lifecycles.** The translator recreates the whole state at a disconnect (`translator.ts:2005`) and at a session change (`resetPerSessionState`, `:2302`), so a slice built by `createInitialState` resets at both with no code. A slice that must outlive a session change is listed in `resetPerSessionState`'s `preservedAcrossSessions` (`:2297`, the `lastStopTireTemps` precedent). The replay wipe (`wipeStateForReplay`, `:2043-2244`) has three cases, and the slice's owner picks one:

- **Wiped whole** (`trackGaps`): nothing to write.
- **Kept whole**: the slice's key in `preservedAcrossReplay` (`:2044`).
- **Kept in part**: a function in `state.ts` beside the factory, `reset<Family>…(slice): <Family>State`, that returns the slice to keep, the `resetReplayRecorderBaselines` shape. `preservedAcrossReplay` calls it, and the reasoning for which fields survive moves from the wipe's comment onto that function. For the fastest lap this is `resetFastestLapBaselines(slice)`: `record` (by reference) and `raceSeeded` carried, `baselines`, `baselinesSeeded`, `claim` and `hold` fresh. That is exactly today's partition (`translator.ts:2205-2214`, the #1571 spec's "the record survives a replay glance; the baselines do not").

**The Telemetry Snapshot needs no code.** `readSimState` hands the whole state to the snapshot as `raw.state` (`translator.ts:1856`), and the JSON-safe encoder (`packages/diagnostics/src/json-safe.ts:80`) walks nested objects as it already does for `trackGaps`. A slice appears as `raw.state.<family>.<field>`: `raw.state.fastestLapRecord` becomes `raw.state.fastestLap.record`. `raw` carries no stability promise (`sim-state.ts:23-24`), and no curated key reads a fastest-lap field, so the curated half is unchanged.

**Where it is written.** `packages/sim-events-iracing/CLAUDE.md` gains a section "Translator state slices (#1588)" with the rules above, beside the step-boundary section #1559 adds. For which clusters are still flat, and what each one's move must settle, it points at the guard's pin (`LEGACY_FLAT_MEMBERS`, decision 3) and lists nothing itself. Its fastest-lap bullet's `fastestLapRecord` becomes `fastestLap.record`. In `.claude/rules/race-engineer-callouts.md`, step 2's state bullet (`:105`) is rewritten to the slice form (a new family's fields are a `<Family>State` slice with its factory, and the diff takes the slice), and the "Translator state" row (`:71`) names the slices and the guard. The #1571 entry of `race-engineer-callout-examples.md` (`:108`) keeps its history and gains a "(since #1588, the `fastestLap` slice's `record`)" pointer, the file's convention for entries whose wiring later moved.

### 2. Scope for 3.8.1

**In:** the convention and its guard; `fastestLap*` moved into `fastestLap: FastestLapState` with `diffFastestLap`, `playerLapAwaitsJudgement`, `resolvePlayerFastestLap` and `createFastestLapJudge` taking the slice; `diffTrackGaps` taking the slice it already has; #1582's `LapCrossing` renamed if it merged under that name. All of it is behaviour-neutral, which is what a refactor-only release admits.

`diffFastestLap` keeps its parameters in order and appends `lapsJudgedThrough` after `now`, so its emitter stays at index 8 and the `tick-order.test.ts` spy line (`tick-order.test.ts:136`) and the `TICK_ORDER` row (`tick-order.ts:136`) do not change.

**The next candidates, not moved now.** Each moves when its family is next changed. This table is the record of what each move must settle at `c62f1eaae`; in the tree, each note lives as a comment on that heading's entry in the guard's pin (decision 3), which is the one list of flat clusters:

| Cluster (`state.ts` heading) | Flat members | What its move must settle first |
| --- | --- | --- |
| Leader's white flag (#936) | 6 | Partial replay keep (`leaderWhiteFired`, `leaderWhitePostExpiryCrossed`). Self-contained otherwise; the smallest next one. |
| Laps-of-fuel-left callouts (#838) | 5 | Partial replay keep (three of five fields); reads the flags' `playerFinalLapStarted` (`diff/fuel-laps-left.ts:367`), which becomes a value. |
| Gaps (#933) | 33 | Partial replay keep (`gapRestartMark`); the translator's pair reading for `diffOpponentFlags` reads its traces (`translator.ts:1568-1569`), which the slice must still serve. 22 signature lines in `diff/gaps.ts`. |
| Opponent pit (#622), opponent flags (#936) | 5, 10 | Partial replay keeps; #1559 has just restructured both diffs into per-car units, so a move now would only collide with it. |
| Caution (#1127) and catch-up (#1168) | 11, 22 | The largest partial keep (`translator.ts:2117-2190`); `cautionPhase` is read by three other diffs and must become a value for each. |
| Lap completion (#555) | 20 | `lapCrossing` nests inside the laps slice; `flagCheckeredTakenLap` (written by the flags) becomes a value. |

Not now, because every one of them carries a decision the fastest lap does not: a partial replay partition to restate as a function, and cross-family reads to turn into values one by one. Each is a review against its own wipe rules and its own family's tests, and doing them together would make the behaviour proof one large diff nobody can read. The issue asks for the same (its fourth task), and the guard keeps the flat set from growing meanwhile.

### 3. A guard over `state.ts`, with planted failures

Prose alone is not enough: the review found the flat shape returning one week after the nested one was introduced, with no rule against it. The check is mechanical, so it is a test (the repo's rule for mechanical rules, `.claude/rules/hooks.md`, "Rules" 1).

`src/state-slices.test.ts`, over a scanner in `src/state-slices.test-support.ts` that reads sources with the TypeScript compiler API (binder only, no type check), the shape of `packages/replay-engine/src/replay-engine-reset.coverage.test-support.ts`.

**Sections.** The scanner gives each `TranslatorState` member the section it sits in: the text of the nearest `// ── <heading> ──` comment above it in the type (`state.ts:215`, `:1366`, …), read from the leading comments. A member before any heading is an error.

**The pin is the migration table.** `LEGACY_FLAT_MEMBERS` maps each section heading that is still flat to its member names. Each heading entry carries, as a comment, what its move must settle first (decision 2's table, carried over). It is the only list of flat clusters; `CLAUDE.md` points at it and lists nothing itself.

Four rules:

- **A. Every `TranslatorState` member is pinned flat or is a slice.** A member not in the pin must be a slice:
  - its type annotation is a reference to an object type alias declared in `state.ts` whose name ends in `State`;
  - that type literal has no optional (`?:`) property, so a factory that type-checks provably sets every field;
  - `createInitialState`'s returned object initialises it with a no-argument call to `create` + that type's name.

  This refuses a new flat member, a slice built from a literal, and a slice whose factory may leave a field unset.
- **B. The pin only shrinks, and each name sits under its own heading.** A pinned name that is no longer a member fails, naming the entry to delete, so moving a cluster deletes its heading from the pin in the same change. A pinned name that is a member under a different heading than the one it is pinned under also fails, naming both headings, so the pin cannot drift from the file's sections.
- **C. A diff module that takes the whole state reaches no slice through it.** Under `src/diff/`, outside test files, in a module that imports `TranslatorState` (as `import type { … }` or `import { type … }`):
  - it names no slice type;
  - it reads no slice key as a property of an identifier bound to a parameter or variable annotated `TranslatorState`, destructuring included (`const { fastestLap } = state` counts).

  A slice key on any other receiver is not a match: `other.fastestLap` passes. Matching any receiver would flag ordinary code that happens to share a key name, the way `anchor.caution` (`diff/fuel-laps.ts:243`) would fall to a future `caution` slice. Its one allow-list entry is `diff/laps.ts` for `lapCrossing`, with the reason beside it: the laps cluster is still flat, and the crossing nests into the laps slice when that moves. `translator.ts` and `state.ts` are outside the rule; they are where slices are built, wiped and read for the getters.
- **D. No diff replaces a slice through its parent.** Under `src/diff/`, outside test files, no assignment has a target `<x>.<sliceKey>`. That is the in-place rule of decision 1, made mechanical. `diff/track-gaps.ts:151` is converted by this change. #1582's `laps.ts` replaces `lapCrossing` through the parent (`ir-1582` `laps.ts:220`); #1582 is being asked to write `Object.assign(state.lapCrossing, createLapCrossingState())` before it merges, and if it merges as it is, this change converts that line.

**Positive controls.** Each rule runs over a planted fixture source, and the test asserts the reported name, not only a failure. These must fail:

- an unpinned flat member (A);
- a `*State` member initialised from a literal (A);
- a slice type with a `?:` property (A);
- a pinned name missing from the source (B);
- a pinned name under the wrong heading (B);
- a module importing `TranslatorState` that reads `state.fastestLap`, and one that destructures it (C);
- an assignment `state.trackGaps = …` in a diff module (D).

This one must pass: a module importing `TranslatorState` that reads `other.fastestLap` on a receiver not annotated `TranslatorState` (C).

**No vacuous pass.** A scan that finds nothing satisfies every rule, so the test asserts minimum counts, as `packages/replay-engine/src/replay-engine-reset.coverage.test.ts:48-52` does:

- `TranslatorState` found with more than 200 members;
- at least 40 diff modules scanned (46 non-test modules under `diff/` at `c62f1eaae`);
- at least 28 of them importing `TranslatorState`, both import forms counted (32 at `c62f1eaae`; 30 once this change takes `fastest-lap.ts` and `track-gaps.ts` off it). The floors sit below the measured values so a later move does not trip them; a scan that silently stops matching one import form drops far below;
- every slice key found as a slice: `trackGaps`, `fastestLap`, `lapCrossing`;
- every allow-list entry matching at least one finding. An entry that matches nothing fails, so a stale exception cannot linger once `diffLaps` moves.

### 4. What proves nothing changed

- **The end-to-end tests run unchanged.** `translator.test.ts`'s "fastest lap of the race (issue #1571)" block (`translator.test.ts:7517` on), including the session-change reset (`:7716`) and both replay-glance tests (`:7736` on), drives the real translator and touches no state field; it must pass without an edit. So must `track-gaps.translator.test.ts`, `tick-order.test.ts` and `sim-state.test.ts`.
- **The unit tests change inputs, not expectations.** `diff/fastest-lap.test.ts` (78 references to the flat names) and `diff/track-gaps.test.ts` build a slice with its factory instead of a whole state, the hold tests pass `lapsJudgedThrough` instead of setting `lapCompletedInitialized` / `lastLapCompletedCounter` (`fastest-lap.test.ts:592-600`, `:628`, `:641`, `:770-785`), and field paths change. No expected value changes, and each file keeps its count of `it(` cases; the reviewer checks both on the diff.
- **The compiler is the exhaustiveness proof.** The six flat names are deleted from the type, so any reader the move missed is a `pnpm typecheck` error, not a silent `undefined`.
- **The replay partition is pinned twice.** A new unit test of `resetFastestLapBaselines` asserts `record` is the same object, `raceSeeded` is carried, and the other four fields equal the factory's; the translator's replay-glance tests pin the behaviour around it.
- **The snapshot.** One `sim-state.test.ts` case asserts that after a record falls, the JSON-safe encoding of the snapshot carries `raw.state.fastestLap.record` with the holder's `carIdx`.

### 5. How it composes with #1582 and #1559

- **#1582** adds `lapCrossing` under this convention's shape (its spec, decision 3) but keeps `diffLaps` on the whole state, since the rest of the laps cluster is flat. That is the guard's one allow-list entry (decision 3, rule C), and the slice is renamed to the `State` suffix (decision 1). Its session-boundary reset replaces the slice through the parent (`ir-1582` `laps.ts:220`), which rule D refuses; #1582 is being asked to make it `Object.assign(state.lapCrossing, createLapCrossingState())` before it merges, and this change converts it otherwise. #1582 also narrows `FastestLapJudge` to `(lap, lapTime)` and leaves `playerLapAwaitsJudgement` unchanged; this change builds on both. A refused lap now emits and advances the lap counter, so it ends the hold through the same `lapsJudgedThrough` value with no extra handling.
- **#1559** wraps each call in a step (`steps.live("diffFastestLap", pending, () => diffFastestLap(…))` on `ir-1559`). The move changes only the arguments inside that closure: `self.state.fastestLap` in place of `self.state`, and the `lapsJudgedThrough` expression, which is a field read and adds no call statement for #1559's source check (its decision 12) to see. The value is read when the step runs, as the field is today, so a `diffLaps` throw leaves it at what `diffLaps` left: the same-tick state read #1559's decision 4 accepts, now visible in the signature. The judge is the one sanctioned cross-step writer of the `fastestLap` slice (decision 1): it writes from inside the `diffLaps` step, so a `diffLaps` throw after the judge ran keeps the record and the claim while `lap.completed` is discarded, as it does on `ir-1559` today (its decision 6). The slice makes that cross-step write visible and named, and changes nothing about it; removing it is the later issue in Out of scope. The convention's "values in" rule is the same as #1559's rule that a same-tick flag one step hands another is a returned value (its decision 11), and the two CLAUDE.md sections sit side by side.
- **What slices offer #1559 later.** #1559 declined to restore a failed step's state because "nothing says which fields are the step's own" (its decision 6). A slice is most of that ownership: one writer per slice, with the judge the one named exception on `fastestLap`. Whether a step should restore its own slice on a throw is not decided here (Out of scope), and the judge would have to become a pure query first.

## Approaches weighed and rejected

- **Narrow each diff with `Pick<TranslatorState, …>`.** It names other families' fields in every signature, keeps the prefixes and the flat type, and gives the replay wipe, the session reset and the snapshot no unit to act on. The review counted zero uses, and nothing would stop the next family from going flat.
- **A diff takes its slice plus a `Readonly<TranslatorState>` context.** It reopens the whole state for reading, so the signature again says nothing about what the diff depends on, and `Readonly` is shallow and compile-time only. A value per fact is longer to write and says exactly what is read.
- **Return a new slice instead of mutating.** `handleTick` would assign every diff's result, and a closure taken earlier in the tick (the judge) would write a stale object. Most diffs already mutate in place; the exceptions replace a slice through its parent, `diff/track-gaps.ts:151` today and `laps.ts`' `lapCrossing` reset on `ir-1582`, and rule D converts them rather than making the pattern general.
- **Hold the slices on the translator instance, not inside `TranslatorState`.** The three reset sites recreate `self.state` whole, so a nested slice inherits all three. An instance field needs each site to remember it: the fuel lap tracker shows the cost, with its own resets (`translator.ts:425`, `:2024`) and a comment in `resetPerSessionState` explaining why that one does not.
- **The slice type and factory in the diff module.** The `state.ts` → diff → `state.ts` cycle the plugin builds refuse (decision 1).
- **Move every cluster now.** About 240 members across 32 diff modules, each with its own replay partition and cross-family reads (decision 2), in a refactor-only release. One reviewable move per family, when it is next touched, is the safer route, and the issue asks for it.
- **List the flat clusters in `CLAUDE.md` as well as in the pin.** Two lists drift, and only the pin is checked. `CLAUDE.md` points at the pin, whose headings are the candidate list with each move's note as a comment, and names none itself. This departs from the issue's wording ("list them in the CLAUDE.md"), deliberately.
- **An ESLint rule or a hook instead of a test.** A lint selector cannot hold a ratchet against a pinned list, and a hook sees only the tool input, not the resulting file, while a test catches every committer.

## Out of scope

- Moving any cluster other than `fastestLap*`; the table in decision 2 lists the next ones.
- Making `diffLaps` take a slice, or nesting `lapCrossing` under a laps slice.
- Splitting `ReplayRecorderState`'s prefixed fields (`replayLaps*`, `replayIncidents*`) into slices. It is its own state, outside `TranslatorState` and the guard.
- A curated `fastestLap` key in the Telemetry Snapshot.
- Restoring a failed step's own slice under #1559's boundary.
- Making the fastest-lap judge a pure query, with `diffFastestLap` committing the record and the claim, so the `fastestLap` slice has one writer. It is a behaviour-bearing change to the #1571 seam, for a separate later issue.
- Any behaviour change, event payload change or changelog fragment. Nothing is user-facing, so there is no fragment.

## Testing

- **Guard:** `state-slices.test.ts` passes on the tree. Each must-fail fixture of decision 3 fails with the reported name asserted, the must-pass fixture (`other.fastestLap`) passes, and the minimum-count and allow-list assertions hold.
- **Neutrality:** as in decision 4. The translator, tick-order, track-gaps translator and snapshot tests pass unedited; the two unit files keep their case counts and expected values; `resetFastestLapBaselines` and the snapshot's `raw.state.fastestLap.record` get a case each.
- **Gates:** `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm format`, `pnpm lint`, `pnpm test`, by hand. The build includes the three plugin builds, which fail on an import cycle.
- **Manual (Niklas), short, and in the same session as #1582's race test if both are in one integration build.** An offline race against AI, about five laps. Expected: a rival's fastest lap is called with its holder, and the player's own faster lap is called as the fastest lap of the race on its lap. Then, mid-race, open the replay and close it again: no fastest-lap call on the way back, and a later rival lap slower than the standing record is not called. That glance is the only path whose code moved in a way the unit tests could get wrong (the partial keep across the wipe).
