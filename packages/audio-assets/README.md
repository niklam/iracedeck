# @iracedeck/audio-assets

Shared audio assets (MP3) for iRaceDeck plugins, plus the ElevenLabs TTS
generator that produces them.

## Layout

```text
packages/audio-assets/
├── sfx/                     # Non-voice sounds: radio ticks, the ambient pit loop, radar tones
├── voice/                   # Generated TTS clips, keyed by <voice>/<group>/<name>.mp3
├── catalog/                 # One committed <pack-id>.json per published voice pack
├── pack-records/            # What each pack's archive was built from, and whether it is released
├── dist/voice-packs/        # Staged packs + archives from pack:voice (gitignored)
├── configs/                 # TTS source: one <voice-id>.voice.json per voice (groups, entries, voice settings, callout script)
├── generate.manifest.json   # TTS cache: per-entry hash + ElevenLabs request id
├── manifest.json            # Authored manifest: every voice in this package
├── manifest.bundled.json    # The bundled slice a plugin compiles in and ships
├── scripts/                 # generate-audio-manifest.mjs, pack-voice.mjs, …
└── src/
    ├── build/               # Build helpers used during plugin packaging; voice-packs.mjs registry
    ├── generate/            # TTS generator (this README documents the CLI)
    └── presets.mjs
```

`generate.manifest.json` is a build cache for the generator. `manifest.json` is
the authored manifest, listing every voice in this package, and
`manifest.bundled.json` is the bundled slice a plugin compiles in and ships;
both are regenerated from the file tree by
`pnpm --filter @iracedeck/audio-assets generate:manifest`.

## TTS generator

Reads every `configs/*.voice.json`, iterates voices × groups × entries, and writes
any missing or stale `voice/<voice>/<group>/<name>.mp3` files by calling the
ElevenLabs TTS API. An entry is considered up-to-date when its output file
exists *and* its hash in `generate.manifest.json` matches the current
audio-affecting tuple (voice + model + voice_settings + text + seed +
prosody/context fields).

### Environment

- `ELEVENLABS_API_KEY` — required for live runs. `.env.local` or `.env` at the
  repo root is auto-loaded if present.

### Commands

```bash
# Generate everything that's missing or stale
pnpm --filter @iracedeck/audio-assets generate

# Report which entries would be generated, without calling the API
pnpm --filter @iracedeck/audio-assets generate:dry-run

# Rebuild the runtime manifest.json from the file tree
pnpm --filter @iracedeck/audio-assets generate:manifest

# Pack a voice for the download catalog (all packs when no id is given):
# evens out each clip's loudness and radio-filters it (the committed clips are
# never rewritten), zips them deterministically into dist/voice-packs/,
# and writes catalog/<id>.json and pack-records/<id>.json; commit both.
# See CLAUDE.md "Voice packs".
pnpm --filter @iracedeck/audio-assets pack:voice default
```

### Flags

| Flag | Description |
|---|---|
| `--dry-run` | List entries that would be generated, copied, skipped or refused. No API calls, no file writes, no manifest changes. |
| `--voice <key>[,<key>...]` | Only iterate the named voices (e.g. `luca`). Repeatable. |
| `--group <name>[,<name>...]` | Only iterate the named groups (e.g. `numbers`). Repeatable. |
| `--entry <name>[,<name>...]` | Only iterate entries with these names, in whichever groups are iterated (e.g. `0,09`). Repeatable. The way to cut a slice of one large group — added for #1127 so 21 of the 1,110 car numbers could be auditioned before the rest were paid for. |
| `--import <dir>` | Import takes cut outside the generator (#1643). `<dir>` holds `trial-manifest.json` (`{ "model", "voiceId"?, "records": [{ "key": "voice/<voice>/<group>/<name>", "status": "ok" \| "error", "requestId", "voiceId"? }] }`) and the files `voice/<voice>/<group>/<name>.mp3`. Each `ok` take is copied byte for byte into `voice/` and given a manifest row with the entry's current hash and the trial's request id, so no later run re-cuts it; other records are skipped. An unknown voice, group or entry, a missing file or request id, a model other than the entry's `model_id`, a record `text` other than the config's, a `voiceId` (the trial's or the record's) other than the voice config's `id`, a driver-name alias or a pause mark the grandfathered list does not cover refuses the whole import and writes nothing; a trial with no `voiceId` imports with a warning per voice that its speaker was not checked. The manifest is saved after each take, as a run saves after each clip. Composes with `--dry-run`; cannot be combined with `--voice`, `--group` or `--entry`; needs no API key. |

`--voice`, `--group` and `--entry` accept either the space-separated form
(`--voice luca`) or the equals form (`--voice=luca`). They compose as an
intersection. Manifest entries outside the filter are not touched, so a
subsequent unscoped run still sees them as cache hits — or, after a config change
that reaches them, still reports them as out of date. Unknown names exit non-zero
with the list of valid choices; an entry name is checked against the groups the
scope iterates, so a slice that would match nothing is refused rather than
reported as a full cache hit.

Within each voice a run cuts dependencies first: a stable topological order over the `previous_request_ids` / `next_request_ids` references, config order as the tie-break, with `default` run before every other voice. An entry is hashed on its own request only, so changing an entry re-cuts that entry and none that reference it (#1643). An entry about to be cut whose referenced entry is out of date and is not cut earlier in the same run is refused, naming that entry and the `--voice/--group/--entry` scope that cuts it; one whose dependency fails or is refused in the run fails with it. An entry whose request is identical to a take another voice already holds (the same hash, and every `<group>/<entry-name>` reference resolving to the same request id in both voices) is copied (clip and request id) instead of requested, reported as `WOULD COPY` in a dry run; a dry run plans what each clip will hold, so its counts are the live run's.

The manifest is saved after every clip a run writes or copies. A clip on disk with its row set counts as cut even when that save fails: the save is retried (3 attempts, 250 ms apart), and the run saves once more before it ends. If that fails too, the summary names the clips on disk without a row and the run exits 1; run again once the file is free, or the next run pays for those clips again.

Any other argument refuses the run before anything is loaded, naming it and listing the valid flags, so a typo such as `--dryrun` never starts a paid run.

### Examples

```bash
# Add a new line under one group without disturbing the other groups' cache
pnpm --filter @iracedeck/audio-assets generate --group numbers

# Re-cut just one voice/group combination after a per-voice settings tweak
pnpm --filter @iracedeck/audio-assets generate --voice luca --group flags

# Cost estimate before committing to an ElevenLabs run
pnpm --filter @iracedeck/audio-assets generate --dry-run --group numbers

# Equals form (interchangeable with the space-separated form)
pnpm --filter @iracedeck/audio-assets generate --voice=luca --group=numbers

# A slice of one group: three of the car numbers, nothing else
pnpm --filter @iracedeck/audio-assets generate --voice default --group car-number --entry 0,9,09
```
