# Every lap time

> **Issue:** [#1163](https://github.com/niklam/iracedeck/issues/1163) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

**Delivered together with #1571** (the fastest lap of the race, `2026-11-01-issue-1571-fastest-lap-of-the-race.md`), in one worktree and one PR (Niklas, 2026-11-01): both read out lap times, and the precedence and drop rules below are shared with it, so neither ships without the other.

## The decision

A second Lap Time callout, `pit-crew.lap-time-last`, announces every completed lap as a timing screen shows it: *"Last lap was one forty-five point two thirty-seven."*

- **Trigger.** `lap.completed`, the same event and the same `LapLastLapTime` refresh the best-lap callout uses, in practice, qualifying and race.
- **One lap, one lap time.** On a lap the player completes, at most one of three callouts speaks, in this order: the fastest lap of the race (#1571, when the lap carries `isClassFastestLapOfRace`, `fastestLapAnnounceable` passes its two-lap grace and `calloutEnabledFastestLap`, and the active voice scripts `pit-crew.fastest-lap-race`), the best lap (#555, `isBest || isFirstValid` while `calloutEnabledLapTimeBestLap` is on and the voice scripts `pit-crew.lap-time-best`), then this one (while `calloutEnabledLapTimeEveryLap` is on and the voice scripts `pit-crew.lap-time-last`). Each line says more than the one after it, so it wins; with a switch off or a line the active voice does not script, its lap falls to the next, so a pack that scripts this callout but not the best-lap one still hears every lap. The rule is one pure function, `playerLapOwner`, in `catalog/pit-crew/lap-announcement.ts`, fed by one owner resolver built inside `registerPitCrew` (no new `PitCrewDeps` key), which all three contracts' `where:` call on the `lap.completed` payload, so the decision never depends on which line reaches the bus first. The owner can still end up saying nothing (a speak gate, a waiting fire superseded or timed out, the final lap of a race); the #1571 spec's decision 7 states it in full.
- **Laps that do not describe pace are silent.** A lap that started from pit exit or ended on pit road, and the final lap of a race, where the race-end result has the floor (the same rule the best-lap callout follows). An invalid lap (`lapIsValid` false) is still spoken: the driver asked for the time, and "that lap didn't count" is already the qualifying position callout's job.
- **Scheduling.** `WEIGHT.CHATTER`, `queueable`, its own family. Every other callout at the line (fuel, flags, position, race status) outweighs it or queues beside it. A `speakGate` admits the line only while no newer `lap.completed` has fired, so a queued lap time that waited out a busy line is dropped rather than read a lap late. That is the cooldown-free re-check #1138 introduced `speakGate` for. The comparison is `lapStillCurrent(lap, latest)` in `lap-announcement.ts`, the same function the #1571 gate calls, so the two callouts share one definition of "the next lap".
- **Switch.** `calloutEnabledLapTimeEveryLap`, labelled "Every lap", second row under Lap Time; default `true`, the convention for new Race Engineer callouts, read live per event.

## The readout

`LapLastLapTime` rounded to the millisecond, then split into minutes, seconds and thousandths:

| Part | Spoken as | Example |
| --- | --- | --- |
| Intro | *"Last lap was"* (plus alternates written with the voice) | |
| Minutes | a bare number, 1–10; omitted under one minute | *"one"* |
| Seconds | a pair, 00–59: *"oh five"* for 1–9 and *"oh oh"* for 0 after a minute, plain under one minute | *"forty-five"* |
| Decimal | *"point"* | |
| Thousandths | a digit, then the last two as a pair, the way car numbers are read | *"two thirty-seven"* |

A sub-minute lap: *"Last lap was fifty-eight point oh four one."* Laps of 11 minutes or longer stay silent, the same ceiling the best-lap callout has.

This needs a vocabulary that exposes the parts, and pools in the default voice's config for the intro, the minutes, the second pairs, *"point"* and the digits.

**The readout code is shared.** The split and the pool references live in one module, `catalog/pit-crew/lap-time-readout.ts`, which holds two forms: #555's full sentence over the four existing `lap-time-*` pools (*"one minute, twenty-three, point four seconds."*), which the best-lap call keeps, and the compact form over the new clips below, which this callout speaks to the thousandth and #1571's fastest-lap call to the tenth (Niklas, 2026-11-01). Each form rounds once at its own precision, and both share the eleven-minute ceiling. One module, so a change to how a lap time is split reaches every callout that reads one.

**What is fixed: the number clips in this readout carry almost no padding.** The thousandths must run at the pace of a person reading a timing screen (*"two thirty-seven"*), not as separate words. Removing the padding is a property of the clip groups in the generation and trim pipeline, not a per-file hand edit, so a regenerated clip comes out tight too, and nothing between steps may put the gap back.

**The clips are a new compact set, each generated with the `next_text` of what follows it** (Niklas, 2026-11-01: smooth joins matter more than the number of clips). `next_text` decides how a clip ends, so it is what multiplies the takes: wherever the word that follows varies, the clip is cut once per distinct first word of it, and where it is constant ("point" after the seconds) once. No entry carries `previous_text` or `previous_request_ids`: a fixed preceding text conditions the clip on one value's ending ("twenty three" before every tail) and is wrong for all the others. No text carries a period, which ElevenLabs reads as a pause after it, and every entry omits `seed` or sets it to 1; Niklas changes a seed himself when a clip sounds wrong. The existing padded number clips stay as they are for the calls that use them. Every join in the readout is a clip boundary, and a clip generated with the right `next_text` ends on the right note for the word that follows it rather than on a sentence-final fall. So each group below is cut once per distinct continuation, and the readout picks the take that matches the value after it. The generator already supports `next_text` per entry (`audio-assets/src/generate/config.ts`).

| Group | Clips | `next_text` |
| --- | --- | --- |
| Minute | Each minute 1–10, once per first word of the seconds that follow: "oh" (00–09), each of "ten" to "nineteen", "twenty", "thirty", "forty", "fifty" — 15 takes a minute, 150 clips | that first word with a sample pair and tail, e.g. "twenty three point four" |
| Seconds after a minute | The pairs 00–59 ("oh oh", "oh five", "twenty three"), 60 clips | always "point" with a digit, e.g. "point four" |
| Seconds under a minute | 0–9 spoken plain ("five"); 10–59 reuse the pairs above, which are the same words — 10 clips | as above |
| Tenths tail | "point" with one digit, 0–9, as one clip ending the line ("point four"), 10 clips — the tenths form #1571 speaks | none: it ends the line |
| Thousandths, first digit | "point" with the tenths digit, 0–9, cut once per first word of the pair after it: "oh" (00–09), "ten" to "nineteen", "twenty" to "ninety" — 19 takes a digit, 190 clips | that first word with a sample pair |
| Thousandths, last two digits | Read as a pair, the way car numbers are ("point five sixty seven"): 00–99 ("oh oh", "oh seven", "sixty seven"), ending the line, 100 clips — the `car-number` clips where they are the same words and end the same way | none: it ends the line |

The thousandths are read as a digit and a pair (Niklas, 2026-11-01), so no clip is cut against a fixed next digit. The intros are a join too: what follows them is the minute, or under a minute the seconds' first word, so whether each intro is cut per following word is offered to Niklas with the clip text. The Short Calls voice speaks the same numbers in the same voice, so its clips are copies of Default's and cost no generation (the `race-engineer-callouts.md` step 3 rule for verbatim entries). "Point" and its digit are always one clip, so no join ever sits between them.

A voice pack that does not script this callout simply never speaks it.

## Alternatives rejected

- **Reusing the best-lap readout** (*"one minute, forty-five point two seconds"*, tenths). A line that repeats every lap wants the compact form, and thousandths are what separate two laps of a consistent stint; a tenth hides exactly the difference the driver listens for. The best lap keeps its full sentence, since it is rarer and a moment worth marking.
- **A three-way select replacing the best-lap checkbox.** It breaks the one-boolean-per-callout shape that lets a new callout reach existing installs with no migration, and it would need a migration for `calloutEnabledLapTimeBestLap`.
- **Same family as the best-lap callout, letting family replacement dedupe.** Replacement is about in-flight lines, not about two fires on one tick. An explicit skip rule states the intent where it can be tested.
- **Not queueable.** At a busy start/finish line (fuel warning, race status) the lap time would drop on exactly the laps where the driver is busiest. Queueing plus the stale-lap gate keeps it both reliable and never late.

## Open to the requester

Whether they also want the delta to their best ("two tenths off") alongside or instead of the time. Not built here; a separate callout if wanted.
