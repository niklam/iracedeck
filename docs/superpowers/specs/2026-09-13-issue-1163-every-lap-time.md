# Every lap time

> **Issue:** [#1163](https://github.com/niklam/iracedeck/issues/1163) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

**Delivered together with #1571** (the fastest lap of the race, `2026-11-01-issue-1571-fastest-lap-of-the-race.md`), in one worktree and one PR (Niklas, 2026-11-01): both read out lap times, and the precedence and drop rules below are shared with it, so neither ships without the other.

## The decision

A second Lap Time callout, `pit-crew.lap-time-last`, announces every completed lap as a timing screen shows it: *"Last lap was one forty five point two three seven."*

- **Trigger.** `lap.completed`, the same event and the same `LapLastLapTime` refresh the best-lap callout uses, in practice, qualifying and race.
- **One lap, one lap time.** On a lap the player completes, at most one of three callouts speaks, in this order: the fastest lap of the race (#1571, when the lap carries `isClassFastestLapOfRace`, `fastestLapAnnounceable` passes its two-lap grace and `calloutEnabledFastestLap`, and the active voice scripts `pit-crew.fastest-lap-race`), the best lap (#555, `isBest || isFirstValid` while `calloutEnabledLapTimeBestLap` is on and the voice scripts `pit-crew.lap-time-best`), then this one (while `calloutEnabledLapTimeEveryLap` is on and the voice scripts `pit-crew.lap-time-last`). Each line says more than the one after it, so it wins; with a switch off or a line the active voice does not script, its lap falls to the next, so a pack that scripts this callout but not the best-lap one still hears every lap. The rule is one pure function, `playerLapOwner`, in `catalog/pit-crew/lap-announcement.ts`, fed by one owner resolver built inside `registerPitCrew` (no new `PitCrewDeps` key), which all three contracts' `where:` call on the `lap.completed` payload, so the decision never depends on which line reaches the bus first. The owner can still end up saying nothing (a speak gate, a waiting fire superseded or timed out, the final lap of a race); the #1571 spec's decision 7 states it in full.
- **Laps that do not describe pace are silent.** A lap that started from pit exit or ended on pit road, and the final lap of a race, where the race-end result has the floor (the same rule the best-lap callout follows). An invalid lap (`lapIsValid` false) is still spoken: the driver asked for the time, and "that lap didn't count" is already the qualifying position callout's job.
- **Scheduling.** `WEIGHT.CHATTER`, `queueable`, its own family. Every other callout at the line (fuel, flags, position, race status) outweighs it or queues beside it. A `speakGate` admits the line only while no newer `lap.completed` has fired, so a queued lap time that waited out a busy line is dropped rather than read a lap late. That is the cooldown-free re-check #1138 introduced `speakGate` for. The comparison is `lapStillCurrent(lap, latest)` in `lap-announcement.ts`, the same function the #1571 gate calls, so the two callouts share one definition of "the next lap".
- **Switch.** `calloutEnabledLapTimeEveryLap`, labelled "Every lap", second row under Lap Time; default `true`, the convention for new Race Engineer callouts, read live per event.

## The readout

`LapLastLapTime` rounded to the millisecond, then spoken in three clips: the intro, the clock phrase, and the thousandths.

| Part | Spoken as | Example |
| --- | --- | --- |
| Intro | *"Last lap was"* (plus alternates written with the voice) | |
| Clock phrase | minutes and seconds as one clip, 1:00 to 10:59: *"oh"* for seconds 0–9 | *"one forty five"*, *"one oh five"* |
| Under a minute | the seconds alone, #555's `lap-time-second` | *"fifty eight"* |
| Thousandths | *"point"* and the three digits, one by one, as one clip | *"point two three seven"* |

A sub-minute lap: *"Last lap was fifty eight point oh four one."* Laps of 11 minutes or longer stay silent, the same ceiling the best-lap callout has.

**The readout code is shared.** The split and the pool references live in one module, `catalog/pit-crew/lap-time-readout.ts`, which holds two forms: #555's full sentence over the four existing `lap-time-*` pools (*"one minute, twenty-three, point four seconds."*), which the best-lap call keeps, and the compact form over the clips below, which this callout speaks to the thousandth and #1571's fastest-lap call to the tenth (Niklas, 2026-11-01). Each form rounds once at its own precision, and both share the eleven-minute ceiling. One module, so a change to how a lap time is split reaches every callout that reads one.

**The clips (decided by Niklas on 2026-11-01, after hearing the first set).** The first compact set (bare minute words cut per onset sound, a seconds pair, "point N" and a 00–99 pair, with no predecessor conditioning) sounded joined rather than spoken: "The combinations don't sound too good, and the thousands sound unnatural." So each part of the time is now one phrase, and the rule for every clip is his: "Each clip must have a previous_request_id set, and things that have something following, must have the next_text set." No text carries a period, which ElevenLabs reads as a pause after it, and every entry omits `seed` or sets it to 1; Niklas changes a seed himself when a clip sounds wrong.

| Group | Clips | `previous_request_ids` | `next_text` |
| --- | --- | --- | --- |
| Clock phrase | 1:00 to 10:59, minutes and seconds as one phrase ("one twenty three", "one oh five"), 600 clips | a fixed every-lap intro | "point" |
| Under a minute | #555's `lap-time-second`, 0–59, reused as it is | already set | already " point." |
| Thousandths | "point" and three digits, 000–999 ("point four five six", "point oh oh seven"), ending the line, 1000 clips | a fixed clock phrase | none: it ends the line |
| Tenths tail | "point" and one digit, 0–9, ending the line ("point four") — the form #1571 speaks, 10 clips | a fixed clock phrase | none |
| Intros | each intro once per onset sound of the time after it (#1571's and this callout's), regenerated | a fixed preceding line | a sample time with that onset |

About 1600 new number clips in the default voice, roughly 7 MB more in the packed voice. The Short Calls voice speaks the same numbers in the same voice, so its number clips are copies of Default's and cost no generation (the `race-engineer-callouts.md` step 3 rule for verbatim entries); only its intros are generated. **The set is trialled first:** a subset in the default voice only (a few clock phrases, thousandths, tenths and intros) goes on the review page beside the first set, and the full set is generated only once Niklas passes it.

A voice pack that does not script this callout simply never speaks it.

## Alternatives rejected

- **Reusing the best-lap readout** (*"one minute, forty-five point two seconds"*, tenths). A line that repeats every lap wants the compact form, and thousandths are what separate two laps of a consistent stint; a tenth hides exactly the difference the driver listens for. The best lap keeps its full sentence, since it is rarer and a moment worth marking.
- **A three-way select replacing the best-lap checkbox.** It breaks the one-boolean-per-callout shape that lets a new callout reach existing installs with no migration, and it would need a migration for `calloutEnabledLapTimeBestLap`.
- **Same family as the best-lap callout, letting family replacement dedupe.** Replacement is about in-flight lines, not about two fires on one tick. An explicit skip rule states the intent where it can be tested.
- **Not queueable.** At a busy start/finish line (fuel warning, race status) the lap time would drop on exactly the laps where the driver is busiest. Queueing plus the stale-lap gate keeps it both reliable and never late.

## Open to the requester

Whether they also want the delta to their best ("two tenths off") alongside or instead of the time. Not built here; a separate callout if wanted.
