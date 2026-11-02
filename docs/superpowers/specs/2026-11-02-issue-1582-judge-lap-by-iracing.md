# Judge the player's lap the way iRacing does

> **Issue:** [#1582](https://github.com/niklam/iracedeck/issues/1582) · **Supersedes:** [the #1571 spec](2026-11-01-issue-1571-fastest-lap-of-the-race.md), decision 2 only · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `43d6ce38d`.

## The problem

`lap.completed` describes the player's lap with two verdicts of our own: `isBest` (`lapLastLapTime` against our own baseline, `packages/sim-events-iracing/src/diff/laps.ts:351-359`) and `lapIsValid` (all four `LapDeltaTo*_OK` flags true on the emit tick, `resolveLapIsValid`, `laps.ts:136`). Three callouts decide on them: #555's best-lap call, the #1571 fastest-lap judge (its decision 2: `lapIsValid` not `false`), and #572's "That lap didn't count" prefix on the qualifying position readout (`catalog/pit-crew/position.ts:278`). A lap iRacing refuses writes no time at all, so `diffLaps`, which waits for a positive `LapLastLapTime` (`laps.ts:307`), never emits for it.

Niklas (2026-11-02): "we must respect what iRacing deems as valid, and go with that. Otherwise we'll be out of sync with iRacing when looking at results, comparing lap times, etc." Every verdict the Race Engineer gives on a lap must therefore equal iRacing's own.

## What the capture shows

The capture is two `pnpm telemetry-watch` recordings driven by Niklas on 2026-11-02 (`local/telemetry-watch-20261102-191409-398.jsonl` for practice, `local/telemetry-watch-20261102-192853-241.jsonl` for qualifying and the race). The fixtures are cut from them (Testing). Across 14 timed crossings it shows:

- **A refused lap reads `LapLastLapTime = -1`**, and so does `CarIdxLastLapTime[player]`. This happened on the qualifying cut lap and the race cut lap. The best does not move. Across all 14 crossings, the lap time (or the -1) lands between 0.03 and 1.00 s after `LapCompleted` moves; the longest is race lap 1.
- **The flags do not say whether the lap counted.**
  - On the race's cut lap all four read true.
  - All four read false on pit road, so a counted lap crossed on pit road read invalid.
  - On an out lap they come on one at a time, before any best exists, so the first timed lap of a stint often reads invalid.
  - They say whether a delta reference exists and the car is on track.
- **Off-track laps count** in practice (two 1x laps both became the best).
- **The race start lap gets a time but no best** (`LapBestLapTime` stays -1 after it). Today it is called `isBest` and `isFirstValid`.
- **The best moves on the same tick as the lap time.** On every crossing that set a best (nine of them), `LapBestLap`, `LapBestLapTime`, `CarIdxBestLapTime[player]` and `CarIdxBestLapNum[player]` all change on the tick `LapLastLapTime` refreshes. `LapBestLap` names the lap that set it.

## Decisions

### 1. `isBest` is iRacing's best

On the emit tick, `isBest` is true exactly when iRacing's best moved to this lap: `LapBestLap` equals the lap just completed and `LapBestLapTime` is positive. `bestLapTime` is `LapBestLapTime` when positive. `previousBestLapTime` and `isFirstValid` come from the baseline `diffLaps` keeps of iRacing's best before this lap. `isFirstValid` is `isBest` with no positive baseline, so a race's first best (lap 2 in the capture) is still the first. The baseline follows iRacing's value after each emit, not our own comparison.

There is no wait for the best. The capture shows it moving on the same tick as the lap time on all nine crossings that set a best, and the emit already waits for the standings (`LAP_RESULTS_SYNC_MAX_WAIT_MS`). A wait could not tell "not yet" from "not a best" anyway, since a lap that does not set a best never moves it. Should a future sim build lag it, the cost is a best lap announced as an ordinary lap, never a wrong best.

The race start lap is therefore not a best. #555 says nothing for it, and the lap goes to #1163's every-lap call, by the existing precedence (#1571 decision 7).

### 2. The fastest-lap judge requires `isBest` (replaces #1571 decision 2)

The player's lap is a candidate for the record only when `diffLaps` has judged it `isBest`. Every fastest lap of the race is a personal best, so this asks exactly "did iRacing count it". Everything else in #1571 decision 2 stands: the shared eligibility predicate, below the record, the claim published later in the same tick, and the narrow judge `handleTick` hands `diffLaps`. Only the third argument goes: `FastestLapJudge` becomes `(lap, lapTime) => boolean`, called once for each emitted lap that is a new best and never otherwise, so validity is decided in one place. The pairing rule of #1571 decision 3 is unchanged.

The hold of #1571 decision 1 ends when `diffLaps` emits for the crossing. A refused lap now emits (decision 3), so it ends the hold too, instead of waiting out the 5 s cap.

### 3. A refused lap emits `lap.completed` with `lapIsValid: false`

`lap.completed` becomes a union on `lapIsValid` in `packages/event-bus/src/event-catalog.ts`:

- **Counted:** as today, `lapTime: number`, with `lapIsValid?: true`. The optional `true` keeps every existing payload valid.
- **Refused:** `{ lapIsValid: false; lapTime?: number; isBest: false; isFirstValid: false }`, never `isClassFastestLapOfRace`. `lapTime` is present when a sim reports a time for a lap it did not count; iRacing reports none, so its translator omits it. The standings fields, `bestLapTime` / `previousBestLapTime` (the standing best), the session fields, `wasCaution` and the pit-lap flags are carried as on a counted lap.

A reader that speaks or compares a lap time narrows on `lapIsValid`, never on whether `lapTime` is present, so a sim that reports a time for a refused lap cannot have it read out as a lap. The union is what makes the compiler find every such reader.

The whole `lap.completed` doc block is rewritten in sim-neutral terms: one event per lap the player completes, counted or refused; `isBest` is the sim's own best moving to this lap; `isFirstValid` marks the first lap of the session to set a sim best; `previousPosition` is the position the session's previous `lap.completed` carried, counted or refused. It names no iRacing field. The iRacing mapping (a refused lap is `LapLastLapTime === -1`, the best is `LapBestLap` / `LapBestLapTime`) is documented in the `laps.ts` header, and nowhere in the catalog.

**Detection, in `diffLaps`.** The crossing state lives in one nested `lapCrossing` slice of `TranslatorState`, created in `createInitialState` and reset by the session-change block. That is #1588's convention, applied where this change touches the fields anyway. The slice holds:

- the crossing's lap (today's `lapCrossLap`);
- whether it was made under the checkered (today's `lapCrossUnderCheckered`);
- the crossing time;
- the `LapLastLapTime` read on the crossing tick.

The rules:

- **Counted:** unchanged. A positive `LapLastLapTime` that differs from the last emitted one.
- **A crossing:** `LapCompleted` moves above the last emitted counter, to at least 1.
- **Refused:** after a crossing, `LapLastLapTime` either changes to -1 from the value recorded at the crossing, or still reads that recorded -1 `LAP_TIME_REFRESH_ALLOWANCE_MS` (2000 ms) after the crossing. The second case is a lap after a refused one.
- **Why the recorded value, not `lastEmittedLapTime`:** the seed and the session reset clamp a -1 to 0 (`laps.ts:186`, `:279`), which would read a standing -1 as a fresh change and emit twice.
- **Why the wait:** after a refused lap, the next counted lap still shows the old -1 until its own time lands. The longest refresh in the captures is 1.00 s, so 2 s is twice that.
- **The constant:** it moves from `fastest-lap.ts` into `laps.ts`, so the hold and this wait share one allowance. `fastest-lap.ts` already imports from `laps.ts`, which must not import it back (#1571 decision 2). Its doc changes with it, since `diffLaps` now bounds the refresh wait.
- **At most one `lap.completed` per counter value:** a positive time that lands for a counter already emitted as refused is dropped, with a debug line.
- **Not refused:** a `0`, which the green and pit-exit crossings (`lap: 0`) read. A reset to the pits (the counter dropping to 0 for a tick, then back) is not a crossing. A seed emits nothing, whatever value it reads.
- **After a refused emit:** the lap goes through the same standings wait, position fields, position-change and cadence logic, and race-end detection as a counted one.

`resolveLapIsValid` and the `LapDeltaTo*_OK` reads are removed. Nothing else reads the flags.

### 4. The consumers

- **#572** (`position.ts`, the `invalid-lap` shape) now fires on the laps iRacing refused in qualifying, and no longer on counted laps the flags misread. It is a shipped callout that never fired as designed.
  - **A refused lap with no position.** A refused first qualifying lap has no position yet: the standings carry no row for a driver with no counted lap. Before this change the `where:` refused any lap with no position, and the line's `{{position.number}}` is required, so nothing would have played. Niklas (2026-11-02) chose to say the first sentence alone: on a refused qualifying lap the `where:` passes with or without a position, and both voices' scripts wrap the "We're currently" + `{{position.number}}` tail in an `optional` group. With a position the full line plays as before. With none, "That lap didn't count." plays alone. It is the existing `position-invalid-lap/that-lap-didnt-count` clip, so there is no new clip and no generation. A counted lap with no position still does not fire.
- **#555 and #1163** (`lap-time.ts`): a refused lap has no time, so neither speaks for it. `playerLapOwner` returns `null` for it.
  - The `lapTime.wasInvalid` condition keeps its name, since pack scripts reference it, and its description now says a refused lap carries no time, so the every-lap call never speaks one. It can no longer be true where that call reads it, and no shipped pack uses it to speak.
- **Race status and position change** count a refused lap like any other. Today a refused lap is missing from the cadence and from the position diff.
- **Race end** fires on a refused last lap. Today it waits for a later crossing that a cool-down lap into the pits may never bring.
- **#1213** (spec on `master`, not implemented) assumes a `lap.completed` for the invalidated qualifying lap. Until this change that lap emitted none, so this change is what makes its trigger real.
- **The readers of `lapTime`, which narrow on `lapIsValid`:**
  - the cache, `race-engineer-wiring/src/caches.ts:39`;
  - `lap-time.ts`: the #555 vars (`:125-175`), the every-lap vars (`:193-221`) and the `where:`s at `:321` and `:370`;
  - `playerLapOwner` in `lap-announcement.ts`, and the owner resolver in `catalog/pit-crew/index.ts`;
  - the harness, `scenario-harness` `event-names.ts:332` and `scenario-shortcuts.ts`, which gains a refused-lap shortcut beside the existing `lap.completed` ones;
  - the regenerated `pack-reference.json`, for the `lapTime.wasInvalid` description.
  `pit-lap.ts`, `overtakes.ts` and `session-limit.ts` only mention the event and are unchanged.

## Approaches weighed and rejected

- **Keep refused laps silent, and make `lapIsValid` "iRacing wrote a time".** Smaller, but #572's prefix could then never fire, and a refused lap would stay missing from the cadence and from race end. Rejected (PO, 2026-11-02): #572 is a shipped callout, and making it work as designed is the bug fix.
- **`lapTime: -1` on a refused lap.** It keeps the type but hands every reader a number to misread. A lap-time readout of "minus one" is exactly the failure the union stops at compile time.
- **A separate `lap.refused` event.** A second event for one lap would split the position, cadence and race-end logic that hangs off `lap.completed`, and #1213's trigger with them.
- **Waiting a bounded time for the best after the lap time.** The capture shows it is not needed, and a wait cannot tell a slow best from no best.
- **Judging the player from `CarIdxBestLapTime[player]`**, as for the other cars (#1571's rejected approach). This is the same value: it moves on the same tick as `LapBestLapTime` in the capture. Reading `LapBestLap` / `LapBestLapTime` keeps `diffLaps` on the player's own fields.

## Out of scope

- Remote cars' laps. #1571 decision 1 already reads each car's own `CarIdxBestLapTime`, which is iRacing's verdict. The capture's AI data is available should decision 1's open capture questions need it.
- New speech for a refused lap (an every-lap "that one didn't count", say): no new line or clip in 3.8.1.
- #1213 itself, and the qualifying-invalidation callout (#567), which keys on incidents, not on `lap.completed`.
- The replay recorder's lap stream (`diff/replay-laps.ts`).

## Testing

- **Fixtures cut from the capture.** The player's fields per tick, from each of the three sessions, as `sim-events-iracing` test fixtures. Replayed through `diffLaps`, they must produce:
  - practice: every lap `isBest` exactly when iRacing's best moved, including both off-track laps, and the pit-road crossing counted with `lapIsValid` true;
  - qualifying: the cut lap as a refused `lap.completed` (`lap: 1`, `lapIsValid: false`, no `lapTime`), then two counted bests;
  - race: lap 1 counted but not a best (`isBest`, `isFirstValid` false), laps 2 and 3 bests (lap 2 the first), and lap 4, the cut lap, refused. Niklas counts the start lap separately, so his "cut on lap 3" is lap 4 by the counter; the plugin log of the same session agrees.
- **Unit tests, `laps.test.ts`:**
  - two refused laps in a row emit two refused events;
  - a counted lap after a refused one, its time landing 0.9 s after the crossing, emits as counted and not as refused;
  - a value still -1 at 2 s emits refused, while one that turns positive at 1.9 s emits counted;
  - a positive time landing at 2.1 s, for a counter already emitted as refused, emits nothing more;
  - a session change inside the 2 s window clears the pending crossing;
  - a `0` after a `lap: 0` crossing emits nothing;
  - a reset to the pits (the counter dropping to 0 for one tick, then back) emits nothing;
  - a seed on -1 emits nothing, and a counted lap whose time lands 0.9 s after the next crossing then emits once, as counted;
  - the refused payload carries positions, cadence and race end;
  - the positive control: the same ticks with a positive time emit counted.
- **The judge, `fastest-lap.test.ts` and `translator.test.ts`:**
  - the race start lap faster than the record claims nothing;
  - a refused lap claims nothing, and its emit ends the hold;
  - a new iRacing best below the record claims it;
  - the #1571 pairing tests run unchanged.
- **The consumers, audio-scenarios:**
  - `position.ts` gives the `invalid-lap` shape on a refused qualifying lap and not on a counted lap with false flags. A refused qualifying lap with no position fires and expands to the that-lap-didnt-count clip alone; with a position it expands to the full line; a counted qualifying lap with no position does not fire (the positive control);
  - neither lap-time contract speaks on a refused lap;
  - `playerLapOwner` returns `null` for it;
  - race status counts it.
- **Manual (Niklas):** an offline qualifying session with a cut lap first. Expected:
  - the engineer says "That lap didn't count." alone (a first lap has no position yet), and on a later refused lap the same sentence followed by the position;
  - on the next clean lap, the best-lap call;
  - in a race, no best-lap call on lap 1, the best-lap call on lap 2, and no lap-time call on a cut lap.
