# Black flag serve reminder

> **Issue:** [#1726](https://github.com/niklam/iracedeck/issues/1726) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The raise is already spoken once (`pit-crew.flag-black`, queueable since #923): _"We got the black flag. We have three laps to serve the penalty."_ After that the engineer is silent until the flag clears or a disqualification lands. This spec adds the countdown between the two, and corrects the raise line, which the races below show is wrong. Its box call depends on #1113 (decision 4), which merges first.

## Decisions

### 1. The sim's rule, from four races

The count is of **start/finish line crossings**: after the black flag the car may cross the line four times without serving, and the sim disqualifies it as it crosses the line the fifth time. Every crossing after the raise counts, however soon after it, and there is no grace. Measured on 2026-11-21 in four offline AI races, three road courses and an oval (the plugin log of that day, and the snapshot `local/telemetry-snapshot-20261121-150651-890.json` for the first), where the maintainer cut the track, was black-flagged a little late for it and drove on without serving. Times are UTC.

| | Tsukuba (lap ≈ 50 s) | Zolder (lap ≈ 85 s) | Spa (lap ≈ 132 s) | Charlotte oval (lap ≈ 30 s) |
| --- | --- | --- | --- | --- |
| `Black` rises | 13:02:31.4, ≈2 s before the line | 13:19:03.6, ≈8 s before the line | 13:32:39.1, ≈71 s before the line, mid-lap | 14:04:02.6, ≈17 s before the line, mid-lap |
| Laps logged after it (`lap.completed`) | 13:02:33.7, 13:03:24.3, 13:04:15.7, 13:05:05.7, 13:05:55.0 | 13:19:12.5, 13:20:37.4, 13:22:02.7, 13:23:27.5, 13:24:52.2 | 13:33:51.2, 13:36:03.2, 13:38:18.4, 13:40:31.2, 13:42:43.1 | 14:04:20.1, 14:04:50.5, 14:05:20.5, 14:05:52.1, 14:06:22.1 |
| `Disqualify` rises | 13:05:53.3, 1.7 s before the fifth lap is logged | 13:24:50.2, 1.9 s before it | 13:42:41.2, 1.9 s before it | 14:06:19.6, 2.4 s before it |

**The disqualification is at the line.** A logged lap is not the crossing: `lap.completed` waits for iRacing's lap time, and a refused lap that follows another refused lap (every lap after the flag here) is emitted `LAP_TIME_REFRESH_ALLOWANCE_MS` (2 s) after the crossing at the earliest, plus up to `LAP_RESULTS_SYNC_MAX_WAIT_MS` for the standings (`diff/laps.ts`). The disqualifications rose 1.7–2.4 s before the fifth logged lap, which is the crossing itself to within a fraction of a second, on four tracks whose pit-road lines lie anywhere from about 85 m (Spa) to about 200 m (Zolder) before the line. A fixed offset across those layouts fits the line and not the pit road, and the maintainer saw the disqualification come at the line. The first logged lap after each flag was the first refused one, emitted 0.4–0.9 s after its crossing (`diff/laps.ts`), which is why the flag times above are a little earlier than the logged gaps suggest.

**Four crossings allowed.** In every race the disqualification came on the fifth crossing after the flag. At Tsukuba the first crossing came about 2 s after the flag, at Spa more than a minute after it; both counted. The maintainer's first reading (pass the pits twice, must pit on the third, given with a hedge) and the raise line's "three laps" are both short of it.

For the driver this means the **last chance to serve is the last pit entry before the fifth crossing**: on the usual layout, the pit entry just before the line at the end of the fifth lap counting the one the flag came in.

The rule lives in one place, the translator's counting; the events below carry its result, so a correction later changes nothing downstream.

### 2. A crossing is the lap counter moving off pit road

A crossing is the tick on which the player's `LapCompleted` counter moves while the player's `OnPitRoad` is false — the same tick `diff/laps.ts` records as its crossing, not its later `lap.completed` emission, which can come seconds after (decision 1). The diff reads the counter from telemetry itself; it does not read the laps slice (rule C in `state-slices.test.ts`). A counter that moves on pit road is not counted: the driver is serving. Counting needs no landmark, so it works on a track nobody has pitted at yet.

### 3. The count, and when it stops

The translator holds one counter per black-flag episode in a slice of its own. The episode is read from the **level** on every tick, never from an edge: it is open while the player's `SessionFlags` has `Black` set and neither `Disqualify` nor `DQScoringInvalid` (the condition under which `flag.black.raised` speaks), and it counts crossings from 0. An edge would not survive a replay glance, because the flags diff re-seeds without one. The episode closes, and nothing more is said, when the level goes false (served, cleared by a steward or admin, or escalated to a disqualification), the session changes, or the player leaves the world. A later true level opens a fresh episode at 0.

**The slice survives a replay glance** (it joins `preservedAcrossReplay` in `translator.ts`, as #771 and #838 did). Wiping it would restart the count at 0, which is the unsafe direction: every warning would come late.

While the player is on pit road (`OnPitRoad`) nothing is counted and nothing is said: they are serving. If the flag is still out when they rejoin, the episode continues with the count it had.

### 4. Two sim-neutral events

Two distinct moments, two events, in the catalog's `flag.<name>.<moment>` shape (as `flag.white.raised` and `flag.white-last-lap.raised` are):

```typescript
"flag.black.lineCrossed": SimEvent<"flag.black.lineCrossed", { lapsLeft: number }>;
"flag.black.lastEntryApproaching": SimEvent<"flag.black.lastEntryApproaching", EmptySimEventPayload>;
```

- `lineCrossed` fires on each counted crossing that leaves at least one lap. `lapsLeft` is how many laps remain, counting the one just started, before the sim disqualifies: 4 after the first crossing, then 3, 2, and 1 after the fourth. The fifth crossing emits nothing; the sim disqualifies there. A second sim with another rule fills `lapsLeft` from its own, so the field is neutral.
- `lastEntryApproaching` fires once per episode, only with one lap left and a learned pit-lane split, when the player's seconds to `approachStart` (#1112, the split where the driver turns in) drop under `BLACK_FLAG_LAST_ENTRY_LEAD_S` (8 s, a named translator constant): late enough that the call is about this entry, early enough to lift and turn in. Without a learned split there is no box call; the last-lap reminder already says to box. A `previous` landmark kept across a track rebuild counts as not learned, as in #1113.

The rule (what counts, how many) lives in the iRacing translator as a diff module; the catalog carries only the outcome, so a second sim with a different rule fills the same events. No new package edge: the diff reads #1112's learner on the translator instance, the #1113 precedent, so `SimRuntime` gains no member.

**The seconds to the split come from #1113, which merges first.** `handleTick` computes one value, the player's seconds to `approachStart` or `null`, through #1113's tiered reference-time resolver (the landmark's per-class `estTime`, then the live class curve, then scaling by `CarClassEstLapTime`), and passes it to this diff as a value. The diff never reads #1113's traffic slice (rule C). `null` means no box call that lap; the reminders need no timing and do not wait on it.

### 5. What the engineer says

Two new contracts in the pit-crew flag family, one script entry each, every voice, and a corrected raise line. The texts are proposals for Niklas to approve before any clip is generated or regenerated:

| Contract | Fires on | Proposed line |
| --- | --- | --- |
| `pit-crew.flag-black` (existing; text corrected) | `flag.black.raised` | _"We got the black flag. We have five laps to serve the penalty."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.lineCrossed`, `lapsLeft` 4 | _"Black flag still out. Four laps left to serve it."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.lineCrossed`, `lapsLeft` 3 | _"Three laps left to serve the black flag."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.lineCrossed`, `lapsLeft` 2 | _"Two laps left to serve the black flag."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.lineCrossed`, `lapsLeft` 1 | _"Last lap to serve the black flag. Box this lap, or we're disqualified."_ |
| `pit-crew.flag-black-serve-now` | `flag.black.lastEntryApproaching` | _"Box, box. Serve the penalty."_ |

"Five laps" counts the lap in progress: the sim disqualifies at the fifth crossing, the end of the fifth lap counting the one the flag came in. A flag raised just before the line, as at Tsukuba, leaves almost nothing of the first of those five; the line is still the truth about where the end is, and the first reminder follows two seconds later with the exact count.

- **serve-reminder** runs at `WEIGHT.SAFETY`, `queueable`, in the existing `penalty` supersede group with a 30 s wait, so a disqualification raised while it waits replaces it (#923). It has a speak-time gate that the black flag still flies, because unlike the raise it can go stale: a driver who boxes after a queued reminder must not hear it on pit road. A supersede group ignores weight, so a reminder fired while the raise line still waits replaces it; that is accepted, since the reminder says the same thing with the current count.
- **serve-now** runs at `WEIGHT.CRITICAL` with `interrupt: true`, like the meatball, and is **not** queueable: a box call heard after the split is wrong, so it plays at once or not at all.

### 6. Race sessions only

Both new contracts fire only in a race session (`isRaceSession`). Disqualification is the consequence the count exists for, and only races were measured; a black flag in practice or qualifying keeps its single raise line.

### 7. One opt-in, default on

`calloutEnabledFlagBlackServeReminder` in `@iracedeck/callout-settings`' flag family, default `true` (new Race Engineer functionality defaults on), covering both new contracts: a driver who wants the countdown wants the box call. Turning off the raise line does not turn these off; each key governs its own lines.

## Rejected

- **Counting pit-road line crossings** (this spec before the maintainer's observation). It counted the same in all four races, since every pit entry measured lies just before the line, but the sim disqualifies at the line (decision 1), it needs a learned landmark and fallbacks for every track nobody has pitted at, and on a layout whose pit entry comes after the line it would count a lap wrong.
- **Counting `approachStart` crossings** (this spec's first draft). Not where the sim checks, for the same reasons.
- **Timing the count from `lap.completed`.** It is emitted seconds after the crossing for a refused lap (decision 1), so each reminder would come late, and the last one could land after the driver had already passed the pit entry it is about.
- **Allowing two passes** (the maintainer's first reading) **or three** (this spec's model before the Spa race). Spa disqualified on the fifth crossing with the first more than a minute after the flag, so either would warn one or two laps early on every flag, and a driver who learns that the last-chance call is not the last chance stops trusting it.
- **A grace for a flag raised close to the line.** The first two races allowed it; Spa and Charlotte rule it out.
- **A repeating beep until served** (the #912 speeding-cue shape). A penalty is a decision, not a correction; one clear line per lap, and one box call, is enough, and a loop would mask the spotter.
- **Putting the count in the `flag.black.raised` payload.** The raise is one edge; the count changes after it.
- **One event with an `at: "passed" | "approach"` discriminator.** It names the engineer's speech rather than the sim fact, and its count carries nothing on the approach, where it is always 1.
- **Timing the box call from the landmark's `estTime` alone**, to avoid waiting on #1113. It would duplicate the first tier of #1113's resolver and stay silent in every class that has not yet driven the split.

## Out of scope

- Other penalty flags: the meatball, the furled black flag and the incident ladder's drive-through (#1110). A drive-through the ladder gives arrives as a black flag, so it is covered here without #1110 doing anything.
- A key icon or Session Info readout of the laps left.
- Opponents' black flags (#936 announces them; nobody counts their laps).
- Telling the driver which penalty it is (stop-and-go, drive-through, time) or why it was given — iRacing's own display says so, and the telemetry the translator reads does not.
- Practice and qualifying (decision 6).
- Measuring online races. All four captures are offline AI races; whether an online race counts the same is not measured, and a disagreement found there is a translator fix.
- `lap.completed`'s delay itself. It is deliberate (`diff/laps.ts`) and right for lap times; this diff simply does not use it.

## Testing

- **Unit, translator diff:** the four races as fixtures — a raise about 2 s, 8 s, 17 s and 71 s before a counter move, each followed by five counter moves giving `lapsLeft` 4, 3, 2, 1 and no event on the fifth, with each event on the counter-move tick rather than after a lap-time wait; a counter move while on pit road (not counted); a rejoin with the flag still out (count kept); a fall and a fresh raise (count reset); a DQ mid-episode (closed); an approach on a seeded `approachStart` firing `lastEntryApproaching` once with one lap left; no box call with no split, or a `previous` one; a replay glance mid-episode (count kept, the episode not reopened at 0); a `null` seconds-to-split (no box call, reminders unchanged).
- **Unit, contracts:** race-only gating, the speak-time gate on the reminder, the DQ supersede, serve-now not queueing, the opt-in.
- **Scenario harness:** entries for both events in `event-names.ts` and shortcut buttons for each new line.
- **The rule captures** are done (decision 1: three road courses and an oval). A capture that disagrees later — an online race, another car — goes to the translator's counting and an amendment here.
- **Manual:** an offline race with a deliberate cut, listening for the corrected raise line, the four reminders each just after the line and the box call before the last pit entry; and a second run that serves on the last lap and hears nothing after pit entry.
