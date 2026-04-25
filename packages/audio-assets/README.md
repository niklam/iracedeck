# @iracedeck/audio-assets

Shared audio assets (MP3) for iRaceDeck plugins, plus the ElevenLabs TTS
generator that produces them.

## Layout

```text
packages/audio-assets/
├── ambient/                 # Looping ambient audio
├── voice/                   # Generated TTS clips, keyed by <voice>/<group>/<name>.mp3
├── generate.config.json     # TTS source: voices, groups, entries, voice settings
├── generate.manifest.json   # TTS cache: per-entry hash + ElevenLabs request id
├── manifest.json            # Deployment manifest consumed by audio-service at runtime
└── src/
    ├── build/               # Build helpers used during plugin packaging
    ├── generate/            # TTS generator (this README documents the CLI)
    └── presets.mjs
```

`generate.manifest.json` is a build cache for the generator. `manifest.json` is
the runtime manifest the plugins read; it is regenerated from the file tree by
`pnpm --filter @iracedeck/audio-assets generate:manifest`.

## TTS generator

Reads `generate.config.json`, iterates voices × groups × entries, and writes
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
```

### Flags

| Flag | Description |
|---|---|
| `--dry-run` | List entries that would be generated/skipped. No API calls, no file writes, no manifest changes. |
| `--voice <key>[,<key>...]` | Only iterate the named voices (e.g. `luca`). Repeatable. |
| `--group <name>[,<name>...]` | Only iterate the named groups (e.g. `numbers`). Repeatable. |

`--voice` and `--group` accept either the space-separated form (`--voice luca`)
or the equals form (`--voice=luca`). They compose as an intersection. Manifest
entries outside the filter are not touched, so a subsequent unscoped run still
sees them as cache hits. Unknown names exit non-zero with the list of valid
choices.

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
```
