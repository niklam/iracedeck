# A first-party voice pack with a new female voice

> **Issue:** [#1644](https://github.com/niklam/iracedeck/issues/1644) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

#1642 adds a voice per role and launches with a Spotter that sounds different from the Race Engineer. Both first-party voices today are the same male speaker. Niklas decided on 2026-11-06 that the new voice is female, is a full pack covering every callout rather than the Spotter's alone, and is generated on the newest ElevenLabs model.

## Decision

### A full voice, not a spotter-only one

The voice records every callout the reference voice (`default`) scripts, plus every driver name and every clip the plugin plays outside scripts (`PLUGIN_PLAYED_CLIPS`): about 4,800 clips, the size of Default. Its `voice-pack.json` entry declares **no `roles`**, so #1642's pickers offer it for both the Spotter and the Race Engineer. "Introduced as the Spotter" is how it is announced and how the release notes suggest using it. It is not a restriction in the pack.

A full voice also keeps the first-party completeness rule (#999) intact: it is held to every contract, like Default and Short callouts, so no role-aware exemption is needed in `bundled-scripts.test.ts`.

### The speaker

- The candidates are female voices from the ElevenLabs voice library whose sharing terms allow use in a product we distribute and keep distributing. A library voice whose owner can withdraw it, or that carries a notice period, is checked before it is shortlisted, and the PR records the terms of the chosen one.
- Three to five candidates each read the same eight lines on a review page: a spotter call, a flag, a lap-time readout, a position readout, a readback line, a driver name, a corner name and a long brief. Niklas picks one.
- Pack id `iracedeck-<name>` and voice id `<name>`, both after the chosen speaker, lowercase kebab-case. The label is the speaker's name, so the dropdown reads `iRaceDeck: <Name>`. The authored tree is flat by voice id, so the id must differ from `default` and `shawn`.

### The model and the conditioning

The model rule is #1643's: the newest generally available ElevenLabs text-to-speech model that supports request stitching. The two issues use the same model, so the two speakers sound like one product. All the "Clips that join other clips" rules in `packages/audio-assets/CLAUDE.md` apply, and seeds are omitted (1).

### The text

Every entry starts from Default's text, which Niklas has already approved line by line. The text changes only where the speaker's delivery calls for it, and every changed line is shown to Niklas before anything is generated. Her script is Default's `callouts.json` structure, with her own frame. The radio ticks are the built-in ones, so the frame differs only if her delivery needs different pacing.

### Generation and review

1. **Speaker pick**, above.
2. **Trial**: a subset covering every join type (the #1643 trial list), on a review page. `voice_settings` are tuned until Niklas passes it.
3. **Full run**: in dependency order. If #1643's topological generator change has not landed, it is made here, since a full new voice needs it just as much. Then `generate:manifest`, and a dry run reporting zero entries to generate.
4. **Wider review**: a second page with a sample from every group. Flagged clips get a seed bump and a scoped re-cut.

### Shipping

- A `VOICE_PACKS` entry: version `1.0.0`, `minPluginVersion` `3.7.0` (the `cut` frame tail every first-party script uses), `bundled: false`.
- A flagless `pack:voice` and the committed catalog entry.
- `FIRST_PARTY_SCRIPTS` and `CLIP_SOURCE_FLOOR` rows in `bundled-scripts.test.ts`.
- It is published with, or after, the release that ships #1642. It works in any plugin from 3.7.0 as an ordinary voice, but its release note introduces it as the Spotter, which needs the role picker.
- A changelog **Features** fragment, and a mention on the Race Engineer and Voice Packs pages.

## Alternatives rejected

- **A spotter-only voice** (a few hundred clips). Niklas chose a full voice, so she can also be someone's Race Engineer.
- **Declaring `roles: ["spotter"]` on a full voice.** That would hide a complete engineer from the Race Engineer picker for no reason.
- **Writing her lines from scratch.** Default's text is approved and tested against the scripts. Rewriting about 4,800 lines would be a review burden with no listener benefit, unless her delivery asks for it line by line.
- **A different model from #1643.** Two first-party speakers on different models would sound like two products.

## Out of scope

- The role mechanism itself (#1642).
- Re-cutting Default or Short callouts (#1643).
- A terse variant of the new voice.
- Changing which callouts exist or when they fire.

## Testing

- `bundled-scripts.test.ts` with the new voice in `FIRST_PARTY_SCRIPTS`: every contract scripted, every pool backed by a clip, and the catalog compiling with no warning against the real manifest.
- `script-coverage.test.ts`, `callout-scripts.test.ts`, `clip-text.test.ts` and `manifest.test.ts` over the new config.
- `pack:voice` for the new pack, then the publish dry run verifying the archive against its catalog entry.
- By hand (Niklas): the speaker page, the trial page and the wider review page. Then a session in iRacing on the development voice root, with her as the Spotter beside Default as the Race Engineer (needs #1642), and once with her as the Race Engineer.
