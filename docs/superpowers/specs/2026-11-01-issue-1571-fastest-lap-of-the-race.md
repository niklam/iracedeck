# Fastest lap of the race

> **Issue:** [#1571](https://github.com/niklam/iracedeck/issues/1571) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `3e40a7f4f`.

## The problem

The Race Engineer reads out the driver's own best lap (#555, `packages/audio-scenarios/src/catalog/pit-crew/lap-time.ts:206`) and, with #1163, every lap. Nothing in the translator or the catalog knows what the fastest lap of the race is, so the engineer cannot say that the driver holds it, that another driver took it, or who set it. The issue's Goal settles the product (race only, the player's class, a grace at the start, "took it from you", "with a", the existing lap-time clips, one setting, worked with #1163). This spec settles how: where the record comes from, the event that carries it, how the line is chosen when it speaks, and how the three lap-time callouts agree that exactly one of them speaks for the driver's lap.

## Decisions

### 1. The record comes from per-car telemetry, `CarIdxBestLapTime`, for every car but the player

The iRacing SDK exposes `CarIdxBestLapTime`, `CarIdxBestLapNum` and `CarIdxLastLapTime` per car (`packages/iracing-native/src/defines.ts:698-700`), and the translator already reads the first and third (`resolveLeaderLapTimeS`, `packages/sim-events-iracing/src/translator.ts:1648`). A new live diff, `diff/fastest-lap.ts`, keeps the race's class record in `TranslatorState`: the fastest time, the car holding it and whether that car is the player's. For every car in the player's class except the player, it keeps a per-car baseline of `CarIdxBestLapTime` and, when a car's value falls to a new positive value below the record, that car holds the record.

Why this field rather than the alternatives in "Approaches weighed": a car's best lap is the sim's own judgement of which of that car's laps count, so the record the engineer speaks is the record the sim's own timing would show, whatever the sim decides about a lap it does not count. It is in every tick, so it costs no session-info read and none of the 1–3 s session-info lag `diff/laps.ts` documents (`LAP_RESULTS_SYNC_MAX_WAIT_MS`, `packages/sim-events-iracing/src/diff/laps.ts:105`). And it is a minimum the sim keeps per car, so a remote car's lap run while the translator was not looking (a replay glance, a reconnect) is never left out of the record: the next eligible tick reads the values as they stand.

The rules of the scan, each stated because a tick can carry something the record must not take:

- **A value that is not positive never changes a baseline or the record.** iRacing writes `-1` (or `0`) for "no time yet" (the #1264 spec's reading); a car that leaves the world keeps its baseline and, if it holds the record, keeps the record. The record of the race only ever falls inside a race session. A lap already run does not stop being the fastest because the car that ran it has gone.
- **One eligibility predicate decides which laps can enter the record, for the scan and for the player alike** (`isEligibleRecordLap` in `fastest-lap.ts`, which `resolvePlayerFastestLap` in decision 2 calls too): a race session, past the green (`isPreGreen(telemetry)` false), the car's completed-lap count at least 1, and a positive time. On a rolling start `CarIdxLastLapTime` is the parade lap (`translator.ts:1625-1632`), and whether `CarIdxBestLapTime` carries it into lap 1 is unknown (the #1264 spec's open question). A parade lap is minutes long, so it could never be the minimum of a real field, but excluding it costs nothing and removes the question. The count matters for the player too: `diffLaps` bails only on `LapCompleted < 0` (`diff/laps.ts:250-255`), so it can emit a `lap.completed` with `lap: 0` for a rolling start's parade crossing, and that lap must never become the record.
- **The lap that set it is the car's `CarIdxLapCompleted` on the tick its best changed.** The best refreshes after the crossing, as `CarIdxLastLapTime` does a tick or two after the counter moves (`diff/replay-laps.ts:22-33`), so the counter already names the lap just completed.
- **Two cars lowering the record on one tick produce one event**, for the faster of them: the newest number, never a burst (the #480/#666 rule).
- **The pace car is skipped** (`resolvePaceCarIdx`), and so is every car of another class (`CarIdxClass[c] !== CarIdxClass[player]`). A single-class race is the whole field.
- **The first eligible tick of a connect or a session seeds silently**: the record is the minimum eligible `CarIdxBestLapTime` over the class, the player's car included on this first seed only, and every baseline is the value it holds. A connect mid-race and the first tick after the green seed rather than announce.
- **The record survives a replay glance; the baselines do not.** The record (its time, the holder's `carIdx`, whether the holder is the player, the holder's car number) joins the PRESERVED set of `wipeStateForReplay` (`translator.ts:2042-2120`, beside the opponent-pit and opponent-flag episode state), and only the per-car baselines are wiped. Re-deriving the record from the sim after a glance would lose it whenever its holder had left the world meanwhile (its value then reads `-1`), and the re-seeded, slower record would let a later lap that never beat the real one be announced as the fastest of the race. The first live tick after the glance re-seeds the baselines and silently absorbs any remote car whose best is now below the kept record (it becomes the holder, with no event: the lap was run while nobody was watching). The player's `CarIdxBestLapTime` is not read on a re-seed: the player's laps reach the record through decision 2 only. The cost, accepted: `wipeStateForReplay` also resets `lapCompletedInitialized`, so a lap the player finishes while the replay view is open emits no `lap.completed` and never reaches the record, and a slower remote lap after it could be announced as the fastest of the race. Confirmed by Niklas on 2026-11-01: the player cannot complete a lap while the replay view is open ("Another driver can, sure. But I can't."), so the cost does not arise. Another car can, and its lap reaches the record silently through the re-seed absorb above. Everything is reset per session (`resetPerSessionState`) and at a disconnect.
- **Race sessions only, live ticks only.** The diff runs after the replay guard, so a replay never reaches it, and it emits nothing outside a race (the `diffOpponentPit` shape, `translator.ts:2843`). It needs the canonical order for the payload's positions, so it runs after `resolveCanonicalOrder` (`translator.ts:2787`), beside the opponent diffs.

What is not shown by anything in the repo, and the capture that confirms it: how soon after a crossing `CarIdxBestLapTime` refreshes for a remote car, whether it takes a lap the sim does not count (a track-limits cut in a race), whether `CarIdxBestLapNum` agrees with `CarIdxLapCompleted` on that tick, and what a departed car's value reads. One `pnpm telemetry-watch` recording of an offline AI race, with the player running at least one cut lap and one clean fast lap and an AI car retiring, over `CarIdxLapCompleted`, `CarIdxLastLapTime`, `CarIdxBestLapTime`, `CarIdxBestLapNum`, `CarIdxTrackSurface`, `CarIdxClass`, `LapCompleted`, `LapLastLapTime`, `LapBestLapTime`, the four `LapDeltaTo*_OK` flags and `SessionState`, settles all four; the first task of the implementation records it and cuts a fixture from it. The model is decided now: should the capture show the best refreshing late or not at all for remote cars, the remote trigger becomes the crossing-paired `CarIdxLastLapTime` wait `diff/replay-laps.ts` already runs, and nothing past the diff changes.

### 2. The player's lap is judged on the tick `lap.completed` is emitted, from that payload

The player's car is never taken from the scan. Its candidacy is decided by `resolvePlayerFastestLap` in `fastest-lap.ts`: the lap is a new record when it passes the eligibility predicate of decision 1 (so a `lap: 0` parade crossing is refused), `lapIsValid` is not `false`, and the time is below the record. It updates the record to the player and leaves a claim for `diffFastestLap` to publish later in the same tick, and the payload carries the result (decision 3).

`diffLaps` reaches it only through a narrow judge `handleTick` hands it, `(lap, lapTime, lapIsValid) => boolean`, closed over `fastest-lap.ts` and the tick's state, session type and telemetry. `laps.ts` never imports the fastest-lap module and never writes its fields; only `fastest-lap.ts` reads or writes the record and the claim. `diffFastestLap` publishes or clears the claim on every live tick, before any gate of its own (the race and pre-green returns included), so a claim can never survive into a later tick and be published for a lap it no longer belongs to.

The reason is the precedence in decision 7. #555 and #1163 decide on `lap.completed`, so whether the player's lap is the fastest of the race has to be known by then, on that payload, not on a later tick when `CarIdxBestLapTime[player]` happens to refresh. Judging the player from `LapLastLapTime` (what `lap.completed.lapTime` is, `diff/laps.ts:1-12`) also means the time spoken is the time #555 would have spoken. The cost is that the player's lap is judged by `lapIsValid` rather than by the sim's per-car best; the capture in decision 1 says whether the two ever disagree. When `CarIdxBestLapTime[player]` later refreshes to the same value, nothing happens, since the player is not scanned.

### 3. One bus event, `fastestLap.set`, and one field on `lap.completed`

The catalog (`packages/event-bus/src/event-catalog.ts`) gains:

```typescript
/**
 * A new fastest lap of the race in the player's class (issue #1571): a car,
 * the player's included, completed a lap faster than any lap run in that
 * class so far in this race. Race sessions only, never pre-green, never in a
 * replay. Emitted for every new record, the first laps of the race included:
 * which records are worth saying is the audio layer's decision. A
 * single-class race is one class. `position` and `playerPosition` are the
 * effective positions (class positions in a multi-class race) at emit time;
 * consumers prefer a live speak-time read and use these as the fallback, in
 * the projection `isMultiClass` records. `playerLapsCompleted` is how many
 * laps the player had completed when the record fell.
 *
 * Pairing rule, kept by every translator: every `lap.completed` carrying
 * `isClassFastestLapOfRace` is paired with exactly one `fastestLap.set` with
 * `isPlayer: true` and the same `lap`, and no `fastestLap.set` with
 * `isPlayer: true` is published without that `lap.completed`. The order of
 * the two on the bus is not guaranteed.
 */
"fastestLap.set": SimEvent<
  "fastestLap.set",
  {
    carIdx: number;
    isPlayer: boolean;
    /** The car's completed-lap count after the lap that set the record. */
    lap: number;
    /** Seconds. */
    lapTime: number;
    /** The record this one beat; absent for the first timed lap of the class. */
    previous?: { carIdx: number; lapTime: number; isPlayer: boolean; carNumber?: string };
    /** The car's number as the session info spells it; absent when it has no row. */
    carNumber?: string;
    position?: number;
    playerPosition?: number;
    playerLapsCompleted: number;
    isMultiClass?: boolean;
  }
>;
```

and `lap.completed` gains `isClassFastestLapOfRace?: true`, documented as:

```typescript
/**
 * In the player's class, this lap set a new fastest lap of the race
 * (issue #1571). Race sessions only; only ever present as `true`.
 *
 * Pairing rule, kept by every translator: a `lap.completed` carrying this
 * field is paired with exactly one `fastestLap.set` with `isPlayer: true`
 * and the same `lap`, and no `fastestLap.set` with `isPlayer: true` is
 * published without it. The order of the two on the bus is not guaranteed.
 */
isClassFastestLapOfRace?: true;
```

Only ever present as `true`, like `wasCaution` (`event-catalog.ts:1012`), so every consumer that predates it reads exactly what it did. The class scope is in the name because the name cannot change once it ships. The pairing rule is written into both doc comments because the precedence (decision 7) decides on the field and the `yours` line speaks on the event, so a translator that broke the pair would leave the lap unspoken or spoken twice.

The event is truth, not policy, so a second sim's translator can emit it from whatever its sim offers: it says a record fell, for whom, in what time, beating whom. Nothing in it says whether to speak. The class scoping is in the event rather than in the consumer because the player's class is the only class any consumer asks about, the reasoning the #1264 spec gives for its `fastest` prefix. That prefix is not this record and the two can name different cars, deliberately: the prefix reads the lowest positive `CarIdxBestLapTime` in the class as it stands, while this record keeps a holder who has left the world (decision 1) and judges the player by `lapIsValid` on `lap.completed` rather than by the player's per-car best (decision 2). `carIdx` is the catalog's existing car identity (`opponentPit.entered`, `opponentFlag.flagged`).

The player's event is published right after `lap.completed` on the same tick: `diffFastestLap` runs after `diffLaps` (`translator.ts:2677`) and the pending batch flushes in call order. `TICK_ORDER` gains its row (`via: "pending"`, `FASTEST_LAP_EVENTS`), and `tick-order.test.ts` its spy line. That order is this translator's, not the rule: the precedence reads the `lap.completed` field and the `yours` line its own event, so neither depends on which arrives first.

### 4. One callout, one contract, the line chosen when it speaks

One contract, `pit-crew.fastest-lap-race`, in a new family file `catalog/pit-crew/fastest-lap.ts`, `family: "fastest-lap"`, triggered by `fastestLap.set`. Its `where:` is pure and reads, in order:

1. the master gate and the opt-in (the usual wrappers);
2. the grace, through `fastestLapAnnounceable(data.lap, enabled)` (decision 5), the one predicate `playerLapOwner` also calls;
3. not under a full-course caution (`getUnderFullCourseCaution`), the #1127 rule that the caution sequence owns the radio while the yellow is out;
4. not after the player's own finish (`getRaceFinishedFired`), the #569 rule that race-end has the floor.

The line is a declared-key `case`, `fastestLap.holder`, resolved at speak time from the fire's own payload (`ctx.data`, the #1274 shape, never a module stash). Its keys, in the order they win:

| Key | When | Why it wins over what follows |
| --- | --- | --- |
| `yours` | `isPlayer` | It is about the driver's own lap. |
| `taken-from-you` | `previous.isPlayer` | The driver just lost something; who took it matters less than that it is gone. |
| `leader` | the car's live effective position is 1 | The issue's own rule: the car ahead or behind is named as such only "when it isn't the leader". |
| `ahead` | the car's live effective position is the player's minus one | |
| `behind` | the car's live effective position is the player's plus one | |
| `other` | anything else | |

`yours` and `taken-from-you` read only the payload, which cannot change. The other four read positions live, from the canonical order through the existing `SimRuntime` reads, `getLiveCarPosition(carIdx)` and `getLivePosition()` (`packages/race-engineer-wiring/src/sim-runtime.ts:76-80`), in the payload's projection (`isMultiClass`: class positions in a multi-class race, overall otherwise), falling back to the payload's `position` and `playerPosition` when either live read is unknown. That makes "ahead" and "behind" the race neighbours in class, per `race-positions.md`, never the car physically ahead on track; a car that is a race neighbour while a lap ahead or behind is still that neighbour. The live read wins because a fire can wait, and by then the car may no longer be the neighbour it was.

The vocabulary, every name read off the fire's payload or live state at speak time:

- `fastestLap.holder` — the case above.
- `fastestLap.carNumber` — `pool:car-number/<carNumber>`, as `opponentFlag.carNumber` does (`catalog/pit-crew/opponent-flags.ts:146-150`); nothing when the payload has no number, which aborts a line that needs it (#835), never a half line.
- `fastestLap.previousCarNumber` — the same for the beaten holder, published for packs; the bundled scripts do not use it.
- `fastestLap.position` — `pool:position-number/<n>`, live then payload, as `opponentFlag.position` resolves.
- `fastestLap.clock` — the minutes and seconds as one clip at the tenth, `lap-time-clock/<m>m<ss>`, or `lap-time-second/<s>` under a minute (decision 6).
- `fastestLap.decimal` — the tenths tail `lap-time-tenths/<d>`, or its `<d>-gap` take exactly when the gap clause speaks, decided by the same check as the gap vars so the two cannot disagree.
- `fastestLap.yoursLine`, `fastestLap.leaderLine`, `fastestLap.aheadLine`, `fastestLap.behindLine`, `fastestLap.otherLine` — each holder's line in the take cut for the onset sound of the time after it (the #1163 spec, "The readout"). The taken-from-you line is one take followed by a pause, so the script names its pool directly.
- `fastestLap.gapIntro`, `fastestLap.gapSecond`, `fastestLap.gapDecimal` — the gap readout for `ahead` and `behind` only: `getLiveGaps()`'s side for the holder's key, resolved only when that side's car is this fire's car, on the same lap, under a minute; the three resolve on one check so the clause is spoken whole or not at all. This is the rule `resolveSpeakableGap` already applies (`catalog/pit-crew/gaps.ts:199-224`), extracted into one pure function both families call rather than copied, and it draws from the same groups the gap readout does (`gap/readout-intro`, `lap-time-second`, `lap-time-decimal`, `gaps.ts:248-279`).

The default script's shape:

```json
"pit-crew.fastest-lap-race": {
  "comment": "A new fastest lap of the race in our class, from lap 3 on: the line names whose it is (ours, taken from us, the leader, the car in front or behind with the gap, or any other car by number and position), then the time as one clock phrase and the tenths.",
  "test": "Harness → Fastest Lap → Yours (Taken from you, Leader, Car ahead, Car behind, Other car for the other lines). In-sim: an offline AI race; set the fastest lap of the race from lap 3 on, or let an AI car beat it.",
  "sequence": [
    { "case": "fastestLap.holder", "of": {
      "yours": ["{{fastestLap.yoursLine}}"],
      "taken-from-you": ["{{fastestLap.carNumber}}", "pool:fastest-lap/taken-from-you", "pause:150"],
      "leader": ["{{fastestLap.leaderLine}}"],
      "ahead": ["{{fastestLap.aheadLine}}"],
      "behind": ["{{fastestLap.behindLine}}"],
      "other": ["{{fastestLap.carNumber}}", "pool:fastest-lap/in", "{{fastestLap.position}}", "{{fastestLap.otherLine}}"]
    } },
    "{{fastestLap.clock}}",
    "{{fastestLap.decimal}}",
    { "optional": ["{{fastestLap.gapIntro}}", "{{fastestLap.gapSecond}}", "{{fastestLap.gapDecimal}}"] }
  ]
}
```

The case has no `default`: the resolver always answers a key when the fire has a `fastestLap.set` payload, and without one the required `fastestLap.clock` resolves to nothing and aborts the whole line, so the time is never spoken alone. A pack may collapse keys onto one line (the Short Calls voice maps `other` without the position). `FASTEST_LAP_CLIP_SOURCES` lists the `fastest-lap` group's bases.

One contract rather than one per variant, because the variants differ only in what is said: they share the setting, the family, the scheduling and the drop rule, and a pack that wants fewer lines collapses keys in its own script instead of omitting contracts. Splitting `yours` off for a higher weight was weighed and not needed: decision 8 gives the one contract the weight #555 has.

### 5. The grace counts each car's own completed laps

"Silent through the first two laps" means: a record set on a car's own first or second completed lap is never announced, whoever's car it is. A lap is announceable when the `lap` in the payload, that car's completed-lap count after the lap, is 3 or more. The record still takes the laps inside the grace, silently, so the first call of the race is a lap that beat everything run so far.

The grace is one exported predicate in `lap-announcement.ts`, `fastestLapAnnounceable(lapCount, enabled)`, which holds `FASTEST_LAP_GRACE_LAPS = 2` and answers `enabled && lapCount > FASTEST_LAP_GRACE_LAPS`. The fastest-lap `where:` and `playerLapOwner` (decision 7) both call it, so the lap the fastest-lap call refuses is exactly the lap it hands to #555.

Each car's own count rather than the leader's, because the noise the grace exists to stop is the field's opening laps lowering the record one car after another. Counted on the leader, the moment the leader starts lap 3 every car still finishing its own lap 2 behind could lower the record once more, and each would be a call. Counted per car, those laps are inside every car's own grace. A car's count can never exceed the leader's, so this grace is at least as long as the leader's for every car and only longer for cars behind. It applies to the player too: on the player's lap 1 or 2, a fastest lap is spoken by #555 as a best lap (decision 7).

### 6. The time readout is #1163's compact form, to the tenth

Decided by Niklas on 2026-11-01 ("Let's do compact clips"): the fastest-lap call reads the time the way a timing screen does, "one twenty-three point four", not #555's "one minute, twenty-three, point four seconds". It rounds once to the tenth, the precision a broadcaster gives a fastest lap. A lap of eleven minutes or more has no minute clip and aborts, the ceiling #555 has.

The clips are the compact set #1163 adds (the #1163 spec, "The readout", which defines the groups and how each is conditioned). This call speaks the clock phrase (or, under a minute, the seconds) and the tenths tail; #1163 uses the thousandths instead. Both calls ship in one change, so the set is generated once.

The split and the pool references live in a shared `catalog/pit-crew/lap-time-readout.ts`, which the `lapTime.*` vars (over the `lap.completed` snapshot) and the `fastestLap.*` vars (over the fire's payload) both call, so no two calls round the same lap differently. #555's best-lap call keeps its own full sentence ("one minute, twenty-three, point four seconds"), now also through that module.

New clips, one group `fastest-lap` in each first-party voice. **The wording is a draft and needs Niklas's approval before any clip is generated** (`issue-workflow.md`, step 4). No line carries a hyphen, dash, ellipsis, colon or semicolon (#1518).

Default voice:

| Clip | Text | Spoken with the time, for a 1:23.4 lap |
| --- | --- | --- |
| `fastest-lap/yours-01` | That's the fastest lap of the race. | That's the fastest lap of the race. One twenty-three point four. |
| `fastest-lap/taken-from-you-01` | just took the fastest lap from you. | Car five just took the fastest lap from you. One twenty-three point four. |
| `fastest-lap/leader-01` | The leader just set the fastest lap of the race with a | The leader just set the fastest lap of the race with a one twenty-three point four. |
| `fastest-lap/ahead-01` | The car in front of you just set the fastest lap with a | The car in front of you just set the fastest lap with a one twenty-three point four. Gap is one, point two seconds. |
| `fastest-lap/behind-01` | The car behind you just set the fastest lap with a | The car behind you just set the fastest lap with a one twenty-three point four. Gap is one, point two seconds. |
| `fastest-lap/in-01` | in | Car five in |
| `fastest-lap/other-01` | just set the fastest lap of the race with a | Car five in pee six. Just set the fastest lap of the race with a one twenty-three point four. |

Short Calls voice (the Terse pack):

| Clip | Text | Spoken with the time |
| --- | --- | --- |
| `fastest-lap/yours-01` | Fastest lap, yours. | Fastest lap, yours. One twenty-three point four. |
| `fastest-lap/leader-01` | Fastest lap for the leader. | Fastest lap for the leader. One twenty-three point four. |
| `fastest-lap/ahead-01` | Fastest lap for the car ahead. | Fastest lap for the car ahead. One twenty-three point four. Gap is one, point two seconds. |
| `fastest-lap/behind-01` | Fastest lap for the car behind. | Fastest lap for the car behind. One twenty-three point four. Gap is one, point two seconds. |
| `fastest-lap/for-01` | Fastest lap for | Fastest lap for car five. One twenty-three point four. |
| `fastest-lap/lost-to-01` | Fastest lap lost to | Fastest lap lost to car five. One twenty-three point four. |

The Short Calls script maps `other` to `["pool:fastest-lap/for", "{{fastestLap.carNumber}}"]` and `taken-from-you` to `["pool:fastest-lap/lost-to", "{{fastestLap.carNumber}}"]`. Both voices' car numbers come from their own `car-number` group and the default voice's position from `position-number` ("pee six.", the clip `opponent-pit/is-pitting` already follows, so the splice after it has a precedent). Each intro that leads into the time is generated with a `next_text` of a sample time ("one twenty-three point four"), so it ends on a rising, continuing note rather than a sentence-final fall; each tail after a car number keeps `previous_request_ids` on `car-number/42`, as the opponent-flag tails do. The gap clause keeps the gap readout's own clips.

### 7. Exactly one of the three lap-time callouts speaks for the player's lap

On a lap the player completes, at most one of `pit-crew.fastest-lap-race` (its `yours` key), `pit-crew.lap-time-best` (#555) and `pit-crew.lap-time-last` (#1163) speaks, in that order of precedence. The rule is one pure function in a module all three families import, `catalog/pit-crew/lap-announcement.ts`:

```typescript
type PlayerLapOwner = "fastest-lap" | "best-lap" | "every-lap" | null;

function playerLapOwner(lap: LapCompletedSnapshot, on: { fastestLap: boolean; bestLap: boolean; everyLap: boolean }): PlayerLapOwner;
```

Each `on.*` is that callout's opt-in AND the active voice scripting its contract (`engine.isScripted(<contract id>)`, the spotter's precedent, `interpreter.ts:345-352`), for every tier, so a pack that leaves out any one of the three lines hands the lap to the next instead of leaving it unsaid: a pack that scripts `lap-time-last` but not `lap-time-best` still hears every lap.

- **`fastest-lap`** when `lap.isClassFastestLapOfRace === true` and `fastestLapAnnounceable(lap.lap, on.fastestLap)` (decision 5).
- **`best-lap`** otherwise, when `lap.isBest || lap.isFirstValid` and `on.bestLap`. A fastest lap of the race is always a personal best too, so with the fastest-lap call off, unscripted or inside the grace, the driver hears "That was your best lap yet".
- **`every-lap`** otherwise, when `on.everyLap`.

The `on` flags come from one owner resolver built inside `registerPitCrew` from the three families' `enabledIn(...)` gates and `engine.isScripted`, read live at each `lap.completed`, and handed to the three builders; it adds no `PitCrewDeps` key. #555's and #1163's contracts each add `owner(...) === <own>` to their `where:`; the fastest-lap contract's `yours` fires come from `fastestLap.set`, whose `where:` calls the same `fastestLapAnnounceable`. The gates that silence a lap whole — a full-course caution, the final lap of a race — stay in each contract and apply to all three alike, so a lap one of them owns is never handed to another by a gate.

Three cases where the owner speaks nothing are accepted: its fire dropped by its own speak gate (decision 9); a waiting `yours` superseded by a newer record (decision 8), or running out its queue wait, so the player's lap goes unspoken; and the lap the race ends on, where race-end speaks.

The function lives where all three read it because a precedence rule copied into three `where:`s drifts the first time one of them changes, and because the decision must be made on the `lap.completed` payload, never by which line reaches the bus first (the #1211 lesson: one contract yielding to another is decided at `where:`).

### 8. Scheduling

- `weight`: default (`WEIGHT.NORMAL`), the weight of #555, whose lap the `yours` line takes over. Every other line of the family is information of the same order.
- `interrupt: false`. Nothing here is urgent enough to cut a line in flight.
- `queueable: true`. `fastestLap.set` is a one-shot edge the translator never raises again for that record, so a fire dropped on a busy bus is lost for good (the #923 / #1211 rule).
- `family: "fastest-lap"`, its own. A newer record replaces a line about the old one in flight, which is now false. It does not share `lap-time`, or a rival's record would cut the driver's own best-lap readout mid-sentence.
- `supersedeGroup: "fastest-lap"` (the contract id would do the same; named for the reader): a waiting call about an older record is replaced by a newer one, because the newer makes it wrong.
- `maxQueueWaitMs: 30_000`. The line stays true while it waits: a newer record supersedes it, and the speak gate below drops it once the driver has started another lap. 30 s is under a lap almost everywhere, and on a short oval the gate is the tighter bound.

### 9. The drop rule: a call held past the player's next lap is dropped

"The next lap" is the player's next completed lap after the event: the first `lap.completed` whose `lap` is greater than the event's `playerLapsCompleted`. The contract's `speakGate` admits a fire only while the latest `lap.completed` (the plugin-owned snapshot the lap-time family already reads) has `lap <= playerLapsCompleted`, and while no full-course caution is out and the race has not finished for the player.

The count rides in the payload rather than in a `where:` stash, so the gate reads the fire's own data (#1138: what a gate reads is per fire). It counts against `playerLapsCompleted` rather than against the latest snapshot at event time because `lap.completed` can trail the crossing by up to the standings wait (`laps.ts:105`): a record that falls in that window would otherwise be dropped by the very lap the player had already completed. For the `yours` fire, `playerLapsCompleted` is the lap itself, so its own `lap.completed` never drops it.

The comparison is one function in `lap-announcement.ts`, `lapStillCurrent(lapsAtEvent, latest)`, which #1163's gate calls with its own lap: one definition of "the next lap" for both callouts. A `null` snapshot (no lap completed yet) admits the fire.

The snapshot it reads is the `lap.completed` cache in `packages/race-engineer-wiring/src/caches.ts:35-37`, which today is never reset, so after a session change it would still hold the last session's lap (lap 20, say) and drop every call of the new race until the player passed that count. This change clears that cached snapshot on `session.changed` in `caches.ts`, one subscription beside the existing one, with a test; every reader of the cache inherits the fix. The cache subscribes before the engine (`caches.ts:20-24`), so it is clear before the session's own contracts run.

### 10. The setting

One registry entry, a new family file `packages/callout-settings/src/families/fastest-lap.ts`:

```typescript
export const FASTEST_LAP_CALLOUTS = defineCalloutFamily({
  id: "fastest-lap",
  callouts: {
    "fastest-lap": { key: "calloutEnabledFastestLap", label: "Fastest lap of the race" },
  },
});
```

No `default`, so it ships on: new Race Engineer functionality defaults on. It is placed in the existing **Lap Time** group of `CALLOUT_PI_GROUPS` (`packages/callout-settings/src/pi-groups.ts:68`), `families: [LAP_TIME_CALLOUTS, FASTEST_LAP_CALLOUTS]`, so the settings window's Callouts card reads, under Lap Time: New best lap, Every lap (#1163), Fastest lap of the race. Placing it is what registers it; the schema field, the checkbox row and the id type derive from the entry. `SCENARIO_ID_TO_FASTEST_LAP_ID` maps the one contract, the `GATED` table in `callout-settings-coverage.test.ts` gets its row, and the settings package's frozen baseline gains the key (a new key, not a rename, so no migration).

## Approaches weighed and rejected

- **Session YAML, `ResultsPositions[].FastestTime` or `ResultsFastestLap`.** The sim's own results, and a per-car `FastestTime` the replay engine already reads (`packages/replay-engine/src/fastest-lap-press.ts:183-192`). Rejected for latency and cadence: session info refreshes on its own slower schedule (`laps.ts:96-105` waits up to 3 s for `ResultsPositions` to catch up with one lap), so the call would trail the lap by seconds and the player's own lap would be known after `lap.completed` had already been decided. Nothing in the repo shows whether `ResultsFastestLap` is per class.
- **Pairing every car's crossing with its `CarIdxLastLapTime`, as `diff/replay-laps.ts` does.** Proven machinery, but it judges every lap run, including any the sim does not count, so the engineer could name a record the timing screen does not show. Kept as the fallback should the capture in decision 1 show `CarIdxBestLapTime` refreshing late.
- **Reading the replay recorder's `replay.lapTimed` stream.** The data is there, but the recorder is a separate subscriber whose events reach the bus after the translator's, under its own gate, with untimed laps by design; building a Race Engineer record on the replay store's feed would couple two things that change for different reasons.
- **Recomputing the record each tick as the class minimum of `CarIdxBestLapTime`.** Simpler, but a departing car's value turning `-1` would hand the record to a slower car, and the event would fire for a "new" record nobody set.
- **Judging the player from `CarIdxBestLapTime[player]` like everyone else.** Uniform, but its refresh is not tied to the `lap.completed` tick, so the precedence would have to wait for it or race it.
- **Putting the grace in the translator.** The event would then carry policy a second sim's translator would have to copy, and the audio side needs the lap count anyway to hand the player's grace laps to #555.
- **The grace counted on the leader's laps.** Rejected in decision 5.
- **Choosing the variant at event time in the translator** (a `relation` field, the #622 shape). The neighbour can change while the fire waits; the live read at speak time is what keeps "the car in front of you" true when it is said.
- **A precedence by family or by bus order** (all three lap-time callouts in one family, or the first fire wins). Replacement acts on lines in flight and order on an idle bus, not on what should be said; the #1163 spec rejected the family route for the same reason.
- **A cooldown between calls.** After the grace a record falls rarely, and the supersede group and the family already collapse a quick succession to the newest.

## Out of scope

- Practice and qualifying, and any class but the player's (settled in the issue).
- An overall fastest lap in a multi-class race, and class-worded variants ("the class leader"): every line here is about the player's class, so "the leader" and "the fastest lap of the race" mean the class's in a multi-class race.
- A personal-best call for other drivers (the issue's Goal excludes it).
- The delta to the record ("two tenths off the fastest lap"), and announcing the record holder on demand from a key.
- Team racing: the record is the car's, whoever drove the lap.
- Changing #555's best-lap readout to the compact form; it keeps its full sentence.
- The website's Race Engineer page and the changelog fragment are part of the issue, not of this design.

## Testing

Unit, translator (`diff/fastest-lap.test.ts`, `diff/laps.test.ts`, `translator.test.ts`, `tick-order.test.ts`):

- The first eligible tick seeds silently, mid-race connect included; the same values on a second tick emit nothing; a positive control lowers one car's best below the record and emits exactly one event with its `carIdx`, `lap`, `lapTime`, `previous`, `carNumber`, positions and `playerLapsCompleted`.
- A car's best falling but staying above the record updates its baseline and emits nothing; a value of `-1` or `0` changes nothing, and a record holder whose value turns `-1` keeps the record (a slower car's next best does not take it, while a faster one does: the positive control).
- Pre-green ticks and cars with `CarIdxLapCompleted < 1` are skipped; a practice or qualifying session emits nothing while the same ticks in a race emit; another class's car and the pace car never emit, while a same-class car on the same values does.
- Two cars lowering the record on one tick emit one event, for the faster.
- The player: a faster `lap.completed` carries `isClassFastestLapOfRace: true` and is followed on the same tick by `fastestLap.set` with `isPlayer: true`, after it in the flush; `lapIsValid: false`, a slower lap and a non-race session leave the field absent; a later `CarIdxBestLapTime[player]` refresh emits nothing. A remote car beating the player's record emits `previous.isPlayer: true`.
- The player's `lap: 0` lap (a rolling start's parade crossing, faster than an empty or parade-time record) is refused by the shared eligibility predicate, while the same lap as `lap: 1` claims the record: the positive control.
- The pairing rule, both directions, over a run of ticks with the player's and remote cars' records interleaved: every `lap.completed` carrying the field has exactly one `fastestLap.set` with `isPlayer: true` and the same `lap`, and every `fastestLap.set` with `isPlayer: true` has its `lap.completed`. A claim left by the judge is published or cleared on the same tick, a pre-green or non-race tick included, and never appears on the next tick.
- `diffLaps` with a stub judge: it calls the judge once per emitted lap with `(lap, lapTime, lapIsValid)` and sets the field exactly when the judge answers `true`; `laps.ts` imports nothing from `fastest-lap.ts` (an import-boundary assertion in the same test file).
- A session change resets the record. A replay glance emits nothing; the record survives it while the baselines re-seed; a remote car whose best fell below the kept record during the glance becomes the holder silently. A departed holder across a glance: the holder's value reads `-1` after it, the record keeps its time and holder, and a car slower than the record but faster than every remaining car's best emits nothing, while a car faster than the record emits (the positive control). The player's `CarIdxBestLapTime` is read on a connect's first seed and not on a re-seed. The `TICK_ORDER` row is proven by the call-order test.
- The capture fixture from decision 1 replays through the translator and asserts the exact `fastestLap.set` sequence.

Unit, audio (`fastest-lap.test.ts`, `lap-announcement.test.ts`, and the existing `lap-time.test.ts`):

- Each `fastestLap.holder` key from a payload built for it, with the bundled script loaded, asserting the clips; the precedence rows: the player who is also the leader hears `yours`, a record taken by the leader is `taken-from-you`, the car ahead that leads is `leader`.
- Live positions win over the payload's, and the payload's are used when the live read is `null`; class positions in a multi-class payload.
- The gap clause plays for `ahead` and `behind` only, only when the live neighbour on that side is the fire's car on the same lap under a minute, and the line still plays without it.
- Grace: `lap` 1 and 2 are silent, `lap` 3 speaks (the positive control).
- Refused under a full-course caution at `where:` and at the speak gate, and after the race has finished for the player.
- The drop rule: a waiting fire is dropped once a `lap.completed` with a greater `lap` than `playerLapsCompleted` arrives, and admitted with an equal one; a `lap.completed` trailing the crossing (`lap` equal to `playerLapsCompleted`) does not drop it.
- Two waiting fires leave only the newer; a line in flight is replaced by a newer record.
- `fastestLapAnnounceable` at `lap` 2 and 3, enabled and not; `playerLapOwner` over the whole matrix (the field, the grace, the three opt-ins, and whether the active voice scripts each of the three contracts — with rows for a voice that scripts `lap-time-last` but not `lap-time-best`, and one that scripts neither of the higher two, where every lap falls to `every-lap`), and one integration test over the real `registerPitCrew` and both bundled scripts: for every combination, a `lap.completed` and its `fastestLap.set` make at most one of the three contracts fire, and none only when every tier is off or unscripted.
- The drop rule across sessions (`race-engineer-wiring`'s `caches.test.ts`): after a `lap.completed` with `lap: 20`, a `session.changed` clears the cached snapshot, so a fastest-lap fire of the new race with `playerLapsCompleted: 3` is admitted, while the same fire without the session change is dropped (the positive control); a `null` snapshot admits.
- Opt-in off: the fastest-lap line is silent and #555 speaks the lap.
- `bundled-scripts.test.ts`, `script-coverage.test.ts`, `clip-text.test.ts`, the callout-settings registry and coverage tests, and the settings baseline cover the script, the clips, the wording rule and the key.

Scenario harness: an `event-names.ts` entry for `fastestLap.set`, and a **Fastest Lap** category with one button per key (Yours, Taken from you, Leader, Car ahead, Car behind, Other car — car 5 in P6), each publishing a payload whose positions select its key through the fallback; plus **Yours in the grace** (`lap: 2`, publishing the `lap.completed` and the `fastestLap.set` pair), which must play the best-lap line and not the fastest-lap one, as the positive control of the precedence beside **Yours** (`lap: 5`), which must play only the fastest-lap line.

Manual, by Niklas, in an offline AI race in one class: silence on laps 1 and 2; an AI record after that names the leader, the car in front or behind with the gap, or a car by number and position; setting the fastest lap yourself says "That's the fastest lap of the race" with no best-lap line on that lap; an AI car beating it says it took it from you; switching the setting off mid-race silences the line and brings the best-lap call back. A multi-class AI race, where one is available, checks that another class's records stay silent.
