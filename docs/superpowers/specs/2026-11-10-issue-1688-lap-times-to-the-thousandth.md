# Lap times to the thousandth

> **Issue:** [#1688](https://github.com/niklam/iracedeck/issues/1688) · **Supersedes:** [the #1571 spec](2026-11-01-issue-1571-fastest-lap-of-the-race.md), decision 6 only, and [the #1163 spec](2026-09-13-issue-1163-every-lap-time.md), its rejected alternative "Reusing the best-lap readout" only where it keeps the best lap at the tenth · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `af41f7401`.

## The problem

Three callouts read the player's lap time, and at most one speaks per lap (`playerLapOwner`, `packages/audio-scenarios/src/catalog/pit-crew/lap-announcement.ts:61`): the fastest lap of the race (#1571), then the best lap (#555, which also takes the first valid lap of a session), then every lap (#1163). Only the last reads to the thousandth. The two that take precedence round to the tenth, so the laps a driver listens to hardest — a personal best, the first clean lap, a fastest lap of the race — are the ones read rounded. Niklas heard it in the sim on 2026-11-10 and took it for thousandths not having shipped.

## Decisions

### 1. Every lap time is read to the thousandth, in the compact form

The best-lap and fastest-lap calls read the time the way the every-lap call does: the clock as one phrase (`lap-time-clock/<m>m<ss>`, or `lap-time-second/<s>` under a minute) and the fraction as one phrase (`lap-time-thousandths/<ddd>`), both from `compactClockRef(t, "thousandths")` and `compactThousandthsRef(t)` in `lap-time-readout.ts`, so all three calls round a lap once and identically. 1:23.4566 is "one twenty-three point four five seven" in all three; 59.9996 is "one oh oh point zero" in all three; the eleven-minute ceiling is unchanged.

For the best lap this drops #555's full sentence ("one minute, twenty-three, point four seconds.") from the first-party scripts. Decided by Niklas on 2026-11-10 ("Compact"): it reuses the 600 clock and 1,000 thousandths clips each first-party voice already ships, where the full sentence at the thousandth would need 1,000 new "point … seconds." tails per voice. The #1163 spec kept the full sentence because a best lap is "a moment worth marking"; the intro ("That was your best lap yet.") still marks it, and a best lap is exactly where the third digit carries the news.

### 2. The best lap: a script change and one intro re-cut

Both first-party voices' `pit-crew.lap-time-best` entries become:

```json
["{{lapTime.intro}}", "{{lapTime.clock}}", "{{lapTime.thousandths}}"]
```

Every var already exists in the shared `lapTime.*` vocabulary (`lap-time.ts`), registered for #1163, and `lapTime.clock` already resolves at the thousandth from the same `lap.completed` snapshot the intro reads. No contract, gate, weight or precedence changes.

The compact clips are cut to follow an intro that ends its own sentence (#1163 revision 6: the period "makes it end cleanly and sharp"). `lap-time-intro/best-lap-yet` ("That was your best lap yet.") already does. `lap-time-intro/first-good-lap` ("That lap was") runs into the time and does not, so it is re-cut in both voices as **"That lap was."**, the shape Default's every-lap intro "Last lap was." already passed with Niklas. The text is approved by Niklas before generating and the clip on a review page, per the audio rules, levelled with the clips around it (#1657).

### 3. The fastest lap: a new clock-and-fraction pair at the thousandth

The fastest-lap vocabulary gains two vars, and both first-party scripts switch to them:

- `fastestLap.thousandthsClock` — `compactClockRef(t, "thousandths")`;
- `fastestLap.thousandths` — `compactThousandthsRef(t)`.

`fastestLap.clock` and `fastestLap.decimal` stay exactly as they are, the tenths pair, because a clock and its fraction must round at the same precision: `fastestLap.clock` moved to the thousandth beside an unchanged `fastestLap.decimal` would read 1:23.96 as "one twenty-three point zero", a second off. The vocabulary is a published pack contract (3.8.0), so a third-party script that pairs the two keeps working. Each pair's description says it is a pair.

The thousandths phrase ends the every-lap line already, so it ends this one too, and the gap clause keeps its `pause:150` before "Gap is". The gap itself stays at the tenth (decision 4).

### 4. Gaps stay at the tenth

The fastest-lap gap clause and the gap callouts read a gap, not a lap time, and a gap to the thousandth is noise over a gap that changes every tick. `lap-time-decimal` and `lap-time-second` keep serving them unchanged.

### 5. The clip groups nothing first-party speaks any more stay

After this change no first-party script reads `lap-time-minute`, `lap-time-tenths` or (for a lap time) `lap-time-decimal`. They stay in both first-party voices: they are var-driven groups the vocabulary documents (`lapTime.minute`, `lapTime.second`, `lapTime.decimal`, `fastestLap.clock`, `fastestLap.decimal`), third-party pack authors record from the reference voice's recording script, and the coverage test already skips var-driven groups whole, so they are not orphans. Retiring them would leave documented vars with no reference recording for 21 small clips per voice.

## Approaches weighed and rejected

- **The full sentence at the thousandth** ("one minute, twenty-three, point four five six seconds."). Keeps #555's register, at 1,000 new tails per voice conditioned on `lap-time-second`, each generated and approved. Niklas chose the compact form.
- **Moving `fastestLap.clock` to the thousandth in place.** Breaks any script pairing it with `fastestLap.decimal` (decision 3).
- **A precision setting** (tenths or thousandths per call). Nothing asks for tenths back; a setting would double the readout paths every lap-time test covers. If a driver asks, a script override in a pack already gives it, since both precisions stay in the vocabulary.

## Out of scope

- Gaps, in the fastest-lap clause or the gap callouts (decision 4).
- #1267's spoken lap time on a key press. Its draft quotes the full form at the tenth; when it is picked up it should read the compact form at the thousandth to match, which is its own spec's amendment.
- Removing the full-form or tenths vars from the vocabulary, or their clips (decision 5).
- A delta to the best lap ("two tenths off"), which the #1163 spec already left out.
- Any change to which call speaks a lap, the three opt-ins or their defaults.

## Testing

Unit, in `packages/audio-scenarios/src/catalog/pit-crew/`:

- `fastest-lap.test.ts`: `fastestLap.thousandthsClock` and `fastestLap.thousandths` for 1:23.456, 58.041 (under a minute), 125.007 (`2m05`, `007`), the 59.9996 carry to `1m00` / `000`, and 11:00.000 resolving to nothing; `fastestLap.clock` / `fastestLap.decimal` unchanged, with 1:23.96 as the positive control that the two pairs round independently.
- `lap-time.test.ts`: the best-lap entry of both bundled scripts expands to intro, clock, thousandths for a first valid lap and a personal best, and drops the whole line at the ceiling.
- `lap-time-precedence.test.ts`: the fixture clips and the expected expansions at the thousandth for all three owners; still exactly one call per lap.
- `audio-assets`' script-coverage test stays green for both voices with the re-cut intro, and `pack-reference.json` regenerates with the two new vars.

Scenario harness: the best-lap (first valid and new best) and fastest-lap (yours, ahead with the gap) shortcuts play the new lines in both voices.

Manual, in the sim (Niklas): in practice, the first clean lap reads "That lap was. One … point …" with three digits, and a later personal best "That was your best lap yet. One … point …" with three; in a race, a fastest lap of the race by the car ahead reads its time to the thousandth, then after the pause the gap to the tenth. The review page carries the re-cut intro clip in both voices before it is committed.
