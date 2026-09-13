# Every lap time

> **Issue:** [#1163](https://github.com/niklam/iracedeck/issues/1163) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A second Lap Time callout, `pit-crew.lap-time-last`, announces every completed lap as a timing screen shows it: *"Last lap was one forty-five point two three seven."*

- **Trigger.** `lap.completed`, the same event and the same `LapLastLapTime` refresh the best-lap callout uses, in practice, qualifying and race.
- **One lap, one lap time.** It stays silent on a lap the best-lap callout will speak for (`isBest || isFirstValid` while `calloutEnabledLapTimeBestLap` is on). The best-lap line says more than this one, so it wins. With that switch off, a best lap is just a lap and this callout reads it.
- **Laps that do not describe pace are silent.** A lap that started from pit exit or ended on pit road, and the final lap of a race, where the race-end result has the floor (the same rule the best-lap callout follows). An invalid lap (`lapIsValid` false) is still spoken: the driver asked for the time, and "that lap didn't count" is already the qualifying position callout's job.
- **Scheduling.** `WEIGHT.CHATTER`, `queueable`, its own family. Every other callout at the line (fuel, flags, position, race status) outweighs it or queues beside it. A `speakGate` admits the line only while no newer `lap.completed` has fired, so a queued lap time that waited out a busy line is dropped rather than read a lap late. That is the cooldown-free re-check #1138 introduced `speakGate` for.
- **Switch.** `calloutEnabledLapTimeEveryLap`, labelled "Every lap", second row under Lap Time; default `true`, the convention for new Race Engineer callouts, read live per event.

## The readout

`LapLastLapTime` rounded to the millisecond, then split into minutes, seconds and thousandths:

| Part | Spoken as | Example |
| --- | --- | --- |
| Intro | *"Last lap was"* (plus alternates written with the voice) | |
| Minutes | a bare number, 1–10; omitted under one minute | *"one"* |
| Seconds | a pair, 00–59: *"oh five"* for 1–9 and *"oh oh"* for 0 after a minute, plain under one minute | *"forty-five"* |
| Decimal | *"point"* | |
| Thousandths | three single digits, the last one in a phrase-final take | *"two three seven"* |

A sub-minute lap: *"Last lap was fifty-eight point oh four one."* Laps of 11 minutes or longer stay silent, the same ceiling the best-lap callout has.

This needs a vocabulary that exposes the parts, and pools in the default voice's config for the intro, the minutes, the second pairs, *"point"* and the digits.

**What is fixed: the number clips in this readout carry almost no padding.** Three digits back to back must run at the pace of a person reading a timing screen (*"two three seven"*), not as three separate words. Removing the padding is a property of the clip groups in the generation and trim pipeline, not a per-file hand edit, so a regenerated clip comes out tight too, and nothing between steps may put the gap back.

**What is decided at implementation time: which clips those are.** The default voice already has every number this readout needs, cut with padding so they stand alone. Two routes:

- **Trim the existing number clips, and add pauses where they are needed.** One set of numbers for the whole voice, and nothing new to record. The cost is that every existing script entry that relied on a clip's built-in padding for its rhythm gets an explicit pause step instead, so those entries have to be found and listened to. The change stays inside the default voice's clips and config; other packs keep their own clips and timing.
- **Record new number clips for this readout.** Nothing existing changes, at the cost of a second set of numbers in the voice, generated and trimmed tight from the start, and a phrase-final take for the last digit if the existing ones cannot end a sentence.

Choose by what the code shows once work starts: how many script entries use the number pools and how much of their rhythm the padding carries, whether the script grammar already has a pause step, and how a trimmed existing digit sounds at the end of a sentence.

A voice pack that does not script this callout simply never speaks it.

## Alternatives rejected

- **Reusing the best-lap readout** (*"one minute, forty-five point two seconds"*, tenths). A line that repeats every lap wants the compact form, and thousandths are what separate two laps of a consistent stint; a tenth hides exactly the difference the driver listens for. The best lap keeps its full sentence, since it is rarer and a moment worth marking.
- **A three-way select replacing the best-lap checkbox.** It breaks the one-boolean-per-callout shape that lets a new callout reach existing installs with no migration, and it would need a migration for `calloutEnabledLapTimeBestLap`.
- **Same family as the best-lap callout, letting family replacement dedupe.** Replacement is about in-flight lines, not about two fires on one tick. An explicit skip rule states the intent where it can be tested.
- **Not queueable.** At a busy start/finish line (fuel warning, race status) the lap time would drop on exactly the laps where the driver is busiest. Queueing plus the stale-lap gate keeps it both reliable and never late.

## Open to the requester

Whether they also want the delta to their best ("two tenths off") alongside or instead of the time. Not built here; a separate callout if wanted.
