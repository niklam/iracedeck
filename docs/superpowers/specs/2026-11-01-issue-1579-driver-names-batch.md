> **Issue:** [#1579](https://github.com/niklam/iracedeck/issues/1579) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: driver names batch for 3.8.0

## The problem

The standing Discord thread "[Race Engineer] Add your name" collects first names from users who want the engineer to address them, processed in batches cut by an "Anything above this line will be in version X" post. The last marker was 3.5.0 on 4 Oct 2026 (#1335). Seven names were posted after it, up to 18 Oct 2026.

## What ships

Seven new names, Dev, Geoff, Jeff, Drew, Olle, Brant and Bill, with one entry in each of the five per-name groups (`names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting`, `position-overtake-come-on`), in both `configs/default.voice.json` and `configs/shawn.voice.json`: 70 entries and 70 clips, in the exact text pattern of the existing entries ("Ok, Bill,", "Time to race, Bill.", "Bill,", "Come on, Bill.").

## Decisions

### 1. Every requested form is its own entry, Geoff and Jeff included

The #1118 rule still applies. gpsaunders asked for "Geoff or Jeff" and said it is pronounced Jeff, so both ship: `geoff` with its spoken `text` respelled to `Jeff`, and `jeff`. The dropdown takes its label from the slug, so a Geoff sees his own spelling. The two entries speak the same word, which the #1335 homophone check would normally reject; it is accepted here because the requester named both spellings, and the point of the check (no dropdown line that gives nobody a new name) does not hold for a spelling its owner uses. The `geoff` entries carry exactly the `jeff` entries' text in all five lines (Niklas, 2026-11-01: "just use the very same text for both, so they should come cached"), so each pair is one generation and the two can never sound different. The dry run is the check: it must list each `geoff` line as served from the same take as its `jeff` line, and if the generator keys its cache by entry rather than by text, the `geoff` clips are copied from the approved `jeff` takes instead of generated.

### 2. The homophone check

Every new name was checked against the 109 existing names and against the others. **Dev** sits next to the existing **Dave**: the English "Dev" is distinct, the Hindi "Dayv" would not be, and the entry is cut as English "Dev". **Brant** sits next to **Brandon** and **Brenton**, and is distinct. No other pair is close.

### 3. Names the TTS may mispronounce are respelled, never moved to another model

As decided in #1335 (decision 5). **Olle** is Swedish, roughly "OOL-leh", and an English voice may say "Ollie". **Brant** is the other name to audition: Niklas asked in the thread how one of roller9876's two names is pronounced, and it went unanswered. A name heard wrongly at audition gets its spoken `text` respelled in all five lines, its slug unchanged.

### 4. Short Calls copies Default's takes

As in #1335 (decision 3): the five name groups have the same text and settings in both voices, so Short Calls copies each approved Default clip with its `generate.manifest.json` row, and its dry run then generates nothing. This is unaffected by #1571's per-voice generation, which applies to the lap-time clips only.

### 5. Both packs get a version bump, once per release

Default `1.3.0` and Terse `1.2.0` are already published (`voices-default-1.3.0`, `voices-iracedeck-terse-1.2.0`), and a published archive's bytes never change under the same version, so each pack bumps in `src/build/voice-packs.mjs` (a minor bump: new clips, no removal). #1571 also adds clips to both packs in 3.8.0. Whichever of the two merges first makes the bump; the second keeps that unpublished version and only regenerates the catalog entries.

## Out of scope

- Answering in the Discord thread or posting the next marker: the marker is the maintainer's (#1118, decision 4), and the tooling refuses to write to the thread.
- peter_35473's middle-name idea ("Peter John", "not critical to have"). A middle-name callout would be a separate feature.
- Third-party voice packs: a pack without a name clip skips that callout.

## Testing

- The Default dry run over the five groups reports exactly the 35 new entries as "WOULD GENERATE" before any paid generation; after copying, the Short Calls dry run reports all 35 as cache hits.
- Niklas auditions the new Default takes on a review page, Dev, Olle and Brant first, and confirms Geoff and Jeff sound the same.
- `pnpm test` covers script coverage for both voices and the pack-reference freshness test. `pack:voice` for both packs succeeds and regenerates their catalog entries.
- Manually, the new names appear in the Your Name dropdown with each pack selected, and a greeting plays with one of them.
