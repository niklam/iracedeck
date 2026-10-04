> **Issue:** [#1335](https://github.com/niklam/iracedeck/issues/1335) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: driver names batch for 3.5.0

## The problem

The standing Discord thread "[Race Engineer] Add your name" collects first names from users who want the engineer to address them. The maintainer processes it in batches, cut by an "Anything above this line will be in version X" post. The last marker was 3.2.0 on 4 Sep 2026 (#1118), and eleven posts arrived after it. This is the first batch since #999 added a second first-party voice, the Terse pack, which carries its own copy of every name clip.

## What ships

Twelve new names, Matthias, Brandon, Zoltán, Robin, Manfred, Liam, Ade, Chip, Elias, Andris and Yeray from the thread, plus Jimmy added by the maintainer, with one entry in each of the five per-name groups (`names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting`, `position-overtake-come-on`). They go into both `configs/default.voice.json` and `configs/shawn.voice.json`: 120 entries and 120 clips, following the exact text pattern of the existing entries.

## Decisions

### 1. Every requested form is its own entry

The #1118 rule still applies. mr_ch1p asked for "Ade and/or Chip", and both ship: the dropdown offers what the user asked for, and choosing between the two is the user's call, not ours.

### 2. No near-homophones

Before filing, every new name was checked against the 97 existing names and against the other new ones for pairs that sound practically identical, such as Dominic/Dominik from #1118. None was found. The closest pairs are Brandon/Brenton, Matthias/Matthew, Robin/Rob/Robbie and Andris/Andrew/André, and each pair is still distinct when spoken. A future batch should run the same check, because a near-duplicate entry adds a dropdown line and a clip without giving anyone a name they could not already pick.

### 3. Terse copies Default's takes rather than generating its own

Both voices use the same ElevenLabs voice, model and voice settings, and the five name groups have the same text in both, so a Terse name entry's generation hash is identical to Default's. The existing Terse name clips were nevertheless generated as separate requests when #999 shipped. This batch generates Default only and copies each approved clip, with its `generate.manifest.json` row, to `voice/shawn/…`, as `packages/audio-assets/CLAUDE.md` allows for an entry that is verbatim Default's. The reasons: one paid request per line instead of two, one audition instead of two, and the same take for a name in both packs, so a user who switches packs is not greeted by a different-sounding version of their own name. The Terse dry run then reports all 60 entries as cache hits, which is the proof that the copies are in place.

### 4. Slugs are ASCII; display text keeps diacritics

As with `jorgen` in #1118: `Zoltán` is entered as `zoltan` and keeps the á in its text.

### 5. A name the TTS mispronounces is respelled, never moved to another model

The audition found two names said wrongly: Matthias came out English where its owner says it the German way ("ma-TEE-as"), and Ade came out as "ay-day" where its owner says "aid, as in first aid". Their spoken `text` is respelled to `Mattias` and `Aid` in all five lines. The slug stays `matthias` / `ade`, and the Your Name dropdown takes its label from the slug, so the user still sees the name they asked for. The respelling does show in the website's pack reference, which lists spoken texts.

ElevenLabs offers two exact controls, and neither fits. SSML phoneme tags work only on the older `eleven_flash_v2`, and inline IPA needs `eleven_v4`. Either would put one name on a different model from the rest of the voice, inside a single line such as "Time to race, Aid." A pronunciation dictionary on the voice's own model (`eleven_flash_v2_5`) can only apply an alias, which is the same respelling kept in the ElevenLabs account instead of the repo. Moving the whole voice to v4 would be a separate decision, since it means re-cutting every clip.

### 6. No version bump while the pack versions are unpublished

Default `1.1.2` and Terse `1.0.1` have not been published (the latest releases are `voices-default-1.1.1` and `voices-iracedeck-terse-1.0.0`), so the batch rides those versions and regenerates both catalog entries. If either version is published between releases before this merges, that pack gets a `version` bump instead, since a published archive's bytes may never change under the same version.

## Out of scope

- Answering in the Discord thread or posting the next marker: the marker is the maintainer's (the #1118 spec, decision 4), and the feature-requests tooling refuses to write to the thread.
- Re-cutting the existing Terse name clips as copies of Default's. They stay as shipped; only the new names are copied.
- Third-party voice packs. A pack without a name clip simply skips that callout.

## Testing

- The Default dry run over the five groups reports exactly the new entries as "WOULD GENERATE" before any paid generation. After copying, the Terse dry run reports all of them as cache hits and generates nothing.
- The maintainer auditions all 60 Default takes, listening most carefully to Zoltán, Yeray, Matthias and Ade, whose spoken form an English TTS voice may not match. Matthias and Ade were re-cut after the first audition (decision 5).
- `pnpm test` covers the script-coverage test for both voices and the pack-reference freshness test. `pack:voice` for both packs must succeed and regenerate their catalog entries.
- Manually, the new names appear in the Your Name dropdown with each pack selected, and a greeting plays with one of them.
