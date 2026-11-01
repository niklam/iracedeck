# Sector comparison against the leader and the cars around you

> **Issue:** [#1572](https://github.com/niklam/iracedeck/issues/1572) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `3e40a7f4f`.

## The problem

The Race Engineer says how big the gap to the cars around you is and whether it is closing (#933, #1285), but never where on the lap the time goes. Nothing in the project knows a sector time. The SDK exposes none for any car (`packages/iracing-native/src/defines.ts` has no sector or split variable), so sector times have to be measured. The track's sectors are in the session YAML (`SplitTimeInfo`), which #1573 parses (`docs/superpowers/specs/2026-11-01-issue-1573-sector-start-calls.md`, decision 1).

What can measure them is the progress the gap reader already records. Every live car gets a sample `{ progress: CarIdxLapCompleted + CarIdxLapDistPct, time: SessionTime }` in its trace whenever it has moved at least `GAP_TRACE_MIN_STEP` (0.002 lap, `packages/iracing-sdk/src/gap-utils.ts:29`) since the last one (`packages/sim-events-iracing/src/diff/gaps.ts:475-497`). The trace is reset on any backwards step or any forward step over `GAP_TRACE_MAX_STEP` (0.05 lap, `gap-utils.ts:38`) and pruned to 1.15 laps (`gap-utils.ts:22`), about 575 samples per car. It is recorded only in a race, past the green, while the player is racing (`gaps.ts:452-473`).

The issue's Goal settles the product: the track's own sectors however many there are, the leader / ahead / behind framing with class neighbours from the canonical order, clean laps only, race only, one setting per target. This spec settles how the times are measured, what counts, the thresholds, when the engineer speaks and how that sits beside the lap-time calls at the line.

## Decisions

### 1. #1573 ships first and owns the sectors; this issue depends on it

The `SplitTimeInfo` parser (`extractSectorStarts` in `packages/iracing-sdk/src/sector-utils.ts`), its `(TrackID, SessionNum)` cache through the shared `trackSessionKey` helper, the translator's `getTrackSectors()` and the whole `sector-number` clip group (1 to 10, both voices) are #1573's (its decisions 1 and 7). This issue is a hard dependency on #1573 and reuses all four unchanged. In particular it inherits #1573's refusal of a track whose first sector does not start at the line: a lap's sectors are counted from start/finish, and all 21 configurations measured in `local/` start at 0, with two (every oval) to seven (Le Mans) sectors.

### 2. One per-tick car-progress step feeds both the gaps and the sector timer

Today `diffGaps` checks its gate, validates each car's progress and appends it to the traces in one body (`gaps.ts:452-497`). That part moves into its own step, `stepCarProgress` in a new `diff/car-progress.ts`, called once in `handleTick` right before `diffGaps` (`translator.ts:2929`):

```typescript
type CarProgressTick = {
  /** The tick's `SessionTime`, finite. */
  sessionTime: number;
  /** Per car: `CarIdxLapCompleted + CarIdxLapDistPct` when both are finite and non-negative, else null. */
  progress: readonly (number | null)[];
  /** Per car: true when this tick's sample reset the car's trace. */
  traceReset: readonly boolean[];
};

function stepCarProgress(/* the gate's inputs, the traces */): CarProgressTick | null;
```

It holds the gate (race session, arrays present, finite `SessionTime`, a player index, a canonical order, not pre-green, the player racing) once, returns `null` when it fails, and otherwise appends each valid reading to its car's trace. `appendProgressSample` (`gap-utils.ts:50-73`) returns what it did, `"appended" | "skipped" | "reset"`, instead of `void`, which is how `traceReset` is filled. `diffGaps` takes the result as an argument: on `null` it blanks its live snapshots as its early return does today, otherwise it goes straight to the player's reading and the neighbours. The caution hold at the top of `diffGaps` stays where it is. `diffSectorTimes` takes the same result and runs right after `diffGaps`. Neither reads the other's state, and the gate exists once. The existing gap tests pass unchanged on the extraction.

### 3. A crossing of each sector start is interpolated between two ticks; a trace reset breaks the lap

For each car, `diffSectorTimes` keeps the previous tick's `(p0, t0)`. With this tick's `(p1, t1)`, every sector boundary `b = L + starts[k]` (integer lap `L`, `starts` from `getTrackSectors()`) in `(p0, p1]` was crossed at `t0 + (b − p0) / (p1 − p0) × (t1 − t0)`. A step can cross more than one boundary and each is handled. A car whose `traceReset` is true, or whose `progress` is `null`, breaks its current lap: the lap is not recorded and the next crossing starts a new one. So a sector time is never measured across a span the gap model itself refuses to read across (a tow, a car out of the world, a step past 0.05 lap).

**Why ticks rather than the trace's samples.** A sample lands only every 0.002 lap. That is about 0.1 s at racing speed on a 4 km track, but 27 m at Le Mans (13.55 km in the measured snapshots), nearly two seconds through a slow corner, where a straight line through the braking would not be safely below the bars in decision 6. One tick is 1/60 s anywhere. The trace stays the one authority on whether a car's motion was continuous.

**Wrap at start/finish.** `progress` counts laps, so the line is an integer boundary (`starts[0]` is 0) and a crossing of it needs no wrap arithmetic: it closes lap `L − 1` and opens lap `L` at the same interpolated time. This rests on `CarIdxLapCompleted` and `CarIdxLapDistPct` moving together at the line, which the #603 dump analysis recorded as a progress step of about 0.002 lap at a natural crossing (`race-engineer-callout-examples.md`, the #603 entry). If the counter ever lagged the distance by a tick, progress would step back about a lap, the trace would reset, and that lap would not be recorded: no wrong time is possible, only a missing one. The validation capture counts how often that happens.

**What resolution is claimed.** ±0.01 s per crossing and ±0.02 s per sector time, as a working figure: the bracket is one tick, and a tick pair more than `SECTOR_MAX_TICK_SPAN_S` = 0.25 s apart in `SessionTime` (dropped telemetry) leaves the crossing unmeasured and the lap unrecorded rather than blurred. Whether the remote cars' `CarIdxLapDistPct` moves as smoothly as the player's is not shown by anything in the repo, so the capture in the Testing section confirms the figure.

### 4. A clean lap is decided by the same rule for every car, the player included

A lap is recorded with `clean: true` when all of these hold for every tick it was driven:

- every sector crossing was measured (decision 3), and every sector time is positive;
- the car's `CarIdxTrackSurface` read `OnTrack`: any tick at `OffTrack`, `InPitStall`, `AproachingPits` or `NotInWorld` (`defines.ts:57-63`) makes it unclean, which covers the out-lap, the in-lap, an off-track and a tow. The surface, not `CarIdxOnPitRoad`, which `diff/race-finish.ts` documents as unreliable (the #773 entry);
- no full-course caution was out (`state.cautionPhase !== "none"`, set by `diffCaution` earlier in the same tick, the #1285 / #1171 precedent), so pace laps and the lap the green flies on are out;
- it is not the race's opening lap (`L === 0`), which a start queue inflates the way #1285 found for the gaps.

An unclean lap is still recorded, with its times where they were measured and `clean: false`, so a consumer can tell "no lap" from "a lap that does not count". One rule for all cars, because a comparison between a strictly filtered lap and a leniently filtered one says nothing; that is why the player's own `lapIsValid` is not used, since no other car has it. Whether `CarIdxTrackSurface` reports `OffTrack` for remote cars is not shown in the repo; the capture checks it.

**The completed laps survive a replay glance.** They are facts about laps already run, so they join `wipeStateForReplay`'s preserved cluster (`translator.ts:2042`); the lap in progress is dropped, because the wipe resets the traces its continuity was judged on. A session change clears everything with the rest of `TranslatorState`.

### 5. The translator stores facts; the catalog derives the reference

The translator keeps, per car, its last `SECTOR_HISTORY_LAPS` = 8 completed laps (`{ lap, sectorTimes, clean }`) and the lap in progress. Eight is a storage bound, not a policy: it is at least the window any consumer reads (the catalog's is 5, below) with room for another, and at seven sectors it is under 70 numbers per car, sized from the `CarIdx` arrays (no 64-car cap). Nothing in the translator averages, picks or compares.

The catalog derives the reference, in `catalog/pit-crew/sector-comparison.ts` beside the thresholds: for each sector, the median of the last `SECTOR_REFERENCE_LAPS` = 3 clean laps among the car's last `SECTOR_RECENT_LAPS` = 5 completed laps. Fewer than three and the car has no reference, so no call names it. This refines the PO's "averaged over the last few": one lap in traffic is one outlier, which a median of three ignores and a mean of three still carries a third of. The five keep it recent: a car that pitted has a reference again two laps later, and a stint from twenty laps ago never counts. The first comparison is possible after lap 4 at the earliest (lap 1 is never clean), for the player and the target alike.

The pace gap to a target is the sum over sectors of `player − target` (positive means the player is slower), also computed in the catalog. Summing the per-sector medians, rather than taking a median of lap times, keeps the pace gap and its split by sector the same numbers, so "most of it is in sector two" is a statement about the gap that was just read out.

### 6. The thresholds

| Name | Value | Meaning |
| --- | --- | --- |
| `SECTOR_DELTA_MIN_S` | 0.10 s | A sector counts as quicker or slower only beyond this. Five times the claimed resolution, and about the sector-to-sector noise of a consistent driver that the median of three already damps. |
| `SECTOR_CHANCE_MIN_S` | 0.15 s | The car ahead is called slower in a sector (attack), or the car behind quicker (defence), only beyond this. A call to act needs a clearer margin than a description. |
| `PACE_LEVEL_S` | 0.20 s/lap | A leader pace gap under this is "level": nothing is said, and nothing is recorded as said. |
| `PACE_GAP_MAX_S` | 5 s/lap | Above this the comparison is not about racing (damage, a stricken car); the leader call is silent. |
| `SECTOR_MOST_SHARE` | 0.5 | "Most of it" when the worst sector carries at least half of the time lost across the losing sectors; otherwise "the most". |
| `SECTOR_BATTLE_GAP_S` | 3.0 s | The attack and defence calls need the live gap to that neighbour at or under this. A car 8 s up the road is not a sector fight. |

**Which sectors are named.** The leader call names the sector where the player loses the most (the largest positive delta at or above `SECTOR_DELTA_MIN_S`) and, when there is one, the sector where the player gains the most (the largest negative delta beyond the same bar). It never lists combinations. "Every sector" replaces the loss clause, and the gain clause goes, only when the track has at least three sectors and every one is slower by at least `SECTOR_DELTA_MIN_S`. On a two-sector track (every oval in the measured set) "every sector" is never said: when both halves are slower, the worse carries at least half the loss by definition, so the line says "most of it is in" it. A track with one sector has nothing to compare and the family is silent there. Seven sectors (Le Mans) follow the same rules: one loss, at most one gain.

The attack call names the sector where the player is quicker than the car ahead by the most, the defence call the sector where the car behind is quicker than the player by the most, each at or above `SECTOR_CHANCE_MIN_S`. With no such sector there is no call.

**When the player is quicker than the leader** (pace gap at or below `−PACE_LEVEL_S`) the line says so and names, when there is one, the sector where the leader is quicker. "The pace gap flipping" is then a change of picture (decision 7).

### 7. When it speaks: at the player's line, at most one call every other lap, on a change

**The trigger is the player's `lap.completed` in a race** (`packages/event-bus/src/event-catalog.ts:901`), when the lap just completed was recorded clean for the player (decision 4), it did not carry `wasCaution`, no caution is out, and the race has not finished (`getRaceFinishedFired`, the lap-time family's gates, `lap-time.ts:211-235`). A pit lap, an off-track lap or a caution lap of the player's produces no comparison that lap. Each target's picture is evaluated there:

- **Leader** (the class leader from the canonical order): the shape (slower or quicker; level is silent), the named loss sector and its kind (most, the most, every), the named gain sector, and the leader's car index. Skipped when the player leads the class, and when the class leader is also the car directly ahead, so one car is never the subject of two calls: the attack call owns it.
- **Ahead** and **behind** (the class neighbours `diffGaps` resolves each tick, `gaps.ts:513-532`): the named sector and the car index.

A target is **selectable** only when its opt-in is on AND the active voice scripts its contract (`engine.isScripted(<contract id>)`, the owner-resolver precedent of #1571's decision 7). Without the second half, a voice that scripts only `-behind` would let the selection pick the leader or the car ahead, whose fire then expands to nothing; that target would stay due, outrank `-behind` on every lap, and starve it for the race.

A selectable target is **due** when its picture differs from the last one spoken for it. A different car is a different picture, so a new neighbour is news. The leader is also due when its pace gap has moved by `PACE_DRIFT_S` = 0.3 s/lap since it was spoken, or when `PACE_REPEAT_LAPS` = 8 laps have passed with the picture unchanged: that is the "every few laps" of the Goal. Attack and defence never repeat an unchanged picture, because a second "that's our chance" about the same sector and the same car is a nag, and the gap trend calls already follow the fight.

**At most one sector call every other lap.** After any sector call on lap N, none is spoken before lap N + 2 (`SECTOR_CALL_MIN_LAPS` = 2), whichever target it was. When several targets are due on one lap, the order is **ahead, behind, leader**: the attack is the one the driver can act on now, the defence the one they must react to, the pace picture the strategic one. A due target that did not speak stays due, because its picture was never recorded as spoken, so it is heard on a later lap.

**Where the decision lives.** The translator holds the facts (decisions 4 and 5, decision 10's readers) and the catalog holds the policy (the reference, the thresholds, the pictures, the cadence), the #936 split. The selection is one pure function in `catalog/pit-crew/sector-comparison.ts` that every contract of the family calls, so the three cannot disagree about which target speaks. The `where:` is the pure half: it computes the selection and stashes it keyed by the event envelope (#1138: a stash the gate reads is per fire). The `speakGate` is the claim (#1137): it records the spoken picture for that target and the lap of the call, last, after its refusals.

### 8. At the line, the lap-time calls speak first and the sector call follows them; never one combined line

The sector call is a separate line, ordered after the lap-time line, and it yields rather than competes:

- `triggerDelay: SECTOR_COMPARISON_TRIGGER_DELAY_MS` = 500 ms. #1571 publishes `fastestLap.set` right after `lap.completed` on the same tick, and with no delay a contract's `where:` and its attempt to fire run synchronously as each event is published (`packages/audio-scenarios/src/triggers.ts:80-175`). So on an idle bus a sector fire with no delay would take the bus while `lap.completed` is still being dispatched, before the "yours" fire exists, and the lap's own line would wait behind the interpretation of it. With the delay, every lap call of the same tick (#555, #1163, #1571) has been attempted before the sector fire is: one of them holds the bus or waits in its queue, and `queueBehind` puts the sector fire after it. 500 ms is far past the tick's synchronous flush and short enough that the call still sounds attached to the line it follows. The deferred path evaluates `where:` after the delay, so the selection reads the comparison as it stands then, which is the same lap.
- `queueBehind: ["pit-crew.fastest-lap-race", "pit-crew.lap-time-best", "pit-crew.lap-time-last"]` (#1571, #555, #1163), so a busy bus plays whichever of them speaks for the lap first.
- `weight: WEIGHT.CHATTER`, the band of #1163's every-lap call, so fuel, flags, the position and race-status calls outweigh it or queue beside it.
- `queueable: true` and `maxQueueWaitMs: 20_000`. The picture stays true for the lap, and the `speakGate` re-checks it: it admits the fire only while #1571's `lapStillCurrent(lapsAtEvent, latest)` holds for the lap it fired on (one definition of "the next lap" for all four line callouts) and no full-course caution is out, then claims. A call that waited past the next lap is dropped, and since nothing was recorded as spoken it is due again.
- `interrupt: false`, `family: "sector-comparison"` for all three contracts, `supersedeGroup: "sector-comparison"`: a newer lap's call replaces an older one still waiting, since it is built on newer laps.
- The default radio frame.

**Why not one combined message.** A combined "last lap was one twenty five point two, most of it lost in sector two" would join two families with separate opt-ins and separate cadences: every lap for #1163, every other lap at most and only on a change here. A driver who turns the every-lap time off still wants the sector call, and the reverse. A combined line would also need the lap-time script to carry the sector vocabulary in every pack. The delay and `queueBehind` give the same sequence at the line with neither family knowing the other's words.

**Why it waits rather than outranks.** The lap time is the fact about the lap just driven, the sector comparison an interpretation of the last three, so the fact goes first.

### 9. The wording, both voices: draft, for Niklas's approval before any clip is generated

Each line is built so that every spliced clip is a whole phrase and the sector clip always ends its sentence. Numbers reuse the gap readout's `lap-time-second` and `lap-time-decimal` clips ("zero", "point five seconds."), car numbers the `car-number` group ("car twelve"), as #1274 and #1571 do, and sectors #1573's `sector-number` group ("Sector two."). New intro clips go in a new `sector-comparison` group. No hyphen, dash, ellipsis, colon or semicolon (#1518).

**Leader, the player slower** (Default):

- "Pace check. The leader is quicker by" + "zero" + "point five seconds."
- then one of: "Most of it is in" + "Sector two." / "We lose the most in" + "Sector two." / "We're slower in every sector."
- then, optional: "We're quicker in" + "Sector three."

**Leader, the player quicker** (Default): "Pace check. We're quicker than the leader by" + "zero" + "point four seconds." then, optional: "They're quicker in" + "Sector two."

**Ahead, attack** (Default): "car twelve" + "ahead is slower than us in" + "Sector two." + "That's our chance."

**Behind, defence** (Default): "car seven" + "behind is quicker than us in" + "Sector three."

**Short Calls / Terse** (`shawn`), the same structure in radio shorthand:

- Leader slower: "Leader's quicker by" + "zero" + "point five seconds." then "Most in" + "Sector two." / "Biggest loss in" + "Sector two." / "Slower everywhere." then, optional, "Quicker in" + "Sector three."
- Leader quicker: "Quicker than the leader by" + "zero" + "point four seconds." then, optional, "Leader's quicker in" + "Sector two."
- Ahead: "car twelve" + "ahead, slower in" + "Sector two." + "Your chance."
- Behind: "car seven" + "behind, quicker in" + "Sector three."

The Default voice speaks as "we" where the issue's examples say "you", because that is the voice's register throughout ("We're gaining on the car ahead."). Each intro that leads into a number carries `next_request_ids` on `lap-time-second/1`, and each tail after a car number `previous_request_ids` on `car-number/42`, as the opponent-flag tails do.

**Vocabulary** (`sectorComparison.*`, each description naming its clip group): `paceSeconds` and `paceDecimal` (the pace gap, rounded to the tenth, from `lap-time-second` / `lap-time-decimal`), `lossSector` and `gainSector` (from `sector-number`), `carNumber` (from `car-number`, as the session spells it); the case `sectorComparison.paceShape` with keys `slower` and `quicker`; the case `sectorComparison.lossShape` with keys `most`, `largest` and `every`; the condition `sectorComparison.hasGain`. The number, the sectors and the car are all part of their sentence, so a value with no clip skips the whole call rather than leaving a gap (#835); only the gain clause is `optional`. A sector past ten has no clip (#1573's decision 7), so a call naming it is skipped.

### 10. The readers the translator exposes, and how the catalog reaches them

Two readers in `translator.ts`, both facts only:

- `getCarSectorTimes(carIdx): { recentLaps: readonly { lap: number; sectorTimes: readonly (number | null)[]; clean: boolean }[] } | null`: any car's recorded laps, newest last, for future features (a Session Info sector display, a delta to the player's own best sectors).
- `getSectorComparison(): SectorComparisonSnapshot | null`: the sector count, and for each of the player, the class leader, the car ahead and the car behind, its car index, its car number as the session spells it, its live gap to the player (`getLiveGapBetween`, the gap display's reading; `null` for the player) and its `recentLaps`. The targets are resolved from the canonical order the same tick: `diffGaps` already resolves the ahead and behind neighbours every tick (`gaps.ts:513-532`) and now also stores the class leader `resolveClassNeighbors` returns (`gap-utils.ts:128`), so there is one resolution per tick. A target that does not exist (the player leads the class, nobody behind) is `null`. The whole snapshot is `null` outside a race or with no sectors.

The catalog reaches it the #1378 way: a `SimRuntime` member `getSectorComparison` in `packages/race-engineer-wiring/src/sim-runtime.ts`, a `PitCrewDeps` key whose `DEFAULT_DEPS` entry is `() => null`, filled in `buildPitCrewDeps`, which maps the translator's snapshot onto the catalog's own `SectorComparisonInput` type. No bus event is added: the call fires on `lap.completed`, and the comparison is a state, not a moment. `race-positions.md` gains the consumer.

### 11. Settings: one per target, default on

A new family `packages/callout-settings/src/families/sector-comparison.ts`, `id: "sector-comparison"`, placed in the `gaps` group of `CALLOUT_PI_GROUPS` (`packages/callout-settings/src/pi-groups.ts:73`) beside the gap calls, which are about the same neighbours:

| Callout id | Key | Label |
| --- | --- | --- |
| `leader` | `calloutEnabledSectorComparisonLeader` | Sector pace against the class leader |
| `ahead` | `calloutEnabledSectorComparisonAhead` | Where we're quicker than the car ahead |
| `behind` | `calloutEnabledSectorComparisonBehind` | Where the car behind is quicker |

No `default` is written: all three ship on. The contracts are `pit-crew.sector-comparison-leader`, `-ahead` and `-behind`, mapped in `SCENARIO_ID_TO_SECTOR_COMPARISON_ID` and gated by `enabledIn(SECTOR_COMPARISON_CALLOUTS)`. The selection reads the same gate and `engine.isScripted` through one resolver built inside `registerPitCrew` (decision 7).

### 12. Artifacts beyond the code

- `iracing-sdk`: `appendProgressSample` returns its verdict; `gap-utils.test.ts` covers it.
- `sim-events-iracing`: `diff/car-progress.ts`, `diffGaps` taking its result, `diff/sector-times.ts` and its state in `state.ts` (type and `createInitialState()`), the leader index in `diffGaps`, the two readers. No `TICK_ORDER` row: neither new step publishes anything.
- `audio-scenarios`, `callout-settings`, `race-engineer-wiring` as above; `debug-state.ts` reads the family's module state (the spoken pictures and the last call's lap), #1387.
- Both voice packs: the `sector-comparison` group, the scripts, `callouts.json`, clips, catalog entries and a pack `version` bump.
- `scenario-harness`: a fourth snapshot override, `getSectorComparison`, set by shortcuts (`packages/scenario-harness/src/race-engineer-overrides.ts:19-25`), and the shortcuts below.
- Website: the Race Engineer page (`docs/actions/audio-voice/pit-crew.md`) gains a Sector comparison section, the pack reference regenerates, a `Features` changelog fragment.
- Rules: a #1572 entry in `race-engineer-callout-examples.md` (one progress step feeding two diffs, facts in the translator and policy in the catalog, a follower delayed past a same-tick leader and ordered behind it) and the `race-positions.md` consumer line.

## Approaches weighed and rejected

- **Regrouping into three sectors, or mini-sectors.** Settled by Niklas: the track's own sectors.
- **iRacing's own sector times.** None exist in the telemetry the SDK types; the player's `LapDeltaTo*` values say nothing about other cars.
- **A second diff reading `state.gapTraces`** to judge continuity by the identity of the last sample. It couples the sector timer to the trace's internal layout and repeats the gate; the progress step (decision 2) states both once.
- **Interpolating on the trace's own samples.** The samples are 0.002 lap apart, nearly two seconds through a slow corner at Le Mans (decision 3).
- **A tick timer with continuity rules of its own,** which would also work outside a race. Two definitions of "the car was absent" would drift. A future practice feature can follow the same shape over the track-order traces `diff/track-gaps.ts` keeps outside a race (#1515).
- **The reference and the pace gap in the translator.** A median, a window and a sum are policy, tuned with the thresholds beside them; the translator keeps the laps (decision 5).
- **A mean of the last few laps.** One traffic lap shifts a mean of three by a third; a median ignores it.
- **Relevance in the translator with a `sectorComparison.changed` event,** the #933 shape. "Changed since last spoken" has to be committed where the call is certain to play (#1137), and a translator that marks a picture when it emits drifts from what was heard whenever the bus drops a line, the #838 problem. The policy is also sim-agnostic, so a second sim's translator only has to supply the laps.
- **Ordering by registration in `registerPitCrew`.** It cannot order a fire against `fastestLap.set`, a different event published after `lap.completed` on the same tick; the delay can (decision 8).
- **Speaking every lap, or every lap a target is due.** Three targets and the lap-time calls would make the line a monologue; one call every other lap, on a change, is what the Goal asks for.
- **One combined lap-time and sector line,** or the sector call outranking the lap time (decision 8).
- **Naming every slower sector.** The Goal's recommendation, kept: one loss, one gain, "every sector" only when it is true of every sector of a track with three or more.
- **Gating clean laps on the player's `lapIsValid` and incident count.** Other cars have neither, and a comparison needs one rule for both sides (decision 4).

## Out of scope

- Practice and qualifying. Race only, as settled; #1573 covers practice and test with sector start calls.
- The sector parse, its cache and the sector clips, which are #1573's.
- Comparing with cars other than the class leader and the two class neighbours, and other classes.
- A delta to the player's own best or optimal sectors.
- A Session Info or key display of sector times. The reader makes one possible; it is not built here.
- Changing what the gap calls, the lap-time calls or the trace decide.

## Testing

**Unit tests, one per rule:**

- `iracing-sdk` `gap-utils.test.ts`: `appendProgressSample` returns `"appended"`, `"skipped"` under the minimum step and `"reset"` for a backwards step and for a step past 0.05 lap.
- `sim-events-iracing` `diff/car-progress.test.ts`: the gate returns `null` for each of its conditions; a valid tick returns every car's progress and a `null` for an invalid reading; `traceReset` is true exactly on a resetting sample. The existing `gaps.test.ts` passes unchanged on the extraction, the positive control that `diffGaps` decides nothing differently.
- `diff/sector-times.test.ts`, fed `CarProgressTick` values for a synthetic car with a known speed profile: constant speed gives exact sector times; a crossing interpolated inside a tick pair; a step across two boundaries; the start/finish crossing closing one lap and opening the next at the same time; `traceReset` and a `null` reading mid-lap each drop that lap; a tick pair over 0.25 s apart leaves the crossing unmeasured; each unclean cause (`OffTrack`, `InPitStall`, `AproachingPits`, `NotInWorld`, a caution tick, lap 1) records the lap with `clean: false`, each with its positive control, the same fixture without that tick recorded clean; eight laps kept; a replay wipe keeps completed laps and drops the lap in progress; a session change clears all.
- The comparison snapshot: targets and leader from the canonical order (a fixture where the overall order and the class order differ), the leader `null` when the player leads the class, the car number as the session spells it.
- `audio-scenarios` `sector-comparison.test.ts`:
  - the reference: the per-sector median of the last three clean laps among the last five, `null` with two, an older clean lap outside the five ignored;
  - every threshold on both sides of its value (0.10, 0.15, 0.20, 5 s, the 0.5 share, 3.0 s gap); "every sector" at three sectors and its two-sector fallback to "most of it"; one sector silent;
  - the order ahead, behind, leader; the leader skipped when the leader is the car ahead; two laps between calls; an unchanged picture silent, a new neighbour due, the leader repeating after eight laps and on a 0.3 s drift;
  - a voice that scripts only `-behind`: the behind call speaks on the lap it is due while the leader and the car ahead would also be due, and they never block it;
  - the claim made only in `speakGate` (a gate refusal leaves the spoken pictures untouched); the caution checked in `where:` and in the gate; race only; `wasCaution` and the race-finished latch; the player's unclean lap silent; a waiting call dropped once the next lap completes;
  - the order at the line on an idle bus: a `lap.completed` carrying `isClassFastestLapOfRace: true` followed on the same tick by its `fastestLap.set` plays the "yours" line first and the sector call after it; with the delay removed by hand the sector call goes first (the positive control); and on a held bus `queueBehind` keeps the sector call behind each of the three lap lines.
- `bundled-scripts.test.ts`, `script-coverage.test.ts`, `callout-settings-coverage.test.ts` and the settings baseline cover the scripts, clips and keys.

**Positive controls.** Each unclean-lap test has its clean twin, the gap tests guard the extraction, and the idle-bus order test has its no-delay twin. For the cadence, removing the two-lap spacing by hand must make the next lap's due target speak (checked once, recorded in the PR body). For the timer, the capture replay below must show sector sums matching lap times, or the interpolation test proves nothing about the sim.

**Harness shortcuts** (Harness → Sectors), each setting a composed comparison through the new override and publishing a clean race `lap.completed`: Leader pace, most of it with a gain; Leader pace, the most; Leader pace, every sector; Quicker than the leader; Chance on the car ahead; Car behind quicker; and a seventh pressing the same picture twice, where the second press is silent.

**The validation capture**, the issue's last task: `pnpm telemetry-watch` recording `CarIdxLapDistPct`, `CarIdxLapCompleted`, `CarIdxTrackSurface`, `CarIdxLastLapTime`, `SessionTime` and `SessionFlags`, with the session YAML, through an offline AI race of at least 15 laps at a track with three or more sectors. Replayed through the progress step and the timer it must show: each car's recorded sector times summing to its `CarIdxLastLapTime` within 0.02 s on clean laps (the resolution claim, and the sector frame); no lap lost at the start/finish line on a car that stayed on track (the wrap); and an AI car's off-track flagged as `OffTrack` (the clean-lap rule for remote cars). A failure of any of the three is a spec amendment before the PR.

**Manual offline-AI check.** In the same kind of race, driving: no sector call before lap 4; at most one every other lap, after the lap-time line; a deliberate slow sector two over three laps against the leader produces "Most of it is in sector two."; closing on a car ahead that is slow through one sector produces the attack call once, and not again until the picture changes; a pit stop lap and a caution lap produce none; each setting silences only its target.
