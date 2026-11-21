# Black flag serve reminder

> **Issue:** [#1726](https://github.com/niklam/iracedeck/issues/1726) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The raise is already spoken once (`pit-crew.flag-black`, queueable since #923): _"We got the black flag. We have three laps to serve the penalty."_ After that the engineer is silent until the flag clears or a disqualification lands. This spec adds the countdown between the two, and corrects the raise line, which the races below show is wrong. It depends on #1113 (decision 4), which merges first.

## Decisions

### 1. The sim's rule, from four races

The count is of **pit-entry passes**: four are allowed, and the fifth crossing of the pit-road line without entering disqualifies. Every crossing after the raise counts, however soon after it, and there is no grace. Measured on 2026-11-21 in four offline AI races, three road courses and an oval (the plugin log of that day, and the snapshot `local/telemetry-snapshot-20261121-150651-890.json` for the first), where the maintainer cut the track, was black-flagged a little late for it and drove on without serving. Times are UTC; "before the line" is before the start/finish line.

| | Tsukuba (lap ≈ 50 s) | Zolder (lap ≈ 85 s) | Spa (lap ≈ 132 s) | Charlotte oval (lap ≈ 30 s) |
| --- | --- | --- | --- | --- |
| `Black` rises | 13:02:31.4, ≈2.3 s before the line | 13:19:03.6, ≈8.9 s before the line | 13:32:39.1, ≈72 s before the line, mid-lap | 14:04:02.6, ≈17.5 s before the line, mid-lap |
| First pass of the pit-road line after it | ≈0.4 s later | ≈4 s later | ≈70 s later | ≈15 s later |
| Start/finish crossings after it | 13:02:33.7, 13:03:24.3, 13:04:15.7, 13:05:05.7 | 13:19:12.5, 13:20:37.4, 13:22:02.7, 13:23:27.5 | 13:33:51.2, 13:36:03.2, 13:38:18.4, 13:40:31.2 | 14:04:20.1, 14:04:50.5, 14:05:20.5, 14:05:52.1 |
| `Disqualify` rises | 13:05:53.3, ≈1.7 s before the fifth crossing of the line | 13:24:50.2, ≈1.9 s before it | 13:42:41.2, ≈1.9 s before it | 14:06:19.6, ≈2.4 s before it |

All four disqualifications came on the **fifth pass of the pit entry after the raise**. The first two left open whether a pass seconds after the flag counted; Spa, with the first pass more than a minute after the flag and the same result, settles that it does and that four are allowed, and Charlotte shows an oval counts the same way. The maintainer's first reading (two passes, must pit on the third, given with a hedge) and the raise line's "three laps" are both short of it.

**Where the sim checks.** At Tsukuba the disqualification fell at the learned `pitRoadStart` (1.73 s of reference time before the line), and at Spa at its `pitRoadStart` too (85 m before the line, about 1.9 s at that speed). At Zolder it fell about 3 s after the learned line, by an estimate from a single-sample landmark learned on 2026-11-10 with no position in the log. So the sim checks at, or within a few seconds after, the pit-road line, always before the start/finish line. Counting at the pit-road line is therefore never later than the sim.

Charlotte had only the pit-lane split learned (`approachStart`, two samples from remote cars; the player never pitted, so `pitRoadStart` was not taught), so it is also the one race that would have run on decision 2's first fallback. With a flag raised mid-lap, the split counts the same passes as the pit-road line would, and the count matches.

The rule lives in one place, the translator's counting; the events below carry its result, so a correction later changes nothing downstream.

### 2. A pass is crossing the pit-road line on the racing surface

A pass is the player's car crossing the learned `pitRoadStart` landmark (#1112, where pit road and its speed limit begin) while the player's `OnPitRoad` is false. That is the line the sim checked (decision 1). The player's own `OnPitRoad` is sound in every capture #1112 cites, so the player's side of the check is reliable even where remote cars' `CarIdxOnPitRoad` is not; only the landmark's learning depends on the remote cars, and the player teaches it too on their own first pit visit. A crossing is the wrap-aware edge of `LapDistPct` past the landmark between two ticks, found with the existing primitives — `diff/lead-point-sweep.ts`, which corner names and sector starts share, over `@iracedeck/track-data`'s `normalizePitLanePct` / `pitLaneSignedDeltaPct` — never a new copy of the wrap math (`sim-events-iracing/CLAUDE.md`).

**Fallbacks, in order.** Without a learned `pitRoadStart`, the learned `approachStart` (the pit-lane split, a little before it, taught by every car on the server) stands in; without either, the start/finish crossing (`lap.started`) does. Each counts the same passes as the pit-road line except when the flag is raised between the two points, and since every crossing counts (decision 1), a missed crossing makes every later warning a lap late. So:

- **With only the split learned**, a flag raised after the split and before the next start/finish crossing counts one pass at once. The pit-road line almost always lies in that stretch, so this is the crossing the sim is about to count; where it does not, the count is one early, which is safe.
- **With only the start/finish line**, a flag raised between the pit-road line and a start/finish line after it is counted one early, which is safe. A flag raised between a start/finish line and a pit entry after it is missed, one late. That needs an unusual layout and an unlucky moment, and it ends the first time any car's pit visit teaches a landmark, usually in the first laps of a race.

The fallback in use is logged at debug once per flag. A `previous` landmark kept across a track rebuild counts as not learned, as in #1113: a rebuilt pit lane can move the line far enough to change which side of the start/finish line it is on.

### 3. The count, and when it stops

The translator holds one counter per black-flag episode in a slice of its own. The episode is read from the **level** on every tick, never from an edge: it is open while the player's `SessionFlags` has `Black` set and neither `Disqualify` nor `DQScoringInvalid` (the condition under which `flag.black.raised` speaks), and it counts passes from 0. An edge would not survive a replay glance, because the flags diff re-seeds without one. The episode closes, and nothing more is said, when the level goes false (served, cleared by a steward or admin, or escalated to a disqualification), the session changes, or the player leaves the world. A later true level opens a fresh episode at 0.

**The slice survives a replay glance** (it joins `preservedAcrossReplay` in `translator.ts`, as #771 and #838 did). Wiping it would restart the count at 0, which is the unsafe direction: every warning would come late.

While the player is on pit road (`OnPitRoad`) nothing is counted and nothing is said: they are serving. If the flag is still out when they rejoin, the episode continues with the count it had.

A flag raised just before the pit-road line counts the crossing that follows it, however soon, as the sim did at Tsukuba (decision 1).

### 4. Two sim-neutral events

Two distinct moments, two events, in the catalog's `flag.<name>.<moment>` shape (as `flag.white.raised` and `flag.white-last-lap.raised` are):

```typescript
"flag.black.entryPassed": SimEvent<"flag.black.entryPassed", { entriesLeft: number }>;
"flag.black.lastEntryApproaching": SimEvent<"flag.black.lastEntryApproaching", EmptySimEventPayload>;
```

- `entryPassed` fires on each counted pass that leaves at least one entry. `entriesLeft` is how many arrivals at the pit entry remain, counting the next one, before the sim disqualifies: 4 after the first pass, then 3, 2, and 1 after the fourth. The fifth pass emits nothing; the sim takes it from there. A second sim whose rule counts laps fills `entriesLeft` with one chance per lap, so the field is neutral.
- `lastEntryApproaching` fires once per episode, only with one entry left and a learned split, when the player's seconds to `approachStart`, the split where the driver turns in, drop under `BLACK_FLAG_LAST_ENTRY_LEAD_S` (8 s, a named translator constant): late enough that the call is about this entry, early enough to lift and turn in.

The rule (how many passes, what counts as one) lives in the iRacing translator as a diff module; the catalog carries only the outcome, so a second sim with a different rule fills the same events. No new package edge: the diff reads #1112's learner on the translator instance, the #1113 precedent, so `SimRuntime` gains no member.

**The seconds to the split come from #1113, which merges first.** `handleTick` computes one value, the player's seconds to `approachStart` or `null`, through #1113's tiered reference-time resolver (the landmark's per-class `estTime`, then the live class curve, then scaling by `CarClassEstLapTime`), and passes it to this diff as a value. The diff never reads #1113's traffic slice (rule C in `state-slices.test.ts`: a fact from another family arrives as a value `handleTick` reads). `null`, or no learned split, means no box call that pass; the reminders on each pass need no timing and do not wait on it.

### 5. What the engineer says

Two new contracts in the pit-crew flag family, one script entry each, every voice, and a corrected raise line. The texts are proposals for Niklas to approve before any clip is generated or regenerated:

| Contract | Fires on | Proposed line |
| --- | --- | --- |
| `pit-crew.flag-black` (existing; text corrected) | `flag.black.raised` | _"We got the black flag. We have five laps to serve the penalty."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 4 | _"Black flag still out. Four laps left to serve it."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 3 | _"Three laps left to serve the black flag."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 2 | _"Two laps left to serve the black flag."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 1 | _"Last lap to serve the black flag. Box this time by, or we're disqualified."_ |
| `pit-crew.flag-black-serve-now` | `flag.black.lastEntryApproaching` | _"Box, box. Serve the penalty."_ |

"Five laps" counts the lap in progress: the driver must be in the pits by the fifth arrival at the pit entry, which is the end of the fifth lap counting the one the flag came in. Tsukuba is the edge where the first arrival came 0.4 s after the flag; the line still holds, since the last chance was the end of that fifth lap.

- **serve-reminder** runs at `WEIGHT.SAFETY`, `queueable`, in the existing `penalty` supersede group with a 30 s wait, so a disqualification raised while it waits replaces it (#923). It has a speak-time gate that the black flag still flies, because unlike the raise it can go stale: a driver who boxes on the pass after a queued reminder must not hear it on pit road. A supersede group ignores weight, so a reminder fired while the raise line still waits replaces it; that is accepted, since the reminder says the same thing with the current count.
- **serve-now** runs at `WEIGHT.CRITICAL` with `interrupt: true`, like the meatball, and is **not** queueable: a box call heard after the split is wrong, so it plays at once or not at all.

### 6. Race sessions only

Both new contracts fire only in a race session (`isRaceSession`). Disqualification is the consequence the count exists for, and only races were measured; a black flag in practice or qualifying keeps its single raise line.

### 7. One opt-in, default on

`calloutEnabledFlagBlackServeReminder` in `@iracedeck/callout-settings`' flag family, default `true` (new Race Engineer functionality defaults on), covering both new contracts: a driver who wants the countdown wants the box call. Turning off the raise line does not turn these off; each key governs its own lines.

## Rejected

- **Counting start/finish crossings everywhere.** Simpler, but the sim checks at the pit-road line (decision 1), and on a track where the pit entry comes after the line it is wrong by a whole lap every time, not only for an unlucky raise.
- **Counting `approachStart` crossings first** (this spec's first draft). Every car teaches the split, but it is not where the sim checks: at Tsukuba the flag rose between the two, so the split would have missed a pass the sim counted.
- **Allowing two passes** (the maintainer's first reading) **or three** (this spec's model before the Spa race). Spa disqualified on the fifth pass with the first more than a minute after the flag, so either would warn one or two laps early on every flag, and a driver who learns that the last-chance call is not the last chance stops trusting it.
- **A grace for a flag raised close to the entry.** The first two races allowed it; Spa rules it out.
- **A reminder on every lap.completed.** It speaks at the line, which on most tracks is just after the pit entry, so the last-chance call would come a lap too late for the entry it is about.
- **A repeating beep until served** (the #912 speeding-cue shape). A penalty is a decision, not a correction; one clear line per pass, and one box call, is enough, and a loop would mask the spotter.
- **Putting the pass count in the `flag.black.raised` payload.** The raise is one edge; the count changes after it.
- **One event with an `at: "passed" | "approach"` discriminator.** It names the engineer's speech rather than the sim fact, and its count carries nothing on the approach, where it is always 1.
- **Timing the box call from the landmark's `estTime` alone**, to avoid waiting on #1113. It would duplicate the first tier of #1113's resolver and stay silent in every class that has not yet driven the split.

## Out of scope

- Other penalty flags: the meatball, the furled black flag and the incident ladder's drive-through (#1110). A drive-through the ladder gives arrives as a black flag, so it is covered here without #1110 doing anything.
- A key icon or Session Info readout of the passes left.
- Opponents' black flags (#936 announces them; nobody counts their passes).
- Telling the driver which penalty it is (stop-and-go, drive-through, time) or why it was given — iRacing's own display says so, and the telemetry the translator reads does not.
- Practice and qualifying (decision 6).
- Measuring online races. All four captures are offline AI races; whether an online race counts the same is not measured, and a disagreement found there is a translator fix.

## Testing

- **Unit, translator diff:** the three races as fixtures — a raise 0.4 s and 4 s before a seeded `pitRoadStart`, and one mid-lap, each followed by five crossings giving `entriesLeft` 4, 3, 2, 1 and no event on the fifth; an approach on a seeded `approachStart` firing `lastEntryApproaching` once with one entry left; a pass while on pit road (not counted); a rejoin with the flag still out (count kept); a fall and a fresh raise (count reset); a DQ mid-episode (closed); the `approachStart` fallback with no `pitRoadStart`, including a raise between the split and the next start/finish crossing (counted at once); the start/finish fallback with neither, and with a `previous` landmark; the wrap at `LapDistPct` 1 → 0; a replay glance mid-episode (count kept, the episode not reopened at 0); a `null` seconds-to-split (no box call, reminders unchanged).
- **Unit, contracts:** race-only gating, the speak-time gate on the reminder, the DQ supersede, serve-now not queueing, the opt-in.
- **Scenario harness:** entries for both events in `event-names.ts` and shortcut buttons for each new line.
- **The rule captures** are done (decision 1: three road courses and an oval). A capture that disagrees later — an online race, another car — goes to the translator's counting and an amendment here.
- **Manual:** an offline race with a deliberate cut, listening for the corrected raise line, the four reminders and the box call before the fifth entry; and a second run that serves on the last lap and hears nothing after pit entry.
