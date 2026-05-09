# @iracedeck/audio-assets

Voice lines for the Race Engineer + the ElevenLabs TTS generator that produces them.

See `.claude/rules/race-engineer-callouts.md` for the end-to-end "how to add
a callout" walkthrough that includes this package; the notes below cover the
audio-assets-only mechanics.

## Where voice lines live

`generate.config.json` is the **source of truth** for every voice line. It's
keyed by group → entry, and the generator iterates voices × groups × entries
to write `voice/<voice>/<group>/<name>.mp3`.

Each entry:
- `name` — kebab-case file stem; the suffix `-01` reserves room for variants (`-02`, `-03`, …).
- `text` — the spoken line; `<break time="0.3s" />` inserts a natural pause.
- `seed` (optional) — fixed integer for reproducible prosody across regenerations.
- `previous_request_ids` (optional) — IDs of clips that semantically precede this one; biases ElevenLabs toward continuous prosody.

`generate.manifest.json` is the **generator's hash cache** — per-entry hash + ElevenLabs request id, used to skip unchanged entries. Don't hand-edit; let the generator manage it.

`manifest.json` is the **runtime manifest** the plugins read at startup. Rebuild after adding/removing clips with:

```bash
pnpm --filter @iracedeck/audio-assets generate:manifest
```

## Generating clips

```bash
# Cost note: ElevenLabs is a paid API. Always scope by group to avoid re-cutting
# unrelated entries (the cache covers most of this, but new entries cost money).
pnpm --filter @iracedeck/audio-assets generate --group <group-name>

# Dry run reports what *would* be generated without spending API credit:
pnpm --filter @iracedeck/audio-assets generate:dry-run --group <group-name>
```

Requires `ELEVENLABS_API_KEY` in `.env.local` (auto-loaded from repo root).

See `README.md` for the full CLI flag reference.

## Adding a new group

1. Add the new top-level key under `groups` in `generate.config.json`. Keep
   the order vaguely topical — flags, pit-*, damage, etc. — to make the file
   easy to skim.
2. Author the entries (text, seeds, optional `previous_request_ids`).
3. Generate (scoped by `--group`).
4. Rebuild the runtime manifest.
5. Reference the new clips from a pool in `@iracedeck/audio-scenarios` (`packages/audio-scenarios/src/catalog/pit-crew/pools.ts`).

## Conventions

- One group per callout family (flags, pit-actions, pit-status, track-conditions, …). Mixing families in one group makes the cost-scoping flag `--group` less useful.
- File names are stable identifiers — pools reference them by exact path. Renaming an entry's `name` is a breaking change for any pool that references it.
- Variants use a `-NN` suffix (`flag-blue-01.mp3`, `flag-blue-02.mp3`). The pool array order drives playback rotation.
