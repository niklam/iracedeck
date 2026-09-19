# Catch the car ahead under a caution

> **Issue:** [#1168](https://github.com/niklam/iracedeck/issues/1168) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Under a full-course caution the engineer tells a driver who has dropped back from the car he lines up behind to close up: "Close it up — catch car ninety-five." The gap is judged against **the pack's own spacing**, not in metres or seconds. The translator owns the detection: a new pure measurement, a small per-caution state machine, and two new bus events, one for the first call and one for reminders. The callouts own the words and a speak-time gate.

It builds on #1127's seams: the lineup reader (who you follow, which lane), the caution phase, and the car-number clips. Where this spec names a function or constant from #1127, it means the name on the `ir-1127` branch at `7a1c6e53c`, after its second review's fix round (2026-09-19). The implementation follows whatever #1127 merges as. It is intertwined with #1169 (the wave-around). The drive-round state defined here is what #1169's call is phrased from, so #1168's translator half lands first. See *Order of work*.

## Confirmed by Niklas, 2026-09-19

The product decisions below were put to him through the coordinator and confirmed as written here:

- **Reminders:** at most two, 30 s apart, only while the driver is not closing, with their own switch ("Catch-up reminders").
- **The reminder is not queueable.** This is a deliberate exception to his standing ruling that a caution call is never dropped for a busy bus.
- **Pit exit:** one call, naming the tail car, with no reminders.
- **Wording:** "Close it up — catch car N" and its siblings, in place of the issue's bare "Catch car N".

These technical defaults were kept as proposed:

- the raise-multiple clamp of [2.0×, 3.4×] against iRacing's own message;
- the front-row case, "Close up on the pace car".

## What was measured

Five snapshots from 2026-09-19, all at Homestead (oval, ARCA, pace about 105 km/h, 20 cars plus the pace car at index 64), were recomputed from the raw JSON rather than copied from the issue. Distances are the circular forward distance in `CarIdxLapDistPct` × the snapshot's own `WeekendInfo.TrackLength` (2,381.5 m). "Pack spacing" is the median gap between consecutive cars in the same pace line, both lines pooled. It excludes each line's pair with the pace car and the player's own pair.

| Snapshot | Caution | `PaceMode` | Gap to the car ahead in your line | Pack spacing (n) | Ratio | Time at own speed / at 29.3 m/s | `CarDistAhead` | Player pace flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `093300` | static | single file | **50.4 m** | 10.6 m (18) | **4.7×** | 1.71 s / 1.72 s | 50.4 m | 0 |
| `093306` | static | single file | **36.5 m** | 10.6 m (18) | **3.4×** | 1.06 s / 1.25 s | 36.5 m | 0 |
| `094304` | static + one to go | double file | 13.1 m | 10.0 m (17) | 1.3× | 0.45 s / 0.45 s | 13.1 m | `WavedAround` |
| `131947` | static + one to go | double file | 11.9 m | 10.0 m (17) | 1.2× | 0.41 s / 0.41 s | **2.2 m** | 0 |
| `094029` | **waving** | single file | 1,819.7 m (0.76 lap) | 24.9 m (18) | — | — | **0.5 m** | `WavedAround` |

What the numbers settle:

1. **The ratio separates the cases cleanly on this evidence.** Every "normal" reading is at most 1.3× and both catch-up readings are at least 3.4×. The widest normal gap among the *other* cars is 16.4 m (1.55×): two tail cars in `093300`, still compacting six seconds before `093306` shows the whole line inside 12.3 m. That 1.55× bounds how low the clear threshold may sit.
2. **A formed pack is remarkably uniform.** Double file, both lanes read 9.9–10.1 m in both sessions. The pace car keeps its first car at 19.5–19.8 m in every snapshot and in both lanes: the leader, and the outside front-row car in `131947`. That is 1.85–1.98× the pack spacing, so a pair with the pace car needs its own reference.
3. **A waving field is not a pack.** In `094029` the other gaps run from 4.8 m to 284 m (median 24.9 m, 90th percentile 76 m). No spacing statement is meaningful until the caution goes static.
4. **Dividing by your own speed misreads the case that matters.** In `093306` the player was already accelerating to close (34.6 m/s against the field's ~29.3 m/s). The same 36.5 m reads 1.06 s by his speed and 1.25 s by the field's. A driver closing hardest reads as the smallest gap, and a stopped car divides by nearly zero.
5. **`CarDistAhead` is the wrong signal.** It is the nearest car physically ahead in *any* lane. In `131947` it names the car alongside in the other lane (#6, 2.2 m) while the car ahead in the player's own lane (#67) is 11.9 m up. In `094029` it names a car being passed (0.5 m). It agrees with the in-line gap only single file, where the two are the same car.
6. **`CarIdxOnPitRoad` is not trusted per car here, as elsewhere in the translator.** It reads true for indices 18–37 in all five snapshots and in the 2026-09-17 watch: two racing cars on track, and eighteen empty slots. This repo already knows it (`race-finish.ts`, `opponent-pit.ts`, `pace-laps.ts`). Per-car pit state comes from `CarIdxTrackSurface`, and the player's own from `OnPitRoad`.
7. **The earlier watch recordings cannot calibrate a gap.** Neither `telemetry-watch-20260917-*` nor `-20260918-*` recorded `CarIdxLapDistPct`, so every threshold below that a capture sets needs a new recording (see *Captures*).

iRaceDeck cannot read the threshold at which iRacing's own "catch up" message appears. Telemetry carries no variable for it. The evidence bounds it between 13.1 m (not shown) and 36.5 m (shown): between 1.3× and 3.4× the pack.

## The threshold

**A gap is open when it exceeds `CATCH_UP_RAISE_MULTIPLE` × the pack spacing, and closed again only below `CATCH_UP_CLEAR_MULTIPLE` × it.** The multiples are hysteresis, so a gap hovering at one threshold cannot flap. Both are provisional until capture C1: raise **2.5×** (26.5 m on the measured pack), clear **1.75×** (18.6 m). Raise sits between the widest normal reading (1.55×) and the smallest catch-up reading (3.4×) with margin both ways. Clear sits above the widest normal reading, so a car that has genuinely closed up is never still "open".

Three details make the ratio well-defined:

- **The reference for a pair with the pace car is `CATCH_UP_PACE_CAR_SPACING_FACTOR` (2) × the pack spacing**, from finding 2. A leader, or the outside front-row car, is therefore compared at about 20 m of normal, not 10 m.
- **A pair is a car and the car it follows under the lineup's own rule.** Since #1127's fix round that rule is the nearest in-world car in the same line with a lower row, not simply the row below: a car that has left the world keeps its row for a tick. `caution-lineup.ts` exposes that rule as one function, which both the lineup and the spacing call, so the two can never pair different cars. In all five snapshots every car is in world, so this is exactly the consecutive-row pairing the table above was computed with.
- **A spacing needs `CATCH_UP_MIN_SPACING_SAMPLES` (4) pairs.** Pairs with either car off the track surface (`CarIdxTrackSurface` not `OnTrack`/`OffTrack`), or not lined up, do not count. Below four there is no reading and no call: silence, not a guess. That costs a field of five cars or fewer.
- **The gap is measured to the car the lineup names, never to the nearest car.** It is a pairwise circular distance between two cars the lineup has already identified, so it is not a track-order walk and `race-positions.md`'s "never sort by lap distance" rule is untouched. The arithmetic lives beside `nearestCarGapMeters` in `iracing-sdk`'s `track-utils.ts`, as a new `forwardGapMeters(telemetry, fromIdx, toIdx, trackLengthMeters)` applying `carInWorld`, not inside the diff. #1170 (the leader catching the pace car) specifies the same primitive under the same name. Whichever issue lands first adds it, and the other consumes it. The two calls themselves never overlap: #1170 speaks only while the caution waves, catch-up never does.

Why a multiple and not a unit: iRacing's own pacing keeps *some* spacing (10 m at 29 m/s here). The ratio is the same whether that spacing is a fixed distance or a fixed time, so it survives a second track and a second car without knowing which. A metre or seconds threshold would have to guess (see *Rejected alternatives*).

**Where the engineer's threshold stands relative to iRacing's message.** The engineer is standalone and need not match the sim's UI, but the two disagreeing by a lot would read as a bug. So capture C1 sets `CATCH_UP_RAISE_MULTIPLE` to the ratio at which iRacing's message appears, clamped to **[2.0×, 3.4×]**. The floor is deliberate: below 2.0× the normal tail jitter (1.55×) is too close for a three-second dwell to separate. If iRacing's message comes earlier than 2.0×, the engineer stays deliberately later than the sim. The ceiling is already measured, since the message was showing at 3.4× in `093306`.

## When it speaks, and when it stops

The translator runs a **catch-up episode** for the player: one continuous stretch of an open gap to one car. Each tick it does two things. It decides whether catch-up is **live** (can be judged at all), and if so whether the gap is open or closed.

**Catch-up is live only when all of these hold:**

| Condition | Why |
| --- | --- |
| The caution phase (`state.cautionPhase`, translator side) is `caught` or `one-to-go` | The waving field is not a pack (finding 3). On a road course this means one-to-go alone, since waving drops straight to `Caution \| OneLapToGreen` there (#1127's road finding). |
| No `Green` bit on the tick | Since #1127's fix round, a green rising with a caution bit still set (a yellow-checkered tick) is not a restart, so the phase alone would not end catch-up there. `diffLineup` already resolves no lineup under a `Green` bit, and catch-up consumes that lineup (see *Where it lives*), so this holds by construction. |
| At least `CATCH_UP_SETTLE_MS` (10 s, provisional) since the phase first became `caught` | The pickup lands on the *leader's* crossing, while the tail may still be compacting (finding 1). The pickup's own calls hold the floor then anyway. |
| The pace car is still on the track | Once it leaves for pit road after one to go, the field is seconds from the green, gaps open deliberately as cars get ready, and the restart call owns the moment. |
| The player is lined up, and not on pit road | A car in the pits holds no row. Dropping back on pit road is the speed limit, not a lag. |
| No drive-round is in progress (see *Suppression*) | |
| The car ahead in your line is not nearer behind you than ahead (forward gap ≤ half a lap), except within a pit-exit episode | See *Suppression*. |

**The episode:**

- **Opens** when the ratio has stayed at or above the raise multiple for `CATCH_UP_DWELL_MS` (3 s, provisional) continuously. The event `caution.gapOpened` fires. The dwell swallows the re-form at one to go and any one-tick transient: a crossing tick, a row reassignment.
- **Reminds** with `caution.gapStillOpen` every `CATCH_UP_REMINDER_MS` (30 s) while the gap stays open, at most `CATCH_UP_MAX_REMINDERS` (2) times, and **only if the driver is not closing**. Closing means the gap has shrunk by at least one pack spacing since the previous call. A driver who heard it and is doing it is left alone. The next reminder is scheduled from the moment one fires, never from a missed due time (the #951 rule), so a held-back reminder cannot drain as a burst.
- **Closes** silently when the ratio falls below the clear multiple. There is no "that's better" call.
- **Ends without closing** when catch-up stops being live: the green, the phase expiring, the pace car leaving, pit road, or a drive-round. It **restarts from zero** when the car ahead in your line changes. Then the dwell starts again, and a still-open gap produces a fresh first call naming the new car, after #1127's lineup-change call has named it.

It is **level-armed**, not edge-armed: every tick decides from the current gap, so a re-seed (a plugin restart, an SDK reconnect, a replay glance) cannot leave an open gap with no edge left to fire on (the #951 lesson). The episode state (dwell start, last call time and gap, reminder count) is **not** preserved across the replay wipe. It re-derives within one dwell of the first live tick back. The cost is that a glance can hand a driver who was already reminded twice a fresh first call, which is accepted.

**It does not stop at one to green.** The last caution lap is exactly when being in place matters. It stops when the pace car leaves.

**Not during a rolling-start formation.** #1167 narrates the formation on the same lineup reader, but catch-up is live only in a caution phase. A formation catch-up would be a decision on #1167's own frame of reference for the lineup, so it is left to that issue. This call does not consume #933's gap events either, which #1171 silences under a caution. It measures the lineup directly.

## Suppression

**Drive-round procedures.** The player's `CarIdxPaceFlags` carries `WavedAround`, `FreePass` or `EndOfLine`. In each case the car ahead in his line is legitimately a long way off, or even behind him, because he is being sent to the tail rather than lagging. `094029` is the case: 1,820 m, deliberate. Catch-up is suppressed from the moment any of the three bits is seen until the player **has taken his slot**. That happens when, with the bit still set, the gap to the car ahead in his line first falls below the clear multiple. That moment sets a per-caution latch, `cautionProcedureJoined`. From then on he is an ordinary car in the lineup, and a later drop-back gets the ordinary call. The bit alone cannot serve, because it stays set after joining: `094304` has the player at the tail at normal spacing still carrying `WavedAround`. So "suppress while the bit is set" would silence him for the rest of the caution. The latch updates in every caution phase, waving included, even though catch-up itself is not live then: a waved car can reach the tail before the pickup, and the pack spacing it compares against is looser while the caution waves, which only makes joining easier to register. The latch clears with the caution phase and is **preserved** across the replay wipe with `cautionPhase`. A glance must not lift a suppression, or re-impose one, that the live car has already settled.

All three bits suppress, although only `WavedAround` has ever been seen. A suppression asserts nothing about the sim: on a bit that never sets it is a no-op, and on one that does it is right. The *calls* for `FreePass` and `EndOfLine` are a different matter, and #1169 defers them.

**Ahead of your slot.** When the car ahead in your line is physically nearer *behind* you than ahead (forward gap over half a lap), the situation needs a "let it by", which this call does not say. So it stays silent. `094029`'s tail car was 0.76 lap forward, 0.24 lap behind. The flag already covers that one. What the geometric rule adds is the unflagged version. A lapped car can be moved back in the lineup with no bit set: #7, two laps down, went from sixth in the waving lineup to the back of line 0 by one to go (`094029` → `094304`). A player in that position would otherwise be told to "catch" the car he must let past.

**Pit exit: one call.** Leaving pit road under caution (the player's `OnPitRoad` true → false) opens a pit-exit episode. After `CATCH_UP_PIT_EXIT_GRACE_MS` (10 s) of getting up to speed, the dwell runs as usual, and the call fires **once**, with no reminders. The ahead-of-slot rule is waived, because a car that stopped while the field circulated can have the tail anywhere up the road. The call is worth making once: after a stop the driver does not know which car is the tail, and "catch car thirteen" tells him. Reminders are pointless, because he is catching the field on purpose.

**The first moments.** Nothing speaks while the caution waves, nor in the settle window after the pickup, nor inside any dwell. The first call a caution can produce therefore lands at least `CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS` after the pickup.

## Which car, and the words

**The car named is the car ahead in your own line**: `followCarIdx` from #1127's lineup (the nearest in-world car in your line with a lower row), the car its follow calls already name. The gap is measured to that same car. Double file, the car alongside in the other lane is irrelevant (finding 5). A lapped car lined up ahead of you is named like any other, since you line up behind it whatever its lap count.

| Case | First call (`pit-crew.caution-catch-up`) | Reminder (`pit-crew.caution-catch-up-reminder`) |
| --- | --- | --- |
| A car ahead the session can name | "Close it up — catch car ninety-five." / "Gap's opened. Close up on car ninety-five." / "You've dropped back. Catch up to car ninety-five." | "Still a gap. Close up on car ninety-five." / "Keep closing — you're still off the back of car ninety-five." |
| Only the pace car ahead (`caution.followsPaceCar`) | "Close up on the pace car." / "You've dropped off the pace car — close it up." | the same pool |
| A car ahead the session cannot name | "Close the gap to the car ahead." / "You've dropped back — close it up." | the same pool |

**The issue's own wording, "Catch car ninety-five.", is not used verbatim.** It needs a one-word "Catch" lead-in, and one-word clips were rejected in #1127. Each lead-in is a phrase that stops before "car", so "catch car ninety-five" is still what the driver hears at the end of the first variant.

The numbered branches follow #1127's pattern exactly. The script asks `caution.followsPaceCar`, then `caution.hasFollowCarNumber`, and only then puts the lead-in and `{{caution.followCarNumber}}` in one `optional` clause. The numberless branch is the call's fallback, so it never expands to nothing. No lane is named: the lane has not changed, and "catch" is about distance.

**A known limitation, inherited from #1127.** `caution.hasFollowCarNumber` asks the *session* whether it can spell the car's number. It does not ask the *voice* whether it has that clip, because a vocabulary resolver receives only the fire's `ScenarioContext`. So in a voice whose `car-number` group lacks the clip for this car, the numbered branch is still taken, its `optional` clause expands to nothing, and both the first call and the reminder are silent where the numberless fallback would have been right. This affects only a third-party pack with a partial `car-number` group; the reference voice ships all 1,110 clips. #1127's follow, one-to-go and lineup-change calls share it, and the fix belongs to that vocabulary rather than to this call.

## Where it lives

**The translator owns detection; a script condition could not.** A vocabulary condition is read when a call is being spoken, and nothing would start the call. The catalog has no periodic event to hang a polling contract on. Polling in the scenario layer was rejected by #1127 anyway: every voice pack and the harness must see the same event stream. The dwell, the hysteresis, the reminder clock and the drive-round latch all need state and time, which is what a diff module holds.

- **A pure measurement** in a new `diff/caution-gap.ts`, the stateless sibling of `caution-lineup.ts`. It takes one tick, an **already-resolved** `CautionLineup`, and the track length. It returns the forward gap to the car you follow, the pack spacing, the ratio, whether that car is nearer behind you, and the player's decoded pace flags. The flags join `CautionLineup` itself, so every reader decodes them one way. It never resolves the lineup itself.
- **The episode machine** in `diff/caution.ts`, as `diffCatchUp`. Since #1127's fix round, `resolveCautionLineup` runs in exactly one translator place: inside `diffLineup`, after its early returns (no caution phase, or a `Green` bit), so no lineup is read under green.
  - `diffLineup` is changed to hand back the lineup it resolved, or `null` when it returned early. `diffCatchUp`, and #1169's `diffWaveAround`, run right after it on that value. One resolution per tick serves all three, and none of them runs under green.
  - `diffCaution` already takes a trailing `now` since the fix round (the restart stamp). It also needs `trackLengthMeters`, which `handleTick` resolves above it. Two adjacent optional numbers are the #1052 swap trap, so the trailing `now` becomes an options object, `{ now?, trackLengthMeters? }`. This is the shape #1170 specifies, and whichever of the two issues lands first introduces it.
  - The ordering constraint `diffCaution` carries (after `diffStartLights` and `diffFlags`) is unchanged.
- **A live reader**, `getCautionGap()` in `translator.ts`, beside `getCautionLineup()`. It builds on the **memoised** `getCautionLineup()` and memoises its own measurement on the same key: the identity of the telemetry snapshot and the session-info object. Several vocabulary entries and a gate can then ask within one expansion and pay for one measurement. The translator's latches are read fresh on top. It returns `null` when there is no lineup, and otherwise answers two questions:
  - `warranted`: catch-up is live, no procedure is in progress, and the ratio is at or above the clear multiple. The speak gate asks exactly this, so the event and the gate cannot disagree about the same tick.
  - `wavingAround`: #1169's condition, the player carrying `WavedAround` without `cautionProcedureJoined`.

**The contracts** join #1127's family builder, `buildCautionContracts(deps)`, and take `liveRaceCar` in `where:`, like the rest of it. The builder's `CautionContractDeps` object (`getCautionPhase`, `getCautionLineup` at `7a1c6e53c`) gains a third member, `getCautionGap: CautionGapResolver`. That reaches it the way its siblings do:
- a new `PitCrewDeps.getCautionGap`, defaulting to `() => null`, which makes both calls silent and leaves no stand-down in force;
- wired to the translator's `getCautionGap()` in all three plugins' `plugin.ts` and in the harness `main.ts`;
- passed through by `registerPitCrew` into the deps object.

| | First call | Reminder |
| --- | --- | --- |
| Event | `caution.gapOpened` | `caution.gapStillOpen` |
| `family` | none | none |
| `weight` | `WEIGHT.SAFETY − 2` (68) | `WEIGHT.NORMAL` (50) |
| `queueable` | `true` | `false` |
| `speakGate` | the family's shared check (`getCautionPhase() !== "none"`), and `getCautionGap()?.warranted` | the same |

- **No family.** Same-family preemption is wholesale and ignores weight. In `family: "flag"`, a catch-up would cut "One lap to green" mid-sentence. The #951 lesson: a nag must never share the family of the calls it runs beside.
- **It is queueable** under #1127's standing ruling that a caution call is never dropped for a busy bus. The gate is what keeps a queued one honest if the driver has closed up by the time it would play.
- **The first call is the lowest caution call but one, on purpose.** The single pending slot replaces on `>=`, so the ladder decides who survives a busy bus. At `7a1c6e53c` the ladder, top down, is:
  - `WEIGHT.CRITICAL`: the restart;
  - `WEIGHT.SAFETY` (70), in `family: "flag"`: one lap to green, Green Held, the lineup change, the pace car's calls, extra lap, two to green;
  - `WEIGHT.SAFETY − 1` (69), no family: the follow call and, since the fix round, the position call (and #1169's wave-around);
  - the catch-up at 68, then its reminder at 50.

  The follow call speaks only while the field waves and catch-up never does, so in practice the two never meet.
- **The last-lap window is where they do meet.** One lap to green, the position call at 35 % of the lap, Green Held and the catch-up can all be live there. The intended order is: the flag-family calls first, then the position, then the catch-up. A catch-up waiting in the pending slot is evicted by any of them, and it never evicts one. So a first call evicted there is lost, and its recovery is the reminder 30 s later, if the gap is still open and not closing.
  - Ranking catch-up above the position call was considered and rejected. The position call has no second chance on that lap; the catch-up has its reminder.
- **The reminder is the one caution call that is not queueable, and deliberately so.** Niklas confirmed this as a deliberate exception to his "never dropped for a busy bus" ruling (see *Confirmed by Niklas*). It recurs, so a reminder lost to a busy bus is replaced by the next one 30 s later. `WEIGHT.NORMAL` keeps it under every caution call. A dropped reminder still counts towards the two, because the translator schedules by cadence, not by delivery.
- **Two events, not one with a counter.** This follows #951 (`pitService.positioningRepeat` beside `pitService.statusChanged`): a repeat is not a transition. It also gives each call its own opt-in, so a driver who finds reminders naggy keeps the first call. Neither event carries a payload. The car is read live through the vocabulary, and a published field nothing reads is a contract maintained for no one (#1127).

**Vocabulary: nothing new.** The script uses `caution.followsPaceCar`, `caution.hasFollowCarNumber` and `caution.followCarNumber` as they stand. Whether a gap is still open is not a script decision: it decides *whether to speak*, so it belongs to the contract's gate (#1138).

**Settings** (two keys, default on, two rows in the Caution item of `race-engineer-callouts.ejs`):

| Key | Label | Callout id |
| --- | --- | --- |
| `calloutEnabledCautionCatchUp` | Catch the car ahead | `catch-up` |
| `calloutEnabledCautionCatchUpReminder` | Catch-up reminders | `catch-up-reminder` |

Both go through `CAUTION_CALLOUT_SETTING_KEYS`, so `SCENARIO_ID_TO_CAUTION_ID` stays derived rather than hand-written.

## Clips

Nine new clips in the `caution` group, no change to `car-number`:

- `catch-up-01..03` and `catch-up-again-01..02` are lead-ins that stop before "car", each carrying `next_text: "car ninety five"` and never `next_request_ids` (#1127).
- `catch-up-pace-car-01..02` and `catch-up-noname-01..02` are whole sentences.

Dry-run first, expecting exactly nine. Final text is settled from the dry run, as everywhere. The script and clips change the `default` pack's archive, so `pack:voice default` and a version bump come with it.

**`minPluginVersion`.** This edits the `default` voice's script: two new entries for two new contracts. If it ships in 3.3.0 itself, nothing is needed. If it ships in a later release, the `default` catalog entry carries `minPluginVersion` set to that release (the optional field in `deck-core/src/voice-pack-catalog.ts`, checked by `isVoicePackOfferable`). Otherwise an older plugin is handed a script with entries it cannot compile and falls silent on them.
- For this change alone the damage would be small. The two entries name contracts an older plugin never registered, so it skips just those two, with a warning each.
- The field still has to be set. It is per pack version, and #1169's edits to existing entries are likely to ride the same version.

## Testing

- **A committed fixture of the five snapshots**, `__fixtures__/caution-gap-20260919.json`, cut like the existing ones: cars 0–19 at their indices, the pace car as slot 20. It keeps `SessionFlags`, `PaceMode`, `Speed`, `OnPitRoad`, `CarDistAhead`, `CarIdxPaceLine`/`Row`/`Flags`, `CarIdxLapDistPct`, `CarIdxLapCompleted` and `CarIdxTrackSurface`, with the track length and `PaceCarIdx` supplied by the tests (the fixtures carry no session YAML). `094304` already lives in `caution-lineup-20260919.json`; the new file adds the other four. The pure measurement must read:
  - `093300` and `093306` open, at 4.7× and 3.4×;
  - `094304` and `131947` closed;
  - `094029` silent for three independent reasons: the caution is waving, the player is ahead of his slot (0.76 lap forward), and he is in a procedure. Each is also tested alone.

  `131947` also pins that `CarDistAhead` names the other-lane car, so a later "simplification" onto it fails a test rather than a driver.
- **Synthetic ticks for the machine:**
  - the dwell;
  - both thresholds and the band between them;
  - a reminder due while closing (skipped), while static (fired), and the cap;
  - a follow-car change restarting the episode;
  - pit road suppressing, and pit exit giving one call after the grace;
  - each pace flag suppressing until joined, then an ordinary drop-back calling;
  - ahead-of-slot silence;
  - the pace car leaving;
  - the phases (waving and green silent), and a `Green` bit with a caution bit still set (a yellow-checkered tick), which evaluates nothing because `diffLineup` resolved no lineup;
  - one lineup resolution per tick shared by `diffLineup` and `diffCatchUp`, asserted, so a later edit cannot quietly resolve it twice or under green;
  - the settle window;
  - a replay wipe preserving `cautionProcedureJoined` but re-deriving the episode;
  - a seed emitting nothing.
- **Contract tests** against the real reference script: each branch of the table above, the gate dropping a queued first call once the gap has closed, both opt-ins, and a caller that wires no `getCautionGap` staying silent (the `() => null` default).
- **The harness:** a "Caution → catch-up" button that, after the pickup, patches per-car lap distance to open the player's gap past the threshold, holds it through the dwell and one reminder, then closes it. It `requires: ["player-car-index"]` like its siblings. Both events join `event-names.ts`.

## Captures, and what each one sets

**C1 — the threshold (sets `CATCH_UP_RAISE_MULTIPLE`, `CATCH_UP_CLEAR_MULTIPLE`, `CATCH_UP_DWELL_MS`, `CATCH_UP_SETTLE_MS`).** Offline AI race at Homestead in the ARCA car, the same place the snapshots were taken, so the pack spacing is comparable. Record from before the caution to after the restart:

```bash
pnpm telemetry-watch --vars=SessionFlags,SessionState,PaceMode,PlayerCarIdx,Speed,OnPitRoad,PlayerTrackSurface,LapDistPct,CarDistAhead,DriverMarker,PushToTalk,CarIdxPaceFlags,CarIdxPaceLine,CarIdxPaceRow,CarIdxLapDistPct,CarIdxLapCompleted,CarIdxTrackSurface --mode=changes
```

Every record already carries `sessionTime`. `CarIdxLapDistPct` changes every tick, so this records at the full ~60 Hz. Expect several megabytes a minute, which is fine for a ten-minute run. Throw `!yellow`. After the pickup, from a mid-pack slot, lift gently so the gap to the car ahead grows **slowly**, about 1 m/s. At the instant iRacing's catch-up message appears, press the `DriverMarker` control (iRacing's telemetry marker). If it is unbound, hold push-to-talk for that instant instead; `PushToTalk` is in the list for that reason. Keep drifting to about 80 m, then close slowly and mark the instant the message disappears. Do it single file after the pickup, and again double file after `!restart double` with `!pacelaps +1` for time. Leave the recording running from the throw through the pickup, untouched, for the settle reading.

Readings:

- **Raise:** the ratio at each "appeared" mark, averaged, rounded down to 0.25, clamped to [2.0, 3.4].
  - Between 2.0 and 3.4 it is used as read.
  - Below 2.0, the engineer stays at 2.0, deliberately later than the sim (see *The threshold*).
  - It cannot come out above 3.4 (`093306`).
- **Clear:** the ratio at each "disappeared" mark, rounded up to 0.25, then bounded to [1.75, raise − 0.25]. The floor keeps clear above the widest normal reading (1.55×). If iRacing's message shows no hysteresis (appear = disappear), clear is raise − 0.5, still never below 1.75.
- **Dwell:** the longest excursion above the raise multiple by any car other than the player, at the pickup and at the double-file re-form, plus one second, never below 2 s. If there is no such excursion, 3 s stands.
- **Settle:** the time from the pickup until the pack spacing first comes within 20 % of its one-to-go value, rounded up to 5 s, never below 5 s. If the pack is already settled at the pickup, 5 s.

**C2 — a second track and car (a check, not a calibration).** The same recording at a road course or a different oval with a different car. If the formed pack's ratios still separate normal from lagging at the C1 multiples, nothing changes. If the normal tail jitter there reaches past `CATCH_UP_CLEAR_MULTIPLE`, clear moves up to that jitter plus 0.25, and raise follows to stay at least 0.25 above it, still capped at 3.4. What C2 does *not* decide is whether iRacing's own message uses metres or ratio. The engineer's model is its own.

None of these block implementation: every constant has a provisional value inside the bounds the snapshots already fix.

## Rejected alternatives

- **Absolute metres.** They encode one track's and one car's pacing. The ratio makes the same decision without knowing which unit iRacing paces by.
- **A time gap, distance ÷ your own speed.** Measured wrong in `093306` (finding 4), and undefined for a stopped car.
- **A time gap at pace speed**, from the pace car's lap-distance rate. It fixes the denominator but is metres over a per-track constant, so it inherits the metres problem. It also needs a rate estimate the ratio does not.
- **`getLiveGapBetween` (#933's crossing-time gap).** Also a pace-speed time, with a trace store behind it. The ratio needs neither, and is testable on one snapshot tick.
- **`CarDistAhead`.** Nearest car in any lane (finding 5).
- **Suppressing while a pace flag is set.** It stays set after joining (`094304`), which would silence the call for the rest of the caution.
- **A fixed lap-fraction cutoff** ("never call beyond half a lap") in place of the ahead-of-slot and pit-exit rules. It silences exactly the pit-exit case the call is most useful for.
- **Stopping at one to green.** That is the lap it matters most.
- **One event with an occurrence counter.** A condition reading the event payload, one opt-in for two behaviours, and a repeat dressed as a transition (#951).
- **A script condition read at speak time as the whole mechanism.** Nothing would trigger it.

## Order of work, and review

This lands after #1127 merges, in its own worktree. Order: the pure measurement and `forwardGapMeters` with the fixture, then the episode machine and the live reader, then the events and harness, then the contracts, vocabulary wiring, settings, clips and script. Last, the documentation:

- the Pit Crew page's caution section and switch list;
- the changelog, folded into the caution line if #1127's is still unreleased, its own Features line otherwise;
- an entry in `race-engineer-callout-examples.md`;
- a line in `race-positions.md` saying that the pairwise gap to a lineup-named car is not a track-order walk;
- the harness `CLAUDE.md`.

#1169 builds on the drive-round latch and `getCautionGap()` defined here. It adds to the published event catalog and to `GlobalSettingsSchema`, so the branch takes an `xhigh` review at the end.
