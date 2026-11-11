# Regenerate the Default engineer on the newest ElevenLabs model

> **Issue:** [#1643](https://github.com/niklam/iracedeck/issues/1643) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Both first-party voices use the same ElevenLabs speaker on `eleven_flash_v2_5`: Default (`configs/default.voice.json`, 4,810 clips in the authored manifest) and Short callouts (`configs/shawn.voice.json`, 4,717 clips, pack `iracedeck-terse`), which copies Default's clip wherever its entry is verbatim Default's. Flash was chosen for latency, which a pre-generated voice does not need. The issue asks for the same lines on the newest model.

## Decision

### The model

**`eleven_v4`**, set once at voice level (`model_id`) in both configs. Per-entry `model_id` overrides are removed (none exist in either config today), so the voice is one model throughout. #1572's trials established that it accepts:

- `seed` and `next_text`
- `previous_request_ids`, including ids of `eleven_flash_v2_5` takes

ElevenLabs ignores `previous_text` whenever `previous_request_ids` is present, as the house rule already says. Request stitching remains the hard requirement.

`language_code` has not been tried on v4. The trial set's two non-English corner names are where it is proven. A probe of one clip goes first, because the key cannot list models. Pronunciation dictionaries are not used by either config.

### Settings and seeds

- **`voice_settings` stay as they are** (stability 0.75, similarity_boost 0.85, style 0, speed 0.97, use_speaker_boost true). Those are what #1572's trial 1 was cut with, and Niklas judged it the best of seven v4 trials. They are retuned only if the trial page shows a need. A field v4 refuses is dropped from the config rather than sent.
- **Every seed is reset**: 246 Default and 135 Short callouts entries drop their `seed`, so all default to `1`. On v4 a seed does not even select a reproducible take; it is only the way to ask for a different one. Niklas re-picks by ear on the review pages.
- **SSML breaks are kept.** v4 stretches them (a 0.3 s break came out about 0.41 s). The trial covers entries with breaks, and an entry Niklas hears wrong gets its break shortened or turned into a period, entry by entry.
- **`previous_text` is dropped** from the six entries that carry it without `previous_request_ids`, and those entries are given the ids the house rule asks for. On the three that carry both, it does nothing and goes.
- The conditioning rules stand otherwise. If the trial shows one no longer holds on v4, `packages/audio-assets/CLAUDE.md` is amended in the same change.

### A take is the artifact: the cache stops cascading

On v4 the same request never returns the same audio twice. A clip on disk is therefore the only copy of a take Niklas approved, and the generator must never re-cut one he did not ask to change.

- **An entry's hash covers its own request only.** That is its options, plus the raw `<group>/<entry-name>` reference strings. It no longer folds in the recursive hashes of the entries it references. A seed bump or text edit re-cuts exactly that clip. The clips that reference it keep their takes, and the conditioning they were cut with points at the superseded take. Niklas re-cuts one of them by bumping its own seed when he hears the seam.
- **The full run costs nothing extra for this.** Changing the hash shape invalidates every entry once, but the model change already re-cuts every entry. Both land in this PR.
- **A take is never cut against a stale dependency.** A run refuses to generate an entry whose referenced entry is itself out of date, unless that entry is generated earlier in the same run. The refusal names the dependency and the `--group`/`--entry` scope that would cut it. The dry run reports the same. Without this, a scoped run could condition a v4 clip on a Flash take.
- **A request already paid for is never paid again.** When a voice's entry hashes identically to an entry already in the manifest under another voice, the generator copies that take and its request id instead of calling the API. The hash covers the ElevenLabs voice id and every audio-affecting option, so identical means identical. The dry run reports such entries as `WOULD COPY`. This automates the Short callouts copy rule (4,522 entries) and replaces the hand copy in `packages/audio-assets/CLAUDE.md`.
- **A take cut outside the generator is imported, never re-cut.** `generate --import <dir>` takes a trial's tree and its record of request ids, copies each file byte for byte into `voice/<voice>/<group>/<name>.mp3`, and writes its manifest row with the hash computed from the current config. The tree is laid out as `voice/<voice>/<group>/<name>.mp3`, and the record is the `trial-manifest.json` shape #1572's trial script writes. An entry missing from the config is refused. The command is for #1572's approved v4 takes and any later out-of-band trial. It is the frozen form of an approval: once a take's row matches the config, nothing re-cuts it.

### Both packs move together

Short callouts is the same speaker. A voice heard on two models depending on the pack would be the one result worse than either, so both configs change in one PR. The copy rule is unchanged: a Short callouts entry whose text, settings and seed are verbatim Default's is copied from the new Default clip, not generated twice.

### Generation order

The generator orders each run topologically over the reference graph: dependencies first, config order as the tie-break. `detectReferenceCycles` already guarantees the graph is acyclic. Voices run in a fixed order, Default first, so Short callouts' identical entries find their Default take to copy (previous section).

### Trial, then the full run

1. **Probe.** Cut one corner name with `language_code` on v4. That proves the last field the generator sends.
2. **Trial.** Cut the subset this section lists, for both voices, through the generator itself on the branch (`--entry` scoping), so the takes land in the manifest and no import is needed:
   - a compact lap-time readout (intro, minute-and-seconds, decimals)
   - a position readout
   - a gap readout
   - the pit readback body
   - a session-start brief with temperatures
   - three driver names
   - two non-English corner names
   - the spotter calls
   - two lines with SSML breaks
   - five Short callouts lines

   Present them old against new on a review page (`review-page` skill). Both sides are levelled with #1657's normalization, so the louder v4 takes are not favoured, and each clip is also offered through the full radio pipeline the plugin plays.
3. **Settings.** Retune `voice_settings` only if the trial page asks for it.
4. **Full run.** Generate both voices in one unscoped run, after a dry run whose counts are reported. The dry run must show every entry as would-generate or would-copy, none refused. Then `generate:manifest`, and a dry run reporting zero to generate.
5. **Re-picks.** Niklas reviews a second page with a wider sample. A clip he flags gets a seed bump and a scoped re-cut of that clip alone.

### Shipping

- **No version bump of its own.** The change lands on whatever unreleased version `master` carries: 2.0.0 for both packs once #1580 merges. If that version is sealed as released by then, both packs are bumped as the pack record requires.
- Then flagless `pack:voice default` and `pack:voice iracedeck-terse`, committing `catalog/*.json` and `pack-records/*.json` together.
- `minPluginVersion` is unchanged.
- Installed packs update themselves at launch (#1105).
- A changelog fragment under **Improvements** says the engineer was re-recorded on a newer voice model.

## Alternatives rejected

- **Upgrade Default only.** Short callouts would then be the same person on two models.
- **Keep the seeds.** They select Flash takes and carry no meaning on another model, and keeping them would look like a decision.
- **Order the full run by hand, by group.** It works once, but the next full re-cut would need the same care, and a mistake there is silent: a clip conditioned on a stale request id still generates.
- **A newer model without request stitching, conditioning on `previous_text` instead.** `previous_text` is the weaker signal, and Niklas's rule is that every clip carries `previous_request_ids`.
- **A new voice id instead of re-cutting `default`.** It would be a new pack users must choose, not an upgrade of the one they have.

- **Keep the dependency cascade and mark approved takes as locked.** It needs a second record beside the cache saying which takes are approved. A locked dependency would then block or skip its 1,698 dependents. And any re-pick still re-cuts every unlocked dependent, each needing a new listen. Dropping the cascade gives the same protection with no new state.

**One text change rides along (amended 2026-11-11).** `lap-time-intro/first-good-lap` becomes "That lap was." in both voices (from "That lap was"), text and conditioning already approved by Niklas for #1688, so the intro is cut once, on the new model, and its dependents are conditioned on it. Every other line keeps its text.

## Out of scope

- Any change to what the engineer says: text, scripts and callouts stay as they are.
- A different ElevenLabs speaker.
- The voice-roles work (#1642) and any new Spotter voice pack.
- Renaming voices or packs.

## Testing

- Generator unit test: a run whose config lists a dependent before its dependency generates the dependency first, and the dependent receives the new request id.
- `generate:dry-run` over both voices reports zero entries to generate after the full run. `script-coverage.test.ts`, `callout-scripts.test.ts`, `manifest.test.ts` and `pack-voice.test.ts` stay green, since the clip set does not change.
- `pack:voice` for both packs, then the publish dry run (*Publish voice packs* with `publish` off) verifies both archives against the committed catalog entries.
- By hand (Niklas): both review pages, then a session in iRacing on the development voice root (`pnpm stage:voices`) with each pack, listening for spliced readouts, the readback and corner names.
- Generator unit tests:
  - an entry's hash does not change when an entry it references changes
  - a run refuses an entry whose dependency is stale and out of scope
  - an identical entry under a second voice is copied, not requested
  - `--import` writes the file byte for byte and a row with the current hash, and refuses an unknown entry
- The dry run before the full run reports, per voice, would-generate, would-copy and refused counts. They are recorded in the PR.

