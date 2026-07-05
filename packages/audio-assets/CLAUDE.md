# @iracedeck/audio-assets

Voice lines for the Race Engineer + the ElevenLabs TTS generator that produces them.

See `.claude/rules/race-engineer-callouts.md` for the end-to-end "how to add a callout" walkthrough that includes this package; the notes below cover the audio-assets-only mechanics.

## Where voice lines live

Each voice has its own `configs/<voice-id>.voice.json` file. The filename stem (e.g. `default` from `default.voice.json`) is the runtime voice id and the on-disk directory name (`voice/<voice-id>/...`). The generator auto-discovers every `*.voice.json` in `configs/` — adding a new voice is a drop-in file plus a manifest rebuild, no enumeration list anywhere.

Voice files are **self-contained**. Each carries its own `model_id`, `voice_settings`, optional `output_format` / `apply_text_normalization` / `enable_logging` / `optimize_streaming_latency` / `pronunciation_dictionary_locators`, and its own `groups` map of entries. There is no shared root config — different ElevenLabs models often need different settings (different `speed`, different stability/similarity), so sharing defaults across voices would be a footgun.

Per-entry overrides fall back to the voice's value when omitted, so an individual line can pin a different model, language, normalization, etc. Supported per-entry override fields: `model_id`, `voice_settings` (shallow-merge), `output_format`, `apply_text_normalization`, `apply_language_text_normalization`, `optimize_streaming_latency`, `pronunciation_dictionary_locators`, `use_pvc_as_ivc`. Every audio-affecting override field feeds the per-entry hash, so flipping one on a single entry invalidates only that entry's cache.

Each entry:

- `name` — kebab-case file stem; the suffix `-01` reserves room for variants (`-02`, `-03`, …).
- `text` — the spoken line; `<break time="0.3s" />` inserts a natural pause.
- `seed` (optional) — fixed integer for reproducible prosody across regenerations. **On new entries, omit it** (the generator schema defaults an omitted seed to `1`) or set it explicitly to `"seed": 1` — never author a new entry with an arbitrary or random-looking seed. The seed only selects which take ElevenLabs produces, so a random default has no benefit and makes the value look meaningful when it isn't. Bump the seed deliberately (2, 3, …) only when the generated clip doesn't sound right and you want a different take. The seed feeds the entry hash, so changing it re-cuts just that clip.
- `previous_request_ids` / `next_request_ids` (optional) — IDs of clips that semantically precede/follow this one; biases ElevenLabs toward continuous prosody. Either a `<group>/<entry-name>` reference (resolved per-voice at generate time) or a raw ElevenLabs request id.

## Key parity across voices

The test `src/generate/voice-parity.test.ts` enforces that every voice config defines the **same set of `<group>/<entry-name>` keys** as `default.voice.json`. The wording can vary per voice (different engineer personalities), but the *set of clips offered* must match — otherwise pools and scenarios resolve inconsistently for one voice and not another. CI fails with a diff (missing / extra) on any mismatch.

## Manifests

`generate.manifest.json` is the **generator's hash cache** — per-entry hash + ElevenLabs request id, used to skip unchanged entries. Don't hand-edit; let the generator manage it. Keys are `voice/<voice-id>/<group>/<name>.mp3`, so per-voice cache isolation is automatic — changing one voice's settings invalidates only that voice's entries.

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

# Scope to a single voice when several exist:
pnpm --filter @iracedeck/audio-assets generate --voice default --group acknowledgment
```

Requires `ELEVENLABS_API_KEY` in `.env.local` (auto-loaded from repo root).

See `README.md` for the full CLI flag reference.

## Adding an entry to an existing group

The most common case — a new callout in an existing family (e.g. another flag):

1. Add the entry to the group in `configs/default.voice.json`, and the same `<group>/<entry-name>` key to every other voice config (the parity test enforces it; wording may differ per voice). Omit `seed` (or set `"seed": 1`) — never an arbitrary value.
2. Preview: `pnpm --filter @iracedeck/audio-assets generate:dry-run --group <group>` — it must report exactly the new entries as "WOULD GENERATE" and everything else as cache hits.
3. Generate scoped: `pnpm --filter @iracedeck/audio-assets generate --group <group>`.
4. Rebuild the runtime manifest: `pnpm --filter @iracedeck/audio-assets generate:manifest`.
5. Commit the new `voice/<voice>/<group>/<name>.mp3` clip(s) together with both manifests — clips are tracked in git.

## Adding a new group

1. Add the new top-level key under `groups` in `configs/default.voice.json` (the canonical voice; the parity test enforces that every other voice gets the same key set).
2. Author the entries (text, no `seed` — or `"seed": 1` — by default, optional `previous_request_ids`).
3. Generate (scoped by `--group`), after a dry-run preview.
4. Rebuild the runtime manifest.
5. Reference the new clips from a pool in `@iracedeck/audio-scenarios` (`packages/audio-scenarios/src/catalog/pit-crew/pools.ts`).

## Adding a new voice

1. Create `configs/<voice-id>.voice.json` with its own `id` (ElevenLabs voice id), `label`, `model_id`, `voice_settings`, and `groups`. The groups must contain the same `<group>/<entry-name>` set as `default.voice.json` — the parity test enforces this.
2. Run `pnpm --filter @iracedeck/audio-assets generate --voice <voice-id>` to render its clips into `voice/<voice-id>/...`.
3. Rebuild the runtime manifest. The runtime auto-discovers voices from the manifest's `voice/<id>/...` paths, so the new voice appears in the PI dropdown automatically.

## Conventions

- One group per callout family (flags, pit-actions, pit-status, track-conditions, …). Mixing families in one group makes the cost-scoping flag `--group` less useful.
- File names are stable identifiers — pools reference them by exact path. Renaming an entry's `name` is a breaking change for any pool that references it.
- Variants use a `-NN` suffix (`flag-blue-01.mp3`, `flag-blue-02.mp3`). Playback picks from the pool uniform-random with a no-immediate-repeat guard (not in array order).

## Known re-render triggers

Adding a new audio-affecting field to `EntrySchema` that feeds the hash invalidates every entry's cache (a one-time invalidation). Don't add hashed fields casually — accept the regenerate cost or stage the rollout carefully.
