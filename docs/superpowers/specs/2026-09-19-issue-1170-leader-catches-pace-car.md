# The leader catches the pace car

> **Issue:** [#1170](https://github.com/niklam/iracedeck/issues/1170) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

The translator measures, along the track, how far the race leader is behind the pace car. It does this only while a full-course caution is still **waving**, and only after the pace car has **deployed** in that caution. The first time the gap falls to `LEADER_CATCH_DISTANCE_M` it emits one `caution.leaderCaughtPaceCar`. A new caution contract speaks that event on every discipline, in every car except the one at the front. The constant is 150 m until the oval capture described below sets it.

**Confirmed by the maintainer, 2026-09-19.** Niklas accepted the spec's recommendations as written:

- the call is silent for the leader, and for a car between the leader and the pace car;
- the call is spoken on road courses too;
- the technical choices stand: one fixed-distance constant; once per caution and only before the pickup; firing on the deployment tick when the gap is already inside the threshold; the wording; and the checkbox label.

This builds on #1127's caution machinery: the phase machine, the pace-car surface edge and the leader resolution in `diff/caution.ts`. It cannot start until #1127 merges. The names below were re-checked against `ir-1127` at `7a1c6e53c`, after #1127's second review had landed its fixes. They may still move before #1127 merges. The model does not depend on them.

## What was measured

### The caught gap: 19.5–19.8 m, across two sessions

All five 2026-09-19 Homestead snapshots were recomputed from the raw telemetry. The gap is `((CarIdxLapDistPct[pace car] − CarIdxLapDistPct[leader]) mod 1) × 2,381.5 m`. The pace car is index 64 (`DriverInfo.PaceCarIdx`). The leader is the lap-progress leader, and in all five it is also official P1 and the car at pace line 0, row 1.

| Snapshot | Session | Flags | Leader → pace car |
| --- | --- | --- | --- |
| `093300-381` | 1 | `Caution` | 19.84 m |
| `093306-474` | 1 | `Caution` | 19.74 m |
| `094029-956` | 1 | **`CautionWaving`** | 19.77 m |
| `094304-382` | 1 | `Caution \| OneLapToGreen`, double file | 19.50 m |
| `131947-663` | **3** | `Caution \| OneLapToGreen`, double file | 19.78 m (and 19.82 m for the outside front-row car) |

`131947` is newer than the issue and comes from a separate session (`SessionUniqueID` 3 against 1). The ~20 m caught gap is therefore not a property of one session. It is iRacing holding the leader there. Pace speed is 29.3 m/s (105 km/h): the pace car covered 178.2 m in the 6.09 s between the two static snapshots, and the recorded pace laps run 81.5 s.

`094029` shows what the call is for, mid-run. The caution is still waving. The leader and the four cars behind him already sit 10–12 m apart (19.8, 30.0, 42.0, 52.7, 65.1 m behind the pace car). The rest of the field is strung out up to 826 m back. The player, 264.6 m behind the pace car, is doing 68.0 m/s (245 km/h), at race speed, toward a queue that is forming at pace speed.

### The approach, inferred from the 2026-09-17 oval recording

No recording carries per-car lap distance, so the approach itself was never observed. The oval recording (`master/local/telemetry-watch-20260917-191825-092.jsonl`, moved from the ir-1127 worktree when #1127 merged) still bounds it. It holds the pace car's surface and the leader's lap counter, and the pace car's `CarIdxLapCompleted` blips −1 → 0 for about five seconds each time it crosses the line.

| `SessionTime` (s) | Caution 1 | Caution 2 |
| --- | --- | --- |
| Throw (`CautionWaving` rises) | 239.88 | 542.75 |
| Pace car `AproachingPits` → `OnTrack` | 264.27 (+24.4) | 561.63 (+18.9) |
| Leader crosses the line | 278.50 | 573.18 |
| Pace car crosses the line (its lap-counter blip) | 333.38 | 630.75 |
| Pickup (`Caution` static) | 333.57 | 630.95 |
| Leader crosses the line | 334.07 (0.69 s = 20 m behind) | 631.43 (0.68 s) |
| Leader's lap that contains the catch | 55.6 s | 58.3 s |

A green lap is 35.8 s (68 m/s). The lap the caution was thrown in took 39.0 s (61 m/s). A pace lap takes 81.5 s. The pace car took 69.1 s from reaching the track to reaching the line in **both** cautions (69.11 and 69.12 s). At pace speed that places its track entry at 0.153 of the lap both times, just past the player's pit box (`DriverPitTrkPct` 0.053): that is pit exit. So:

- **At deployment the leader was roughly half a lap behind the pace car**, about 1,100–1,300 m. The call's premise holds: the pace car comes out ahead, and the leader has to catch it.
- **The catch lands 17–24 s into the leader's next lap**, at 298–302 s and 591–595 s. That is **29–38 s after "Pace car's out" and 31–40 s before "Two to green"**, in the gap between the two where the waving caution currently says nothing.
- **150 m is near the leader's braking onset.** Shedding 61–68 m/s down to 29 m/s at about 1 g takes 140–190 m. Added to the 20 m caught gap, the leader starts braking at roughly 160–210 m. The capture should therefore move the constant up rather than down.

These are estimates from lap times, assuming constant speeds. They place the call in the sequence. They do not set the constant.

The road recording (`telemetry-watch-20260918-185032-545.jsonl`) only brackets its catch. The pace car deploys at 155.37 s. It crosses the line at 309.15 s with the leader 0.85 s behind, and static plus one to green arrive together at 309.33 s. So the catch falls somewhere in a 154 s stretch in which the road course currently hears nothing between "Pace car's out" and "One lap to green".

### Three readings the design routes around

- **The pace car's `CarIdxLapCompleted` is −1 on the oval too**, in all five snapshots and throughout both recordings apart from the line-crossing blips. The gap can therefore only be a **track** distance (lap fraction mod 1). It can never be a race distance (laps + fraction), the way the canonical order scores cars.
- **`CarIdxOnPitRoad` is not a pit-road reading.** Slots 18–37 read `true` from the green onward in the oval recording and in all five snapshots. Eighteen of those twenty slots are empty, and the other two are cars on the racing surface (the leader at `094029` among them). #773 already called the array unreliable for the pace car. Nothing here reads it; every surface question goes through `CarIdxTrackSurface`. The pattern is recorded here as a reading. Whether it becomes an issue of its own is decided separately.
- **`CarIdxEstTime` cannot express the gap in seconds.** For the same 19.5–19.8 m it gives the pace car a lead over the leader of anywhere from 0.43 to 1.42 s, depending on where on the lap the snapshot was taken. The pace car is scored against a different reference lap.

## The model

### The leader is the canonical race leader

The car measured is the one the episode already counts crossings in: `resolveLeaderIdx(telemetry, canonicalPositions)`. That is overall P1 in the canonical order, falling back to pace line 0, row 1 only on a tick with no canonical order. Reusing it means the extra-lap count and the catch can never disagree about who leads. "Who leads the race" is a race-position question, and `@.claude/rules/race-positions.md` sends every one of those to the canonical order.

The pace-row carve-out does not apply, and it is not needed as a fallback. That carve-out covers who you follow and which lane you take, because the rows are the restart order. The rows are assigned at the throw, long before anyone is near the pace car. They say nothing about which car is physically closing on it. In all five snapshots the two sources name the same car. The rule decides the case where they would not, for example a leader who dives for the pits under the waving caution.

The physically nearest car behind the pace car was rejected as the subject. The pace car comes out ahead of *somebody*, so that car is "within 150 m of the pace car" on the deployment tick, whoever it is.

### The distance is metres along the track

The measure is `((pctPaceCar − pctLeader) mod 1) × trackLengthMeters`, the **forward** gap from the leader to the pace car. It is computed by `forwardGapMeters(telemetry, fromIdx, toIdx, trackLengthMeters)`, a primitive in `@iracedeck/iracing-sdk` `track-utils.ts` that lives beside `nearestCarGapMeters` and applies `carInWorld`. #1168 specifies the same primitive, under the same name, for its gap to the car ahead. Whichever issue lands first adds it, and the other consumes it; there is never a second copy. `race-positions.md` keeps track order to one set of primitives, and this adds the two-named-cars case to it.

The track length is the translator's cached `resolveTrackLengthMeters`, parsed from `WeekendInfo.TrackLength`. It is already resolved above the `diffCaution` call. When the track length is missing, nothing is measured: silence, never a guess.

`diffCaution` takes it through a **named trailing options object**, `{ now?, trackLengthMeters? }`, which replaces the trailing optional `now` #1127's fix round added. A second optional number next to `now` would be the #1052 trap: two adjacent parameters of the same shape, where a swapped call still type-checks. The options object has two further advantages:

- **Few call sites move.** Of the 149 call sites, 140 are in `caution.test.ts` and almost none pass `now`. Only the translator's call and the few that do pass it change.
- **The default is the right one.** Every existing test that omits the track length gets a step that measures nothing, which is the correct behaviour for tests that are not about the catch.

#1168 threads the same value and can use the same object.

The modular arithmetic makes the start/finish line invisible. Either car may wrap first, and the forward gap is continuous across the line. A pace car that is *behind* the leader reads as nearly a full lap forward, which is correct: the leader would have to lap round to catch it.

Metres rather than a lap fraction: braking distance does not scale with track length. 150 m is 6% of Homestead and 18% of Martinsville. The caught gap is already measured in metres. Metres rather than seconds:

- `CarIdxEstTime` is unusable for the pace car, as shown above.
- A time-to-contact model (`gap / closing speed`) needs a derivative of the gap plus a distance floor for a leader who has already slowed, and it goes infinite as closing speed falls to zero. That is two constants where one would do, and one oval capture calibrates neither across speed regimes any better than it calibrates one distance.

The price of a fixed distance is lead time that varies by track. By the braking estimate above, a superspeedway's leader starts braking a second or two before the call, and a short track's leader several seconds after it. That is within what a heads-up tolerates. A superspeedway capture showing the call landing more than 2 s after the leader's braking onset is the trigger for revisiting this, not a blocker.

### The window runs from the pace car's deployment to the pickup

A new tri-state translator field, `cautionLeaderCatch: "idle" | "armed" | "done"`, sits beside the episode's other fields.

- **idle → armed** on the pace car's `!onTrack → onTrack` surface edge, while the phase is `"waving"`. This is the **same edge** that emits `paceCar.deployed`. `diffPaceCar` returns the edge it saw, and the new step consumes it, so the edge is read once. On both tracks the deployment reads `AproachingPits` → `OnTrack`, even though the waiting pace car differs:

  - On the oval it waits on pit road and reads `AproachingPits` through the whole green run (196.53–264.27 s).
  - On the road course it waits parked and reads `OnTrack`, and the edge is its roll-out through pit exit.

  A pace car that is merely *present* never arms. The road's parked, waiting pace car reads `OnTrack` from before the throw and never produces the edge. Neither does a pace car the plugin first sees mid-caution; like #1127's pickup, this is a transition that has to have been seen.
- **armed → idle** on the pace car's `onTrack → !onTrack` edge, or when the phase leaves `"waving"`. Pulling off therefore only ever **disarms**, and it cannot be mistaken for a deployment. That is the road-course trap: the same `AproachingPits` means rolling out mid-caution, and pulling off after one to green. The re-park at 494.18 s, the other `→ OnTrack` edge on the road, happens under green, with the phase at `"none"`, so it cannot arm anything. Measurement also requires the pace car's surface to read on-track on the tick itself.
- **armed → done** on the emission. The step measures on every armed tick, including the arming tick itself. A pace car that comes out already within the threshold fires on its deployment tick, after `paceCar.deployed` in bus order. The leader is on it at that point, and waiting for an approach that will never be seen would silence exactly the earliest compression.
- **any → idle** when the phase returns to `"none"`, so each caution gets its own call.

The window **closes at the pickup**. By construction, the pickup is the pace car finishing its lap with the leader behind it: 0.68–0.69 s behind at both oval pickups, and 0.85 s at the road one. A catch not reported by then is stale, and "Two to green" or "One lap to green" is the moment's successor. A caution the diff never saw wave (static-first, or a mid-caution connect) never arms. That matches #1127.

The step never measures on a tick with `Green` set. This is #1127's yellow-checkered rule, adopted in its second review: a caution bit can outlive a green at a finish under yellow, so the phase can read live under a flying green, and an approach under a green is not a caution approach. #1127's extra-lap branch and its silent entry into `"caught"` refuse such a tick for the same reason.

The step also does no work unless it is armed, which happens only while the caution waves. It resolves the leader and the gaps only then, and looks up the car number only on the tick it emits. That is the same economy #1127's fix round gave `diffLineup`, which now resolves the lineup only after its early returns.

The leader's surface must also read on-track: `OnTrack` or `OffTrack`, the same `onTrack()` helper the pace car uses. A leader on pit road is not catching anything, and his lap distance along the pit lane would otherwise close on the pace car. A tick where either lap distance is invalid is a gap in the reading: the state is kept and nothing is decided.

The whole field is **preserved across the replay wipe**, alongside `cautionPhase` and `cautionCheckpointArmed`. #1127's fix round added four state fields: `cautionRestartedAt`, `lapCautionLatchLap`, `lapCautionSeen` and `lapCompletedWasCaution`. None of them collides with `cautionLeaderCatch` or is read by it. A replay glance while armed must not lose the call, and one after the catch must not repeat it. The seed's phase expiry resets it to `"idle"`, and the seeding tick never emits.

### Once per caution, and no hysteresis

`"done"` holds until the episode ends, so the event fires at most once per caution. With no re-arm there is nothing to chatter, and a distance hysteresis would buy nothing. There is no tick debounce either, following #600's pit-box bands and #1127's checkpoint: `CarIdxLapDistPct` is continuous. Glitch values fall under "a gap is not a reading". Neither the wrap nor a jump to about a full lap can produce a small gap.

A leader who pits is handled by the leader resolution rather than by any special case. While he is on pit road nothing is measured. Once the canonical order promotes the car that passed him, that car is measured from its first tick, and no approach baseline is needed because none is required. A leader who pits **after** the call changes nothing: the field is compressing behind the pace car either way.

### Who does not hear it

The call is skipped in the car at the front. That is the leader himself, or a car physically between the leader and the pace car (a lapped car the pace car came out ahead of). For both, "expect the cars ahead to slow" is false: the only thing ahead is the pace car, which is already slow.

The translator reports this as a fact. The event carries `playerAtFront`: the player **is** the measured leader, or the player's own forward gap to the pace car is **strictly** smaller than the leader's. Strict matters. `131947` has the outside front-row car level with the leader (0.04 m apart), and a car alongside the leader is behind the queue's first slowing, not ahead of it. The contract makes the decision in its `where:`: `liveRaceCar(e) && !e.data.playerAtFront`, plus the stall check below. The rule "the diff reports what the sim did, the contract decides whether that occurrence is news" keeps the choice in code rather than in a pack. The sentence's premise is false for that car, so this is applicability, like the pace-car calls staying quiet at a rolling start.

An unreadable player position reads as `playerAtFront: false`, so the call speaks. Wrongly speaking to the leader is a line he can ignore. Wrongly silencing a mid-pack driver loses a safety call (the #574 direction: missing telemetry silences nothing). A player **driving on pit road** still hears it, because he rejoins behind the very field that is compressing.

A player whose car sits **in its stall** does not hear it. The `where:` adds `e.telemetry.PlayerCarInPitStall !== true`. #1127's second review (R15) found a player towed to his stall mid-caution in the road capture, and ruled out lineup sentences that are untrue of a car in its stall. "Expect the cars ahead to slow" is one of them: by the time a stationary car rejoins, the compression is over. A missing reading counts as not in the stall, in the same direction as `playerAtFront`.

### Road courses

The same model runs unchanged, with nothing gated to ovals. On a road course the call becomes the one line between "Pace car's out" and "One lap to green", filling the 154 s silence the road recording shows. It does **not** turn into "Two to green" there. The catch is a compression moment rather than a lap count, and no flag on a road course says how many laps remain after it.

## Where it sits

| | Oval (2026-09-17, measured and inferred) | Road (2026-09-18) |
| --- | --- | --- |
| Caution out, then who to follow | throw, +2.5 s | throw, +2.5 s |
| "Pace car's out." | +19 to +24 s | +61.5 s |
| **"Leader's caught the pace car."** | **~29–38 s later (inferred)** | **somewhere in the next 154 s** |
| "Two to green." | ~31–40 s later | not spoken |
| "One lap to green." | one leader crossing later | +215 s |

The contract is `pit-crew.caution-leader-caught`:

- **`weight: WEIGHT.SAFETY` (70).** The pending slot keeps one fire. An arrival replaces it when its weight is `>=` the pending one; otherwise the arrival is dropped. At `7a1c6e53c` the contests are:
  - **"Pace car's out" (70, family `flag`).** When the two coincide and the bus is held, the catch evicts the pending "Pace car's out". That is intended: "the leader's caught the pace car" says the pace car is out.
  - **"Two to green" / "One lap to green" (70, `flag`).** Either one evicts a pending catch. That is intended too, because by then the catch is stale, and the speak gate below would refuse it anyway.
  - **The lineup change (70, `flag`, held 1.5 s).** Only a car pitting under the waving caution produces one during the window. The tie goes to whichever arrived later, which is the single slot's nature. It is accepted, because it needs the bus held across both calls.
  - **The follow call (69, no family).** It is spoken 2.5 s after the throw, about a minute before the catch. If it were still pending, the catch would evict it.
  - **The position call (69, no family).** **It cannot contend with the catch in practice.** Position fires only in `"one-to-go"`, and the catch only in `"waving"`. For position to meet a still-pending catch, the bus would have to be held continuously through the pickup and a full pace lap, with both "Two to green" and "One lap to green" switched off. Their opt-in wrappers run ahead of the scheduler, so switched-off calls never reach the slot. Even then the only cost is that one call: position (69) would be dropped behind the catch (70), and the catch would then be refused by its own speak gate at replay.
  - **A lower weight** would do the opposite of what is wanted: the catch would be *dropped* on arrival whenever "Pace car's out" held the slot.
- **No `family`.** The caution family now has two such exceptions, `follow` and `position`. This is a third, for the reason `follow` gives. Its likeliest collision is "Pace car's out" on the same tick or seconds apart. Same-family preemption would cut that line mid-word regardless of weight. With no family and `queueable: true`, the catch defers behind the in-flight line and plays next. The family would only have bought cutting a stale in-flight catch, and a one-sentence line is never stale in flight.
- **`queueable: true`, no `interrupt`, no `triggerDelay`, no `cooldown`.** It is a safety call, so every second of lead counts. Once per caution is enforced in the translator.
- **`speakGate`: its own, "the caution is still waving": `admit: () => getCautionPhase() === "waving"`.** The family gate at `7a1c6e53c` is `getCautionPhase() !== "none"` ("the full-course caution is still out"). The follow and lineup-change calls use the variant `stillLinedUp`, which also requires a pace row. This call narrows the family gate to the window it describes.
  - The narrower gate is free now. `buildCautionContracts({ getCautionPhase, getCautionLineup })` already receives the phase reader through `CautionContractDeps`, and `PitCrewDeps.getCautionPhase` (default `"none"`) is wired in all three plugins and in the harness.
  - It closes the one stale path, which the first draft argued away while that reader did not exist: a catch still pending at the pickup after the pickup's own call was switched off, or never raised on a road course. A fire deferred before it expanded is asked at replay, so such a catch is refused rather than spoken after the field is picked up.
  - The residual that #1127 records does not reach this call in practice: a fire already admitted and cut by `restart` replays whole. The call is spoken while the caution waves, and #1127's restart now needs `Green` rising with neither caution bit set, which is at least a pickup and a full pace lap later.

## The event

```ts
/** The race leader closed to within LEADER_CATCH_DISTANCE_M of the pace car, measured along the track, after the pace car deployed in a still-waving full-course caution. At most once per caution; never after the pickup. */
"caution.leaderCaughtPaceCar": SimEvent<
  "caution.leaderCaughtPaceCar",
  { leaderCarNumber: string | null; playerAtFront: boolean }
>;
```

- **`playerAtFront`** is what the `where:` reads.
- **`leaderCarNumber`** is read by the one new var below, spelled as the sim spells it (`getCarNumberFromSessionInfo`, the reader `caution-lineup.ts` already uses).

Both are read from the payload rather than live, and that is honest here in a way it was not for the lineup. Nobody passes under a caution, so neither value can change in the seconds a pending fire waits. `ctx.data` also belongs to the fire, so no stash is shared between fires.

The payload carries no `leaderCarIdx` and no gap, because nothing reads them. That is #1127's rule: a published field with no reader is a contract maintained for no one.

`LEADER_CATCH_DISTANCE_M` is exported from `diff/caution.ts` beside `LAST_LAP_CHECKPOINT_PCT`. The step is a fourth function in that module, `diffLeaderCatch`, run after `diffCautionEpisode`. It needs the phase this tick settled on and the pace-car edge from the same tick, and splitting it out would mean threading both across modules. The pure half, the gaps and `playerAtFront`, sits on the new SDK primitive. The diff takes neither `isRaceSession` nor `replayOnlySession`, following #1127 and the #480 precedent: the contract's `liveRaceCar` is the gate.

## What the driver hears

Clips go in the existing `caution` group under the base `leader-caught`, three variants, each a full sentence with the radio frame:

- `leader-caught-01`: "Leader's caught the pace car. `<break time="0.3s" />` Expect the cars ahead to slow."
- `leader-caught-02`: "Leader's on the pace car now. `<break time="0.3s" />` The field's bunching up — watch the cars ahead."
- `leader-caught-03`: "Leader's reached the pace car. `<break time="0.3s" />` Cars ahead will be slowing."

The final text is settled from a dry run. The expected count is **3 clips**, and the dry run must list exactly those before anything is generated. The config is edited as text, never parsed and re-dumped. The script entry is `"sequence": ["pool:caution/leader-caught"]`, with `comment` and a `test` naming the harness button. `CAUTION_CLIP_SOURCES` gains the pair. Then run `generate:callout-scripts`, `generate:pack-reference`, and `pack:voice default` with a version bump.

**`minPluginVersion`.** This change edits the `default` voice's script: a new entry for a new contract, and a new var for packs to use. If it ships after 3.3.0, the `default` catalog entry that carries it sets `minPluginVersion` (`deck-core/src/voice-pack-catalog.ts`) to the release it ships in. Shipping in 3.3.0 alongside #1127 needs nothing, because the plugin and the pack move together.

Be exact about what the field protects:

- **The entry this issue adds degrades harmlessly on its own.** An older plugin's `compileVoiceScript` skips an entry whose contract that build lacks ("no contract", warned once). That build has no event for it anyway, and the reference entry names no vocabulary outside what such a build knows.
- **The pack ships whole.** A `default` published after 3.3.0 also carries whatever else changed in the script since. An existing entry rewritten to use newer vocabulary (#1169 rewrites two of #1127's entries, two-to-green and one-to-go) fails to compile on an older plugin, and that callout goes silent. The field is what keeps an older build from updating to such a pack.
- **What it costs, accepted:** the launch step gives up on a managed pack it cannot be offered. An older build keeps the `default` it has. An older build with **no** `default` installed gets no voice until the plugin updates, and the settings window says the plugin is too old.

Vocabulary: `caution.leaderCarNumber` is a var over `ctx.data.leaderCarNumber`, drawn from the `car-number` group, and null for an imperative fire or an unspellable number. The reference script does not use it. It is published because the vocabulary is what bounds a pack's phrasing ("Car nineteen's on the pace car"), and a resolver costs four lines. Its description names the `car-number` group, as `descriptionNamesGroup` requires. The contract `description` interpolates `LEADER_CATCH_DISTANCE_M` in metres, so a recalibration cannot leave the published text stale.

## Setting

- Key: `calloutEnabledCautionLeaderCaught`, default `true` (new Race Engineer calls ship on).
- `CautionCalloutId` gains `"leader-caught"`, which updates both derived maps.
- The checkbox row under **Race Engineer Callouts → Caution** is labelled **"Leader caught the pace car"**. The key names the moment, so a later wording change never renames it.

The Caution group gains one switch. Wherever the group's size is written out (the Pit Crew page, the changelog line, the `caution.ts` header, the `index.ts` comments), it is updated to the count at merge time. #1168 and #1169 add switches of their own, so no number is fixed here.

## Harness

`event-names.ts` gains the event. The harness's `main.ts` already wires `getCautionPhase` to the real translator for #1127's gates, so the new speak gate needs no harness wiring.

A new telemetry-sequence shortcut, **Flags → Caution → Leader catches the pace car**, drives the real diff, because the translator's decision is the thing under test. The sequence:

1. `CautionWaving` and a single-file lineup.
2. The pace car's surface `AproachingPits` → `OnTrack`.
3. Pace-car and per-car lap distances stepping the leader's gap from about 1,000 m, to just above `LEADER_CATCH_DISTANCE_M`, to just below it (which fires), then down to 20 m. The steps are derived from the constant, as the other caution buttons derive their holds from theirs, so a recalibration cannot strand the button.
4. Static `Caution`.
5. Every patched array deleted and a sane `SessionFlags` restored at the last step.

It patches `CarIdxLapCompleted` together with `CarIdxLapDistPct`, so the leader is resolved the production way, through the canonical order. It deletes both at the end, which leaves the extra-lap button's no-lap-progress premise intact for the next press (the precedent the restart button set).

It declares `player-car-index` plus a new `pace-car-gap` precondition: session info names a pace car and carries a parseable `TrackLength`. That precondition asks `resolvePaceCarIdx` and a pure `parseTrackLengthMeters(sessionInfo)`, which is split out of the translator's cached resolver and exported, so the harness cannot restate the rule.

**Neither race preset carries `WeekendInfo.TrackLength` today**, so both gain it:

- `race-oval.json`: Homestead's measured `"2.3815 km"`.
- `race.json`: Tsukuba's length, read from a real snapshot rather than typed from memory.

`scenario-shortcuts.test.ts` drives the button through the real translator. It asserts:

- the event arrives exactly once, at the step just below the constant;
- it arrives after `paceCar.deployed`, naming the lineup's leader;
- its `playerAtFront` is `false`;
- a second run with the player placed as the leader gets `true`.

The existing "Caution → restart" button is left alone. Folding the catch into it would move both its pinned event list and its premise of no per-car lap progress before one to go.

## telemetry-watch gains a caution preset

The watched-variable list is a `--vars` argument, retyped for every capture. That is how both recordings came to stop at `CarIdxLapCompleted` / `CarIdxPosition` / `CarIdxTrackSurface`. `watch-core.ts` gains named presets (`--preset=<name>`, combinable with `--vars`, expanded into the meta record's `vars`), and ships one.

`caution` is built from three lists:

- **#1127's fifteen variables, unchanged**, so the fixture-cut script still runs on the output: `SessionFlags`, `SessionState`, `PaceMode`, `PitsOpen`, `OnPitRoad`, `Lap`, `LapCompleted`, `PlayerCarIdx`, `CarIdxPaceFlags`, `CarIdxPaceLine`, `CarIdxPaceRow`, `CarIdxOnPitRoad`, `CarIdxTrackSurface`, `CarIdxLapCompleted`, `CarIdxPosition`.
- **This issue's additions:** **`CarIdxLapDistPct`**, `LapDistPct` and `Speed`.
- **The variables #1168's and #1169's capture commands name** that the first two lists lack: `PlayerTrackSurface`, `CarDistAhead`, `DriverMarker`, `PushToTalk`.

With the union, one oval session can record all three follow-ups' captures at once. Whichever of the three issues lands first adds the preset; the others extend it rather than retyping a list.

A watched array that moves on every tick makes `--mode=changes` record every tick. At about 3.4 KB a tick (measured 1.9 KB for the fifteen, plus the 72-float array), that is roughly 12 MB a minute, and the help text says so. The parser, expansion and help get `watch-core.test.ts` coverage.

## Testing

- **SDK:** `forwardGapMeters`, if this issue is the one that adds it:
  - the wrap in both directions;
  - a pace car behind, reading as about a full lap;
  - invalid and not-in-world cars returning `null`;
  - on the committed `caution-lineup-20260919.json` (one real tick with every car's lap distance) at 2,381.5 m, the leader's gap is 19.50 m ± 0.05.
- **Translator** (`caution.test.ts`, synthetic ticks):
  - arms only on the deployment edge while waving;
  - a road-style pace car parked `OnTrack` before the throw never arms;
  - the roll-out through `AproachingPits` arms on its return;
  - the pull-off disarms;
  - fires once at the threshold, and on the arming tick when already inside it;
  - never fires in `"caught"` or `"one-to-go"`, in a static-first caution, or on a tick with `Green` set (the yellow-checkered case);
  - existing call sites that pass no options object measure nothing;
  - skips a leader on pit road;
  - follows a canonical leader change mid-approach;
  - silent with no track length or no lap distances;
  - `playerAtFront` for leader, between, level (`false`) and unknown (`false`);
  - the seed never emits;
  - the replay wipe preserves the field and the expiry resets it;
  - `LEADER_CATCH_DISTANCE_M` is at least twice the 19.84 m caught gap, so a recalibration can never produce a threshold the leader settles above.
- **Fixture:** a committed cut of capture 1, `__fixtures__/caution-leader-catch-<date>.json`, citing its source. It asserts that the event fires on the tick the gap first reaches the constant, exactly once per caution, after `paceCar.deployed` and before `caution.fieldCaught`. The three existing caution fixtures must stay green **unchanged**, because the new step is silent without lap distances. Their unchanged event lists are the proof that it adds nothing where it cannot measure.
- **Contract** (`audio-scenarios` `caution.test.ts`):
  - speaks when armed; silent on `playerAtFront`, with the player in his stall, and with the opt-in off;
  - `SAFETY` weight, no family, queueable;
  - queues behind an in-flight "Pace car's out" rather than cutting it;
  - is replaced in the pending slot by "Two to green";
  - a catch pending while the phase moves to `"caught"` or `"one-to-go"` is refused by its speak gate at replay;
  - the var resolves from the payload and is null with no event.
  - The contracts are built through `buildCautionContracts({ getCautionPhase, getCautionLineup })`, as #1127's tests build them at `7a1c6e53c`.
- **The rest:** `bundled-scripts.test.ts` and `script-coverage.test.ts` hold the script and clips. The deck-core `simhub-service.test.ts` literals (both) and `global-settings.test.ts` get the key.

## Documentation

- **Website:**
  - The Pit Crew page's *Full-course caution* list gains a step between "The pace car reaches the track" and "Two to green", including that the call carries the road course's only mid-caution moment. The switch count and switch list are updated.
  - The pack reference is regenerated.
  - Changelog: if #1127's line is still in the in-development section when this merges, it is extended in place (one capability, one line). Otherwise this gets its own **Features** line.
- **Rules and package docs:**
  - `race-positions.md` gains the consumer: the catch's leader comes from the canonical order through `resolveLeaderIdx`, and its track gap from the new primitive.
  - `race-engineer-callout-examples.md` gains the #1170 entry. Its lesson is to gate a continuous measure on an observed transition of the thing measured against, not on that thing's presence.
  - The fixtures `README.md` gains the new cut.
  - The harness `CLAUDE.md` gains the button, the precondition and the preset `TrackLength`.
- **No Architecture-page change.** No package, seam or data-flow change.

## Rejected alternatives

- **Deciding in the scenario layer** (a condition over live telemetry). Rejected for #1127's reason: every voice pack and the harness must see the same event stream.
- **The pace car's presence (`OnTrack`) as the gate.** The road course's waiting pace car reads `OnTrack` parked. The deployment edge is the only reading that means "running".
- **A motion test** (the pace car's lap distance advancing) instead of the edge. It is plausible, but the parked pace car's `CarIdxLapDistPct` has never been recorded, so its value is unknown. Capture 2 records it. If the edge ever proves insufficient, this is the fallback.
- **Requiring an observed approach from above the threshold.** It would silence exactly the case where the pace car comes out right in front of the leader. The deployment edge already excludes the parked-car false positive that requirement was meant to catch.
- **The lineup's first car, or the car nearest behind the pace car, as the subject.** See *The leader*.
- **Lap fraction, `CarIdxEstTime` seconds, or a time-to-contact trigger.** See *The distance*.
- **Arming after the pickup, or re-arming on a second deployment within one caution.** The first would be a stale call. The second is unobserved, and once per caution is the promise the call makes.
- **A leader-specific line** ("You're on the pace car") in place of silence at the front. That driver is looking at the pace car.
- **A weight above `SAFETY`**, so a pending catch could never lose the slot to an equal-weight lineup change. Rejected because it would then drop "Two to green" and "One lap to green" when they arrived behind a pending, by-then-stale catch. The speak gate would refuse that catch at replay, so both calls would be lost.
- **A second positional numeric parameter on `diffCaution`.** See *The distance*.
- **Folding it into the pickup's "Two to green"**, or tying it to the lineup. The issue already rejected both on the measurements.

## Captures still needed

**Capture 1 (oval) sets `LEADER_CATCH_DISTANCE_M` and supplies the fixture.** It blocks the merge but not the start of the work.

Setup: Homestead-Miami, ARCA, an offline AI race of at least 20 cars with a rolling start (the #1127 setup), on a build carrying the preset.

```bash
pnpm telemetry-watch --preset=caution     # start before the green; stop after the last restart
pnpm telemetry-snapshot                   # once, after the first throw: TrackLength, PaceCarIdx, DriverPitTrkPct
```

Throw three cautions with `!yellow`, each after at least two green laps. Time each throw by where the leader is: (a) on the back straight, around 0.5 of the lap; (b) just past the line, before pit exit, around 0.05; (c) just past pit exit, around 0.20. The last two probe whether the pace car ever comes out behind the leader, or already within the threshold. Let each caution run to its restart.

The reading, per caution, over the window from the pace car's `→ OnTrack` edge to the pickup:

- Gap: `g(t) = ((CarIdxLapDistPct[64] − CarIdxLapDistPct[leader]) mod 1) × TrackLength`.
- Closing speed: `c(t) = (g(t − 0.5 s) − g(t)) / 0.5`.
- The leader's braking onset `t_b` is the first tick at which `c` falls below 80% of its median over the preceding 5 s.
- **`LEADER_CATCH_DISTANCE_M` = the largest `g(t_b)` of the three, rounded up to the next 25 m**, so the call leads every observed braking onset.

Recorded alongside: `g` on the deployment tick; whether any car's forward gap to the pace car is below the leader's at `t_b`; `t_b` relative to `paceCar.deployed` and to the pickup, to confirm the inferred 29–38 s / 31–40 s; and the settled caught gap (19.5–19.8 m expected).

**Capture 2 (road course) confirms the model where "Two to green" is silent.** It does not block.

Setup: an offline AI road race with a **standing** start (so the pace car waits parked, as on 2026-09-18), the same preset plus one snapshot, and one caution thrown mid-lap, recorded through one lap to green.

Readings:
- the parked pace car's `CarIdxLapDistPct` before deployment (a fixed value, or −1), which settles whether the motion test above was ever available;
- `g` at the deployment edge;
- `t_b` and `g(t_b)` against the oval constant;
- the time from the catch to one to green.

Still unverified after both:
- whether a car caught between the pace car and the leader gets waved by (`CarIdxPaceFlags`), in which case `playerAtFront` would describe it for only a moment and #1169's wave-around call is the one that speaks to it;
- the superspeedway lead-time trigger above.

## Order of work, and review

1. The `telemetry-watch` preset first, unless #1168 or #1169 already added it, since capture 1 needs it.
2. The SDK primitive, the translator step, the event and its tests. The contract layer consumes this, so it gets a task-scoped review before the contract work starts (`@.claude/rules/code-review.md`, a consumer seam).
3. The contract, vocabulary, script, the dry run then 3 clips, the setting, the checkbox and the three plugins.
4. The harness.
5. The constant and the fixture from capture 1.
6. The documentation.

The change adds to the published `@iracedeck/event-bus` catalog and to `GlobalSettingsSchema`, so the branch takes one `xhigh` `/code-review` at the end.
