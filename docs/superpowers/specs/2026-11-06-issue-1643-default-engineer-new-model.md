# Regenerate the Default engineer on the newest ElevenLabs model

> **Issue:** [#1643](https://github.com/niklam/iracedeck/issues/1643) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Both first-party voices use the same ElevenLabs speaker on `eleven_flash_v2_5`: Default (`configs/default.voice.json`, 4,810 clips in the authored manifest) and Short callouts (`configs/shawn.voice.json`, 4,717 clips, pack `iracedeck-terse`), which copies Default's clip wherever its entry is verbatim Default's. Flash was chosen for latency, which a pre-generated voice does not need. The issue asks for the same lines on the newest model.

## Decision

### The model

Use **the newest generally available ElevenLabs text-to-speech model at the time the work starts that supports everything the generator sends**: `seed`, request stitching (`previous_request_ids`, `next_request_ids`), `next_text`, `language_code` and pronunciation dictionaries. Request stitching is the hard requirement. Every clip carries `previous_request_ids` (`packages/audio-assets/CLAUDE.md`, "Clips that join other clips"), and without it spliced readouts sound like different takes. A newer model without stitching is not eligible; the newest one with it is used instead, and the PR says which model was skipped and why.

The model is set once at voice level (`model_id`) in both configs. Per-entry `model_id` overrides, if any exist, are removed so the voice is one model throughout.

### Settings and seeds

- `voice_settings` are retuned for the new model during the trial (below), starting from ElevenLabs' recommended values for it, not today's Flash values. Any field the new model does not accept is dropped from the config rather than sent and ignored.
- **Every seed is reset**: entries drop their `seed`, so all default to `1`. A seed only picks a take, and the takes picked on Flash mean nothing on another model. Niklas re-picks seeds by ear on the review pages, as the house rule already says.
- The conditioning rules stand as written. If the trial shows one no longer holds on the new model (for example, a sentence-final clip trailing longer), `packages/audio-assets/CLAUDE.md` is amended in the same change.

### Both packs move together

Short callouts is the same speaker. A voice heard on two models depending on the pack would be the one result worse than either, so both configs change in one PR. The copy rule is unchanged: a Short callouts entry whose text, settings and seed are verbatim Default's is copied from the new Default clip, not generated twice.

### Generation order

The model is part of every entry's hash, so the whole voice is re-cut. A dependent must be generated after the entries it references, or it is conditioned on a Flash request id. Today the generator runs entries in config order and leaves dependency order to the author (`generate.ts` header). **The generator orders each run topologically over the reference graph** (dependencies first, config order as the tie-break), which `detectReferenceCycles` already guarantees is acyclic. It is a small change and makes every future full re-cut safe, not just this one.

### Trial, then the full run

ElevenLabs is paid per character and the full run is roughly 9,500 clips, so nothing is generated in full before Niklas has heard the model:

1. **Trial**: re-cut a subset of both voices covering every way clips join:
   - a compact lap-time readout (intro, minute-and-seconds, decimals)
   - a position readout
   - a gap readout
   - the pit readback body
   - a session-start brief with temperatures
   - three driver names
   - two non-English corner names with `language_code`
   - the spotter calls
   - five Short callouts lines

   Present them old against new on a review page (`review-page` skill).
2. **Settings**: iterate `voice_settings` on the trial set until Niklas passes it.
3. **Full run**: generate both voices with `--voice` scoping, Default first, so copied Short callouts entries find their source. Afterwards `generate:manifest`, then a dry run reporting zero entries to generate.
4. **Re-picks**: Niklas reviews a second page of a wider sample. Any clip he flags gets a seed bump and a scoped re-cut.

### Shipping

- `version` bumps in `src/build/voice-packs.mjs`: `default` 1.4.0 → 1.5.0, and `iracedeck-terse` 1.3.0 → 1.4.0.
- Then flagless `pack:voice default` and `pack:voice iracedeck-terse`, and the regenerated `catalog/*.json` committed.
- `minPluginVersion` is unchanged, because no plugin code changes.
- Installed packs update themselves at launch (#1105), one download of each pack per user.
- A changelog fragment under **Improvements** says the engineer was re-recorded on a newer voice model.

## Alternatives rejected

- **Upgrade Default only.** Short callouts would then be the same person on two models.
- **Keep the seeds.** They select Flash takes and carry no meaning on another model, and keeping them would look like a decision.
- **Order the full run by hand, by group.** It works once, but the next full re-cut would need the same care, and a mistake there is silent: a clip conditioned on a stale request id still generates.
- **A newer model without request stitching, conditioning on `previous_text` instead.** `previous_text` is the weaker signal, and Niklas's rule is that every clip carries `previous_request_ids`.
- **A new voice id instead of re-cutting `default`.** It would be a new pack users must choose, not an upgrade of the one they have.

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
