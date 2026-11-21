# Black flag serve reminder

> **Issue:** [#1726](https://github.com/niklam/iracedeck/issues/1726) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The raise is already spoken once (`pit-crew.flag-black`, queueable since #923): _"We got the black flag. We have three laps to serve the penalty."_ After that the engineer is silent until the flag clears or a disqualification lands. This spec adds the countdown between the two. It depends on #1113 (decision 4), which merges first.

## Decisions

### 1. The sim's rule, as the maintainer states it

A black flag raised now lets the car pass the pit entry twice; on the third arrival at the pit entry it must come in, or the driver risks disqualification (Niklas, 2026-11-21). So the count is of **pit-entry passes**, not of start/finish crossings or of time. This is his ruling, given with a hedge ("I think"), and it is the model built here. The capture that confirms it is named in *Testing*; if it shows a different counter, the translator's counting changes and nothing downstream does, because the event below carries the result, not the rule.

### 2. A pass is crossing the pit-lane split on the racing surface

A pass is the player's car crossing the learned `approachStart` landmark (#1112, where the pit lane leaves the racing line) while its surface is `OnTrack` or `OffTrack`, never `AproachingPits`. `approachStart` rather than `pitRoadStart`: it is where the driver decides, and every car on the server teaches it, while `pitRoadStart` needs a sound `CarIdxOnPitRoad`, which the #1112 captures show often is not. A crossing is the wrap-aware edge of `LapDistPct` past the landmark between two ticks, found with the existing primitives — `diff/lead-point-sweep.ts`, which corner names and sector starts share, over `@iracedeck/track-data`'s `normalizePitLanePct` / `pitLaneSignedDeltaPct` — never a new copy of the wrap math (`sim-events-iracing/CLAUDE.md`).

**Without a learned `approachStart`**, the start/finish crossing (`lap.started`) stands in for a pass. Pit lanes sit beside the line on nearly every track, so the two counts agree except when the flag is raised between the two points: raised between the split and the line, the fallback counts one pass the sim does not and warns a lap early; raised between the line and a split that lies after it, it misses one and warns a lap late. The second is the only unsafe case, it needs an unusual track layout and an unlucky moment, and it ends the first time any car's pit visit teaches the split, usually in the first laps of a race. The fallback is logged at debug once per flag.

A `previous` landmark kept across a track rebuild counts as not learned, as in #1113: a pass point a few metres off is harmless here, but a rebuilt pit lane can move the split far enough to change which side of the line it is on.

### 3. The count, and when it stops

The translator holds one counter per black-flag episode in a slice of its own. The episode is read from the **level** on every tick, never from an edge: it is open while the player's `SessionFlags` has `Black` set and neither `Disqualify` nor `DQScoringInvalid` (the condition under which `flag.black.raised` speaks), and it counts passes from 0. An edge would not survive a replay glance, because the flags diff re-seeds without one. The episode closes, and nothing more is said, when the level goes false (served, cleared by a steward or admin, or escalated to a disqualification), the session changes, or the player leaves the world. A later true level opens a fresh episode at 0.

**The slice survives a replay glance** (it joins `preservedAcrossReplay` in `translator.ts`, as #771 and #838 did). Wiping it would restart the count at 0, which is the unsafe direction: every warning would come late.

While the player is on pit road (`OnPitRoad`) nothing is counted and nothing is said: they are serving. If the flag is still out when they rejoin, the episode continues with the count it had.

A flag raised while the car is already past the split but before the line counts on the next crossing only; the conservative reading (assuming the sim counted it) is not taken, because the raise line has already promised three laps and the first reminder would contradict it.

### 4. Two sim-neutral events

Two distinct moments, two events, in the catalog's `flag.<name>.<moment>` shape (as `flag.white.raised` and `flag.white-last-lap.raised` are):

```typescript
"flag.black.entryPassed": SimEvent<"flag.black.entryPassed", { entriesLeft: number }>;
"flag.black.lastEntryApproaching": SimEvent<"flag.black.lastEntryApproaching", EmptySimEventPayload>;
```

- `entryPassed` fires on each counted pass that leaves at least one entry. `entriesLeft` is how many arrivals at the pit entry remain, counting the next one, before the sim disqualifies: 2 after the first pass, 1 after the second. A pass that reaches 0 emits nothing; the sim takes it from there. A second sim whose rule counts laps fills `entriesLeft` with one chance per lap, so the field is neutral.
- `lastEntryApproaching` fires once per episode, only with one entry left and a learned split, when the player's seconds to `approachStart` drop under `BLACK_FLAG_LAST_ENTRY_LEAD_S` (8 s, a named translator constant): late enough that the call is about this entry, early enough to lift and turn in.

The rule (how many passes, what counts as one) lives in the iRacing translator as a diff module; the catalog carries only the outcome, so a second sim with a different rule fills the same events. No new package edge: the diff reads #1112's learner on the translator instance, the #1113 precedent, so `SimRuntime` gains no member.

**The seconds to the split come from #1113, which merges first.** `handleTick` computes one value, the player's seconds to `approachStart` or `null`, through #1113's tiered reference-time resolver (the landmark's per-class `estTime`, then the live class curve, then scaling by `CarClassEstLapTime`), and passes it to this diff as a value. The diff never reads #1113's traffic slice (rule C in `state-slices.test.ts`: a fact from another family arrives as a value `handleTick` reads). `null` means no box call that pass; the reminders on each pass need no timing and do not wait on it.

### 5. What the engineer says

Two contracts in the pit-crew flag family, one script entry each, every voice; the texts below are proposals for Niklas to approve before any clip is generated:

| Contract | Fires on | Proposed line |
| --- | --- | --- |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 2 | _"Black flag still out. Two laps left to serve it."_ |
| `pit-crew.flag-black-serve-reminder` | `flag.black.entryPassed`, `entriesLeft` 1 | _"Last lap to serve the black flag. Box this time by, or we're disqualified."_ |
| `pit-crew.flag-black-serve-now` | `flag.black.lastEntryApproaching` | _"Box, box. Serve the penalty."_ |

- **serve-reminder** runs at `WEIGHT.SAFETY`, `queueable`, in the existing `penalty` supersede group with a 30 s wait, so a disqualification raised while it waits replaces it (#923). It has a speak-time gate that the black flag still flies, because unlike the raise it can go stale: a driver who boxes on the pass after a queued reminder must not hear it on pit road. A supersede group ignores weight, so a reminder fired while the raise line still waits replaces it; that is accepted, since the reminder says the same thing with the current count.
- **serve-now** runs at `WEIGHT.CRITICAL` with `interrupt: true`, like the meatball, and is **not** queueable: a box call heard after the split is wrong, so it plays at once or not at all.

### 6. Race sessions only

Both contracts fire only in a race session (`isRaceSession`). Disqualification is the consequence the count exists for, and only a race has been described to us with it; a black flag in practice or qualifying keeps its single raise line.

### 7. One opt-in, default on

`calloutEnabledFlagBlackServeReminder` in `@iracedeck/callout-settings`' flag family, default `true` (new Race Engineer functionality defaults on), covering both contracts: a driver who wants the countdown wants the box call. Turning off the raise line does not turn these off; each key governs its own lines.

## Rejected

- **Counting start/finish crossings everywhere.** Simpler, and matches the raise line's "three laps", but it is not the rule as stated, and on a track where the split comes after the line it is wrong by a whole lap every time, not only for an unlucky raise.
- **Counting `pitRoadStart` crossings.** Closer to where serving begins, but it is learned only from cars whose `CarIdxOnPitRoad` is sound, so the fallback would run far more often.
- **A reminder on every lap.completed.** It speaks at the line, which on most tracks is just after the split, so the last-chance call would come a lap too late for the entry it is about.
- **A repeating beep until served** (the #912 speeding-cue shape). A penalty is a decision, not a correction; one clear line per pass, and one box call, is enough, and a loop would mask the spotter.
- **Putting the pass count in the `flag.black.raised` payload.** The raise is one edge; the count changes after it.
- **One event with an `at: "passed" | "approach"` discriminator.** It names the engineer's speech rather than the sim fact, and its count carries nothing on the approach, where it is always 1.
- **Timing the box call from the landmark's `estTime` alone**, to avoid waiting on #1113. It would duplicate the first tier of #1113's resolver and stay silent in every class that has not yet driven the split.

## Out of scope

- Other penalty flags: the meatball, the furled black flag and the incident ladder's drive-through (#1110). A drive-through the ladder gives arrives as a black flag, so it is covered here without #1110 doing anything.
- A key icon or Session Info readout of the passes left.
- Opponents' black flags (#936 announces them; nobody counts their passes).
- Telling the driver which penalty it is (stop-and-go, drive-through, time) — iRacing's own display says so, and the telemetry the translator reads does not.
- Practice and qualifying (decision 6).

## Testing

- **Unit, translator diff:** a raise, two passes and an approach on a seeded `approachStart`, with both events and `entriesLeft` asserted; a pass while on pit road (not counted); a rejoin with the flag still out (count kept); a fall and a fresh raise (count reset); a DQ mid-episode (closed); the start/finish fallback with no landmark, and with a `previous` one; a raise between the split and the line; the wrap at `LapDistPct` 1 → 0; a replay glance mid-episode (count kept, the episode not reopened at 0); a `null` seconds-to-split (no box call, reminders unchanged).
- **Unit, contracts:** race-only gating, the speak-time gate on the reminder, the DQ supersede, serve-now not queueing, the opt-in.
- **Scenario harness:** entries for both events in `event-names.ts` and shortcut buttons for each of the three lines.
- **The rule capture (confirms decision 1):** a hosted race with an admin `!black` on the player, driving past the pit entry without serving, with the telemetry watcher running, noting the pass on which `Disqualify` rises. If it rises on the third arrival at the split, decision 1 stands; if on a start/finish count or a timer, the counting in decision 2 changes and this spec is amended.
- **Manual:** the same session, listening for the two reminders and the box call, and a second run that serves on the last lap and hears nothing after pit entry.
