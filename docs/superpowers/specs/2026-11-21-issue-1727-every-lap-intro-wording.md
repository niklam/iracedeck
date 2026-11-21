# Every-lap intros that cannot be heard as the final lap

> **Issue:** [#1727](https://github.com/niklam/iracedeck/issues/1727) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `4baef85e6`.

## The problem

The every-lap call (`pit-crew.lap-time-last`, #1163) is `["pool:lap-time-last/intro", "{{lapTime.clock}}", "{{lapTime.thousandths}}"]` in both first-party scripts, and the pool picks one intro per lap, uniformly at random with no immediate repeat. One intro in each voice opens with "Last lap": `lap-time-last/intro-01` is "Last lap was." in the Default pack (`default::default`, beside "That one was." and "You did a...") and "Last lap." in the Default (Short callouts) pack (`iracedeck-terse::shawn`, beside "Lap time."). The intro ends its own sentence, so the words "Last lap" stand alone before the time.

The call stays silent only on the lap that ends the race (`lapSilencedWhole`, `lap-time.ts`), so it does speak for the lap completed under the white flag, the same crossing on which the white-flag family speaks its second stage (`flags/white-last-lap`: "This is the last lap. Give it everything." in Default, "White flag, last lap." in Short callouts). Late in a race "Last lap." on its own reads as that call, and the driver thinks about the race ending instead of the lap just driven.

## Decisions

### 1. The intro is re-worded in place, under its existing entry name

In both voices `lap-time-last/intro-01` keeps its name and gets new text; no entry is added or removed and no other intro changes.

The name is load-bearing. Each voice's 600 `lap-time-clock` entries (1:00 to 10:59) name `lap-time-last/intro-01` in `previous_request_ids` (600 references in each config, counted at the measured commit), because #1163 cut every clock phrase to follow that intro. Since #1643 an entry's hash covers its own request with references as their raw `<group>/<entry-name>` strings and nothing cascades (`entryHash`, `audio-assets/src/generate/config.ts`), so a text edit on `intro-01` re-cuts exactly that clip and the 600 clocks keep their approved takes with unchanged hashes. A new name (`intro-04`) with `intro-01` deleted would instead fail `validateReferences` on 600 entries per voice, and repointing them would change 1,200 hashes: either 1,200 paid re-cuts, each a new take for Niklas's ear, or a hash migration for a change that needs none.

The clocks keep takes cut after the old "Last lap" intro. Both the old and the new intro end their sentence with a period, which is what the clocks were cut to follow (#1163: a sentence-final intro), so the join should hold; if Niklas hears a seam on the review page, the clock is re-cut on its own by a seed bump, per the audio rules. Any later deliberate re-cut of a clock conditions on the new take, which is correct.

### 2. The new wording (needs Niklas's approval before generating)

No intro in the `lap-time-last` group says "last" or "final", anywhere in its text. Each candidate ends its sentence with a period and carries none of the pause marks `pause-marks.ts` refuses, so none needs an approved exception.

Default (`configs/default.voice.json`), which reads in full sentences; the pool becomes the new line, "That one was." and "You did a...":

1. **"Previous lap was."** (recommended) — keeps the shape Niklas already passed for this slot and replaces the one word that misleads; "previous" cannot be heard as "final".
2. "Lap time was." — the plainest; close to Short callouts' "Lap time." without repeating it.
3. "Your time was." — the most conversational of the three.

Default (Short callouts) (`configs/shawn.voice.json`), radio shorthand; the pool becomes the new line and "Lap time.":

1. **"That lap."** (recommended) — two words, the fact itself, in the register of the pack.
2. "Previous lap." — the least ambiguous, one syllable longer.
3. "Your lap." — the softest.

Niklas picks one per voice or writes his own; the chosen text goes into the config before any clip is cut. Not offered: "That lap was.", which the issue suggests, because it is already `lap-time-intro/first-good-lap` in both voices, the intro the best-lap call speaks on a session's first counted lap, and the two calls would then sound identical.

### 3. Conditioning: exactly the existing intros'

The re-worded entry keeps the conditioning every intro in the group has: `previous_request_ids: ["lap-time-intro/best-lap-yet"]`, no `next_request_ids`, no `previous_text` or `next_text`, `seed` omitted. Only `text` changes, so the dry run shows one would-generate per voice. `best-lap-yet` is the same take in both voices (request id `KcDi2pSlMjJVvu2bmWHC` in both rows of `generate.manifest.json`), so if Niklas picks the same text for both voices the generator copies Default's take into Short callouts (`WOULD COPY`) rather than paying twice; with different texts each voice cuts its own.

Each new clip is approved on a review page (`review-page` skill) before it is committed, played through the build pipeline at the loudness of the clips around it (#1657): the new intro followed by a clock and a thousandths clip, beside the group's other intros in the same voice. A seed bump after hearing it is Niklas's call.

### 4. The pool keeps its name, and the published contract does not move

`pool:lap-time-last/intro`, the group and the base stay; the `pit-crew.lap-time-last` sequence is unchanged in both scripts. What a pack author builds against is the contract id `pit-crew.lap-time-last`, its event, gates and scheduling, and the `lapTime.*` vocabulary, and none of them changes. A pool is an address inside the pack's own voice tree, and voices are self-contained with no cross-voice fallback (`race-engineer-callouts.md`), so a third-party pack that recorded `lap-time-last/intro` from the reference recording script ("Last lap was.") keeps playing its own clips under its own script. Nothing in the plugin can or should remove them; removal is per pack.

What reaches third-party authors is the reference. Both configs' `pit-crew.lap-time-last` `comment` gains one sentence: no intro says "last" or "final", because near the end of a race that reads as the white-flag call (#1727). `pack-reference.json` regenerates from Default with that comment and the new line text in `lap-time-last`, so the Pack reference page shows both, and an author who wants the fix re-records their own intro. `minPluginVersion` stays `3.9.0`: nothing here is new to the engine.

### 5. Pack versions follow the pack record

Both archives change (one clip each, and `callouts.json` through the comment), so both catalog entries and pack records are regenerated by the flagless `pack:voice` run, and the version follows pack-record rule 4. At the measured commit both packs are at `2.0.0`, unpublished (`released` is `1.4.1` for `default` and `1.3.1` for `iracedeck-terse`; `2.0.0` ships with 3.9.0, #1643):

- merged before the `v3.9.0` tag publishes `voices-*-2.0.0`: both stay `2.0.0` and only the entries and records regenerate, the precedent `default` set at `1.0.0` (`audio-assets/CLAUDE.md`);
- merged after: both go to `2.0.1` in `src/build/voice-packs.mjs` (a wording fix, no new callout), and a between-releases publish needs `pnpm seal:voice-packs` first.

The implementer reads `released` in each `pack-records/<id>.json` at implementation time and applies whichever holds; the rule is decided here, the release date is not this spec's.

### 6. No other first-party line needs re-wording

A case-insensitive search of every `text` in both configs finds three lines whose text opens with "last lap": the two intros above and Short callouts' `telemetry-readout/fuel-last-lap-intro-01`, "Last lap,". The last one stays. It is the answer to a Session Info key press on Fuel → Last Lap, so it speaks only a moment after the driver asked for that figure, and the next clip is a fuel amount with its unit ("Last lap, two point four liters."); it never opens a call the driver did not request. Default's equivalent is "Fuel used last lap,", which does not open with the phrase. "Last Corner." and "Last Curve." are corner names, and every other "last lap" or "final lap" text is the white-flag family, where it is the message.

### 7. Documentation

- Website, `docs/actions/audio-voice/pit-crew.md`: the *Every lap* paragraph quotes "Last lap was." twice and the Short callouts sentence quotes "Last lap."; all three take the approved wording. The Pack reference page follows from the regenerated `pack-reference.json`.
- An `Improvements` fragment, `changelog.d/1727-every-lap-intro.md`: the every-lap call (shipped in 3.8.0) no longer opens with "Last lap". The 3.8.0 section of `changelog.mdx`, which quotes the old intro, is released and stays as it is.
- Scenario harness: nothing to add. The *Every lap 1:45.237* and *Every lap under a minute 58.041* shortcuts play the pool, so they play the new clip, and no harness label quotes the intro.

## Approaches weighed and rejected

- **A setting to drop the intro and read the time alone.** Decided by Niklas: no new setting; the wording fixes it for everyone. A pack that wants the bare time can already script the sequence without the pool.
- **Shortening the pause between intro and time.** The sequence has no `pause` step, so the gap is the clip boundary, and a shorter one still says "Last lap".
- **Deleting the "Last lap" intro with no replacement.** Short callouts would say "Lap time." every lap, Default would lose a third of its variety, and deleting `intro-01` breaks the 600 clock references per voice (decision 1).
- **A new entry name for the new intro.** 1,200 clock hashes would change for nothing (decision 1); the #1688 spec rejected the same move for `first-good-lap`.
- **"That lap was."** Already the first-counted-lap intro of the best-lap call in both voices (decision 2).
- **Renaming the pool or group** (for example to `lap-time-every`). The name is an internal clip address, not what a listener hears; renaming would churn the scripts, the tests and every third-party pack's addressing for no audible change.
- **Silencing the lap time on the white-flag lap.** Takes away a lap time the driver wants, and the wording would stay ambiguous everywhere else the white flag or a final lap is spoken about.

## Out of scope

- Third-party packs' recorded intros (decision 4).
- Short callouts' fuel readout "Last lap," (decision 6).
- The white-flag family's wording, and the order in which the white-flag call and the lap-time call play when both fire at the same crossing.
- Re-cutting any `lap-time-clock` entry, or changing its conditioning (decision 1).
- The best-lap and fastest-lap intros, and any change to which call speaks a lap.
- The released sections of `changelog.mdx`.

## Testing

Unit and generator, in `packages/audio-assets`:

- `generate:dry-run` shows exactly two would-generate, `lap-time-last/intro-01` in each voice (or one generated and one `WOULD COPY` if the texts match), nothing refused, and all 1,200 clock entries skipped.
- A new case beside the clip-text checks (`src/clip-text.test.ts`): no entry in a first-party voice's `lap-time-last` group has text matching `\b(last|final)\b` (case-insensitive). Positive control: it fails on the measured commit's texts before the config edit.
- `clip-text.test.ts`'s pause-mark checks pass with no new entry in `pause-marks.approved.json`; `callout-scripts.test.ts`, `script-coverage.test.ts`, `bundled-scripts.test.ts` and `pack-record.test.ts` pass after the configs, `callouts.json` artifacts, catalog entries and pack records are regenerated.
- `pack-reference.json` regenerated: the `lap-time-last` / `intro` line lists the new Default text and no "Last lap was.", and the `pit-crew.lap-time-last` comment carries the new sentence.

In `packages/audio-scenarios`, `lap-time.test.ts` and `lap-time-precedence.test.ts` stay green unchanged: they address the pool by base and the `intro-01` fixture path, both of which are kept.

Review page: both new intros, each followed by a clock and a thousandths clip at the processed loudness, beside the group's remaining intros; Niklas approves each before it is committed.

Scenario harness: *Every lap 1:45.237* and *Every lap under a minute 58.041*, pressed repeatedly in each voice, play every intro in the pool including the new one, and never "Last lap".

Manual, in the sim (Niklas): a race run to the flag in each voice; the lap-time call on the lap completed under the white flag, and every other lap, opens with the new wording or one of the kept intros, never "Last lap".
