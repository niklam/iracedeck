# "Default (Short callouts)": Renaming the Terse Pack's Label

> **Issue:** [#1289](https://github.com/niklam/iracedeck/issues/1289) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

#999 shipped iRaceDeck's second voice pack as "Default (Terse)". Many drivers are not native English speakers, and "terse" is a word they may not know, so the one word meant to explain how this voice differs from Default explains nothing.

## Decisions

**The label becomes "Default (Short callouts)".** "Callout" is the product's own word for what the Race Engineer says: the docs, the changelog and the settings all use it. "Short calls" was considered and rejected; it is shorter in the dropdown, but "calls" is not the product's term, and the label is the one place a single word has to be right.

**Only the label changes; every id stays.** The pack id `iracedeck-terse`, its voice id, the composite id a user's selection is stored under, the `voice/` and `configs/` folder names and the `voices-iracedeck-terse-*` archive names are all unchanged. Settings store the composite id, never the label, so no stored selection needs migrating and no pack folder moves on disk. Renaming the ids would buy nothing a user can see, at the cost of a settings migration and a re-install.

**Both labels change together.** The pack label in `VOICE_PACKS` and the voice label in `configs/shawn.voice.json` are the same text today, and they stay the same.

**The pack takes a patch bump, 1.0.0 → 1.0.1.** The label is part of the published archive's manifest, and `publish-voice-packs.mjs` checks each archive against its catalog entry, so a changed label with an unchanged version would fail the release. The bump is also how existing installs get the new name: an installed catalog pack updates itself at the next plugin start once a newer version is published. Until then its row keeps the old label, the Voice Packs card offers the update, and the voice still plays.

**User-facing prose drops "Terse" as a name.** Website pages that call the pack "Terse" use the new name. The `#default-terse` anchor becomes `#default-short-callouts`, and the one link to it moves in the same change. Past changelog entries are history and keep the name the release shipped with.

## Out of scope

- The pack id, the voice id, folder names, archive names, and internal names in code, rules and `CLAUDE.md` files. These track the ids, not the label.
- The wording of any callout in either voice.
- The Default pack's own label.

## Testing

- `voice-packs.test.ts` and `voice-labels.test.ts` assert the new label; the catalog entry is regenerated and its freshness check passes.
- A dry run of the *Publish voice packs* workflow verifies the 1.0.1 archive against the catalog before the tag.
- Manual:
  - With `pnpm dev:voices on`, the settings window lists **iRaceDeck: Default (Short callouts)** in the voice dropdown and on the Voice Packs card.
  - A machine that already has 1.0.0 installed and selected updates to 1.0.1 at the next start, shows the new label, and keeps the voice selected.
