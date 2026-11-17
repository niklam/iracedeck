# iRaceDeck's own voice is called Shawn

> **Issue:** [#1716](https://github.com/niklam/iracedeck/issues/1716) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Decisions

1. **The labels are "Shawn" and "Shawn (Short callouts)"** (Niklas, 2026-11-17). The dropdown's first-party prefix stays, so users see **iRaceDeck: Shawn** and **iRaceDeck: Shawn (Short callouts)**.
2. **Label only; every id stays.** The pack ids (`default`, `iracedeck-terse`), the voice ids (`default`, `shawn`), the composed ids (`default::default`, `iracedeck-terse::shawn`), the folder names and the stored `raceEngineerVoice` setting are unchanged. A saved choice keeps resolving, and no settings migration is needed. Renaming Default's voice id to `shawn` would also collide with the Short callouts voice's `voice/shawn/` folder in the flat authored tree.
3. **Wherever the plugin names the voice to a user, it uses the label, never an id or the word "Default".** That covers the fallback wording ("the engineer speaks with Default until it is back") on screen and on the website. A sentence that means the pack every install gets keeps saying so in words ("iRaceDeck's own voice, Shawn, which every install has"), not "Default".
4. **It ships on the unreleased 2.0.0 packs.** The label is inside each archive's `voice-pack.json`, so both packs are re-packed and their catalog entries and pack records regenerated. No version bump, because 2.0.0 is not released yet. This joins the re-pack order of the other 3.9.0 voice branches.
5. **The release says why.** One changelog fragment names the voice and the tribute: to the person who helps test iRaceDeck and spar ideas, who wrote the Short callouts voice, and who helps manage the Discord. Niklas approves the wording, and the 3.9.0 release notes carry the same line next to "Race Engineer grew a personality".

## Rejected

- **Renaming the ids too.** It breaks every saved `raceEngineerVoice`, needs a migration and collides with `voice/shawn/`, all for a name users never see.
- **Keeping "Default" and adding Shawn as a subtitle.** Two names for one voice in the dropdown.

## Out of scope

- The planned pack-id rename `default` → `iracedeck-default`, which is its own issue.
- Mike, the alternative voice (#1697).
- Any clip, script or wording change in the voices themselves.

## Testing

- **Unit:** the catalog, pack-record and pack-reference tests pass on the re-packed 2.0.0 packs. A test pins that a stored `default::default` and a stored `iracedeck-terse::shawn` still resolve to the same voices, and that the dropdown shows the new labels.
- **Manual (Stream Deck, dev voices on):** the Race Engineer Voice dropdown and the Voice Packs card show **iRaceDeck: Shawn** and **iRaceDeck: Shawn (Short callouts)**. A setup that had Default selected before the build still speaks with the same voice after it, with no re-pick.
