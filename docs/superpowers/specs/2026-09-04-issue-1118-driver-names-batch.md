> **Issue:** [#1118](https://github.com/niklam/iracedeck/issues/1118) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: driver names batch for 3.2.0

## The problem

The standing Discord thread "[Race Engineer] Add your name" collects first names from users who want the engineer to address them. The maintainer processes it in batches, marking each cut with an "Anything above this line will be in version X" post; the last marker was 2.5.0 on 16 Aug 2026, and fourteen names arrived after it. Names are clips, not text, so each one is a config entry per greeting group and a generated take, and a batch is the unit that makes the paid generation worth a session.

## What ships

Thirteen new names in `configs/default.voice.json` — Juan, Senior, Marty, Viperbiker, Hope, Jack, Jørgen, Jurgen, Jurgmaister, Tony, Marco, Dominik, Shannon — one entry in each of the five per-name groups (`names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting`, `position-overtake-come-on`), 65 entries and 65 clips, following the exact text pattern of the existing entries. Marcus was also requested and already exists.

## Decisions

### 1. Every requested spelling is its own entry

jurgmaister asked for three forms (Jørgen, Jurgen, Jurgmaister) and marcop5685 for Dominik beside the existing Dominic. Each ships as its own entry: the dropdown shows the spelling the user asked for, and a user picking "Dominik" should find it rather than be told Dominic sounds the same. The cost is a few near-duplicate clips; the alternative — deciding for people which spelling is "theirs" — is the wrong call for a feature whose whole point is being addressed by name.

### 2. Slugs are ASCII

`Jørgen` becomes `jorgen` as the entry slug and file name; the display text keeps the ø. Slugs are file names across three plugin builds and a website, and every existing slug is ASCII.

### 3. No seed on new entries; audition, then bump

Per the audio-assets convention: omit `seed`, generate once, listen, and re-cut only the takes that sound off. Two are flagged for a careful listen before the rest: `Jørgen` (the ø through TTS) and `Viperbiker` (a compound, prone to odd emphasis, as Rickybobby was in #982).

### 4. The marker post is the maintainer's, not the tool's

The 3.2.0 marker line in the thread is posted by the maintainer, as every previous one was. The feature-requests tooling (#1114) refuses to write to that thread by design, and this batch does not change that.

## Verification

Per group, `generate:dry-run` must report exactly the 13 new entries as "WOULD GENERATE" and everything else as cache hits before any generation runs. After generation and `generate:manifest`, the names appear in the Your Name dropdown in all three plugins with no code change, and a greeting plays for one of them via the scenario harness.

## Affected artifacts

- `@iracedeck/audio-assets`: 65 config entries, 65 committed clips under `voice/default/<group>/`, both manifests.
- Website: changelog entry in the in-development section: "New Race Engineer driver names: Juan, Senior, Marty, Viperbiker, Hope, Jack, Jørgen, Jurgen, Jurgmaister, Tony, Marco, Dominik, and Shannon."
- No plugin, PI, settings, scenario, or docs changes.
