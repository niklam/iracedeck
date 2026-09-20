> **Issue:** [#1187](https://github.com/niklam/iracedeck/issues/1187) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: the temperature figure recorded with its unit

## What is actually being removed

The issue carries the diagnosis. The design rests on one thing it does not state outright: the temperature clause has **two** joins, and they are not the same kind of join.

```text
"Track temperature is"    ->    "twenty eight"    ->    "degrees Celsius,"
  session-start/                session-start-temp-      session-start/
  track-temp-intro              numbers/28               degrees-celsius
```

The first join has exactly two possible predecessors — the track-temperature intro and the air-temperature one — and every one of the 151 number clips was generated conditioned on both (`previous_request_ids: ["session-start/track-temp-intro", "session-start/air-temp-intro"]`). Conditioning can work there because there are two pitches to bias towards. The second join has 151 possible predecessors and one recording of the unit, conditioned on three of them (20/25/30 for Celsius, 75/80/120 for Fahrenheit): for the other 148 the unit clip is a separate utterance cut against somebody else's pitch and energy. Recording the figure with its unit does not tune that join, it deletes it — the clause drops from two joins to one, and the one left is the kind conditioning was built for.

That is also the reason this is worth clip count rather than effort on the seam: there is no conditioning budget that reaches 151 predecessors. `previous_request_ids` takes at most three.

## What ships

> "Track temperature is twenty eight degrees Celsius, air temperature is twenty degrees Celsius, and the track is completely dry."

The same words. Each temperature clause is intro plus one clip instead of intro plus two, in whichever unit the driver's display is set to.

## Decisions

### 1. Two value groups, one per unit

`numbers-degrees-celsius` and `numbers-degrees-fahrenheit`, the naming following `numbers-percent` (#1108) and `car-number` before it. One entry per value, the text carrying the unit: `{ "name": "28", "text": "twenty eight degrees Celsius," }`.

Two groups rather than one group keyed `<value>-<unit>`. The engine's pool rule reads `<base>-NN.mp3` as a take of `<base>` (`poolMemberPattern`), so a name that ends in a hyphen and two digits is a shape to avoid in a group whose names are numbers; and the group is the unit of the var-driven reading that both the coverage test and `lint:pack` apply, so "this pack recorded Celsius only" is legible as a fact about a group rather than as a scatter of missing names.

The four resolvers keep their names — `sessionStart.trackTempNumber`, `sessionStart.airTempNumber`, `raceStart.trackTempNumber`, `raceStart.airTempNumber` — and choose the group from the snapshot's `tempUnit`. Renaming them is the same breaking change as removing one (decision 5) and buys nothing: the clause still needs "the temperature figure", which is what the name says.

### 2. The old clips go, and only one of the two removals is caught by a test

`session-start-temp-numbers` is deleted whole — 151 config entries and 151 mp3s — and **nothing would have failed if it were left behind.** The per-voice coverage test reads a group that no script step addresses as var-driven (`unscriptedGroupsAreVarDriven`, because the generator cannot see the vocabulary from where it runs) and never calls its clips orphans. No step addresses this group today and none will after, so 151 dead clips would ride in every download until somebody read the reference. `lint:pack` decides var-driven-ness off the vocabulary descriptions instead, so a _third-party_ pack still shipping the group would be told once no description names it — the bundled voice is the one that would not be. Deleting it is therefore a deliberate act, not something a red test will force.

The two `degrees-*` clips are the opposite case. They live in `session-start`, a group the script addresses directly, so they are exempt from the orphan rule only through the `session-start/degrees-(celsius|fahrenheit)` entry in the test's `VAR_DRIVEN_BASES`. That list is checked in both directions — a pattern matching no authored base is reported as stale — so the clips and the entry have to move in one commit: dropping the entry while the clips stay still passes, dropping the clips while the entry stays turns the allowlist test red.

One more edit rides with them: `session-start/wetness-intro` is conditioned on both degrees clips, and the config validator rejects a reference to a clip that is not defined (`Invalid previous_request_ids reference "…"`). Repoint it at one value clip per unit — whatever will actually precede it.

### 3. The range per unit, and below zero

| Group                        | Range    | Clips |
| ---------------------------- | -------- | ----- |
| `numbers-degrees-celsius`    | −20 … 80 | 101   |
| `numbers-degrees-fahrenheit` | −5 … 176 | 182   |

Both sets cover the same physical span: −20 °C is −4 °F, and 80 °C is exactly 176 °F. That symmetry is the point of choosing the bounds together — a driver who switches iRacing's display units must never find one unit silent where the other spoke, which is precisely what a shared 0–150 group produced.

**Negative readings are in scope.** The snapshot builder rounds and hands the resolver a plain integer (`Math.round`, in the translator's `toDisplayTemp`), so a below-zero Celsius reading already reaches the pool lookup as `-4`, finds nothing, and drops the whole clause — silently, because the clause is `optional`. Nobody will ever report that, and the fix costs 20 clips in a run that is happening anyway. They are named `minus20` … `minus1`, and the resolver spells the name rather than using `String(n)`: `-20.mp3` would be read by the take rule as a two-digit take of an empty base, and `minus-20` as a take of `minus`.

Flat 0–150 in both units — 302 clips, the issue's no-regression option — was rejected on both ends. It keeps the below-zero silence, and a Celsius reading above 80 is not a temperature the sim produces, so 70 of those clips are recorded for nothing while the ones a cold session needs are still missing.

The bounds are estimates and are cheap to be wrong about, so name the capture rather than guessing twice: a `TrackTempCrew` / `AirTemp` read at both extremes of iRacing's weather settings, which is a five-minute job and is the first implementation task (the #1108 wear capture is the precedent). Until it says otherwise, 80 °C is the sim's hottest observed track surface with a wide margin, and −20 °C is below any air temperature its weather model has been seen to produce. The cost of a wrong bound is one silent clause and a handful of clips in the next run.

Nothing here is expensive: the group on disk is 2.6 MB of committed mp3 for 151 clips (~17 KB each), and the published archive averages ~5 KB a clip (13.97 MB across 2,754). The whole range question is worth about a megabyte of download, which is why the bias is to record wide once rather than to re-cut.

### 4. A trailing comma in the text, and no `next_text`

Each entry's text ends with a comma and carries no `next_text` hint. The same clip serves the track-temperature and the air-temperature slot, and those are followed by different words — "air temperature is" and "and the track is" — so any hint would be right for at most one of them. #1108's amendment is the record of what a hint does to a set that outlives the phrase it was cut against: `session-start-temp-numbers` was reused for the tire-wear percentages and dragged " degrees Celsius," into every sentence that borrowed it.

The `previous_request_ids` pair (both intros) carries over unchanged, because after this change the intro → value join is the only join left in the clause and is the one worth conditioning. `numbers-percent` shipped with no conditioning at all; temperatures keep theirs because they have a genuine fixed predecessor pair to be conditioned on.

### 5. The two unit vars are removed, and that is a break in the pack format

`sessionStart.degreesUnit` and `raceStart.degreesUnit` are deleted, and both scripts' temperature clauses lose their third step.

State the consequence plainly, because it is bigger than it looks: the compiler catches an unknown var per **entry**, so a pack whose `callouts.json` still names `{{sessionStart.degreesUnit}}` loses the whole session-start brief — greeting, session line, pit-speed limit, wetness — not merely the temperature clause. It is at least loud: the skip carries its reason into the settings window's problems list, and `lint:pack` names it.

Keeping both vars registered as resolvers that always return `null` was weighed and rejected. A pack in that state loses its temperature clause anyway, since its old value clips sit in a group no resolver draws from any more, so the shim buys back the rest of the brief at the price of a var in the published reference that can never produce a clip — a trap for the next pack author reading it. The pack has to re-record and re-script for this change regardless, the format is young, and the regenerated reference ships in the same release.

### 6. The speed readout does not ride along — its own issue, the next release window

Recommended: keep it out of #1187 and file it separately, sequenced directly after so both land in one release.

Two facts the issue does not have. The speed readout's unit clips are `session-start/speed-unit-kmh|mph`, not `units/km|mph` — that pair belongs to the spotter call. And, deciding it: `session-start-speed-numbers` is shared by **two** callouts with two different unit sets. The session-start brief splices it against `session-start/speed-unit-kmh` ("kilometers per hour," — a comma, mid-brief); the no-limiter pit-entry callout splices it against `pit-limiter/unit-kmh-01` ("kilometers per hour." — a full stop, end of callout). One value-plus-unit set cannot serve both: choosing one punctuation hands the other consumer a line that ends on the wrong contour, which is the defect this issue exists to remove. The honest shape is two sets per unit — 152 clips — plus a decision about whether those two consumers should share a value group at all. That is a second design, not a second paragraph in this one.

The economy the issue wanted to protect survives the split. What is genuinely shared is not the generation run — runs are scoped with `--group` and cost credits per clip either way — but the pack version, the regenerated `catalog/default.json` and the publish. Both changes can ride one pack version as long as no publish happens between the two merges; a version that has been published is a name that cannot be reused.

The speed seam is also the milder one: 38 numbers, conditioned in **both** directions (every number carries `next_request_ids` naming both unit clips), against the temperature's 151 conditioned in one. It may not need fixing at all, which is a question for an audition rather than for this spec.

## Alternatives rejected

**Tuning the existing splice** — a different seed, different wording, more conditioning. `previous_request_ids` biases a generation; it does not join audio. The field takes three references and the unit clip would need 151.

**Re-cutting the unit clip per number** — `degrees-celsius-<n>` for every value, each conditioned on its own predecessor. Exactly the same 300-odd recordings as this design, and still two utterances played back to back, so it pays the whole price for none of the benefit.

**Joining in the build pipeline.** `presets.mjs` is a build-time ffmpeg filter over one clip. Making two clips into one would mean pitch-matching and cross-fading every pair at build time — 302 pre-rendered pairs by another name, with a filter chain that every other clip in the pack also passes through.

**One clip per slot, value and unit** — "Track temperature is twenty eight degrees Celsius," as a single recording. Four times the clips, and it freezes the intro wording into the value set; the intro is the one part that is already a single, well-conditioned clip.

## What else moves

- `packages/audio-assets/configs/default.voice.json` — the two new groups; `session-start-temp-numbers` and `session-start/degrees-{celsius,fahrenheit}` removed; `session-start/wetness-intro`'s conditioning repointed.
- The clip tree and `manifest.json` — 151 files deleted, 283 added, the manifest regenerated. Generate with `--group` scoping and a `--dry-run` first.
- `packages/audio-scenarios` — four resolvers repointed and their descriptions rewritten, two deleted, both scripts' clauses shortened, and the catalog/bundled-script tests updated. The descriptions are load-bearing rather than cosmetic: `lint:pack` decides var-driven-ness with `descriptionNamesGroup`, whose regex wants `<group>/<base>` or "`<group>` group" / "`<group>` clip group" in the **singular** — "the numbers-degrees-celsius and numbers-degrees-fahrenheit clip groups" matches neither group. Name each one in its own clause.
- `packages/audio-assets/src/generate/script-coverage.test.ts` — the `session-start/degrees-(celsius|fahrenheit)` entry in `VAR_DRIVEN_BASES` comes out with the clips (decision 2). `SCRIPTED_GROUPS_FLOOR` is untouched: `session-start` stays addressed through its intro and wetness pool steps.
- `packages/audio-assets/src/build/voice-packs.mjs` — the pack version (`1.0.1` today) and a regenerated `catalog/default.json`. The release workflow verifies the archive against that entry and fails the job on a mismatch.
- `packages/website/src/data/pack-reference.json` — regenerated (`pnpm generate:pack-reference`); committed and freshness-tested.
- `packages/audio-assets/voice/default/callouts.json` — regenerated from the config (`pnpm generate:callout-scripts`), likewise freshness-tested.
- The changelog, plus `pnpm generate:changelog-data`.
- **A third-party pack** records `numbers-degrees-<unit>/<value>` for the values its audience will meet, drops the unit step from its session-start and race-start entries (decision 5), and may delete its own `session-start-temp-numbers` and `degrees-*` clips. Nothing new is required of the plugins or the harness.

## Verification

Harness (`pnpm --filter @iracedeck/scenario-harness dev`): the Session Start panel sets Track, Air and the temperature unit directly and its inputs accept a negative, so both units, a below-zero value and each end of each range are auditionable without iRacing — Fire Session Start for the practice/qualifying brief, Scenario Shortcuts → Race Start for the race one. Listen for the seam at the intro, which is the join that remains.

Then in-sim: join a practice session and hear the brief about three seconds in, once with iRacing's display units metric and once imperial. The in-repo loop for that is #1143's — `pnpm dev:voices on`, `pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog`, then **Rescan voices** in the settings window.

Mechanically: `pnpm test` covers the coverage and freshness tests, and `pnpm lint:pack <packDir>` over the staged pack is what says the descriptions were written in a form `descriptionNamesGroup` accepts — a green suite will not, since the bundled voice's own groups are var-driven either way.
