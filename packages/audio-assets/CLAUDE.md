# @iracedeck/audio-assets

Voice lines for the Race Engineer, the radio sound effects (`sfx/`), and the ElevenLabs TTS generator that produces the voice clips.

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

## What ships is not the committed mp3 — the build-time radio filter

The committed `voice/**/*.mp3` files are the **dry TTS source clips**, not what plugins play. At plugin build time every voice clip is processed through ffmpeg with `RADIO_ENGINEER_FILTER` (`src/presets.mjs`): a 250–3500 Hz bandpass + 8 dB pre-gain into a `tanh` soft-clip, then a brick-wall limiter — plus a re-encode to 16 kHz mono 32 kbps (`ENCODE_ARGS` in `src/build/index.mjs`). So a clip always sounds different in-plugin than the source mp3 — that difference is this pipeline, not a generation problem.

Processed outputs are cached under `.cache/<pipeline-hash>/`, where the hash embeds the filter chain + encode args — editing the preset (or the encode args) automatically invalidates every processed clip; per-file invalidation is mtime-based. This package's own `pnpm build` (`src/build/prebuild.mjs`) exists solely to warm that cache before the parallel plugin builds run, so each plugin's Rollup copy step (`processAndCopyAudioAssets`) only ever reads cache files instead of racing over the same ffmpeg writes (contention rationale documented in `src/build/index.mjs`).

Consumer surface (`package.json` exports): `./build` (`processAndCopyAudioAssets` / `processAndCopyAudioAssetsPlugin` / `prebuildAudioAssetCache` / `wipeProcessedCache`, used by the plugin Rollup configs and the scenario harness), `./presets` (`RADIO_ENGINEER_FILTER`), and `./manifest.json` (the runtime manifest).

## Sound effects (`sfx/`)

`sfx/` holds the non-voice assets: the walkie-talkie tick-open/close pair, the ambient pit loop, and the radar proximity tones (`sfx/radar/`). They're consumed by `@iracedeck/audio-scenarios` — the radio frame (`radio-frame.ts`), the PI background-volume test (`background-test.ts`), and the radar engine (`radar-engine.ts`). Deliberately **not** radio-filtered at build time: everything outside `voice/` is copied into the plugin output unchanged (see `src/presets.mjs`), so the ticks and tones stay clean.

## Voices may diverge — the relaxed parity check (issue #664)

Pools are derived per-voice from the clips that actually exist (see the `@iracedeck/audio-scenarios` `POOL_REGISTRY`), so voices do **not** need identical clip sets: a voice may record fewer or more `-NN` variants of a line, or omit a callout entirely — that voice simply doesn't play it. The test `src/generate/voice-parity.test.ts` keeps only a **soft typo guard**: a non-default voice must not define a `<group>/<base>` key (entry name with the `-NN` suffix stripped) that `default.voice.json` doesn't know — such a base is referenced by nothing and would never play, so it's almost certainly a misspelling. Missing keys are allowed; wording can vary per voice (different engineer personalities).

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

Requires `ELEVENLABS_API_KEY` in `.env.local` at the repo root (falls back to `.env`; both auto-loaded).

See `README.md` for the full CLI flag reference.

## Adding an entry to an existing group

The most common case — a new callout in an existing family (e.g. another flag):

1. Add the entry to the group in `configs/default.voice.json`. Other voice configs *may* add the same `<group>/<entry-name>` key (wording may differ per voice) but don't have to — a voice without the clip just skips that callout (issue #664). Omit `seed` (or set `"seed": 1`) — never an arbitrary value.
2. Preview: `pnpm --filter @iracedeck/audio-assets generate:dry-run --group <group>` — it must report exactly the new entries as "WOULD GENERATE" and everything else as cache hits.
3. Generate scoped: `pnpm --filter @iracedeck/audio-assets generate --group <group>`.
4. Rebuild the runtime manifest: `pnpm --filter @iracedeck/audio-assets generate:manifest`.
5. Commit the new `voice/<voice>/<group>/<name>.mp3` clip(s) together with both manifests — clips are tracked in git.

## Adding a new group

1. Add the new top-level key under `groups` in `configs/default.voice.json` (the canonical voice; other voices may adopt the group later — parity is not required, issue #664).
2. Author the entries (text, no `seed` — or `"seed": 1` — by default, optional `previous_request_ids`).
3. Generate (scoped by `--group`), after a dry-run preview.
4. Rebuild the runtime manifest.
5. Register the pool in `@iracedeck/audio-scenarios` — a `POOL_REGISTRY` entry mapping the pool name to `(group, base)` in `packages/audio-scenarios/src/catalog/pit-crew/pools.ts`.

## Adding a new voice

1. Create `configs/<voice-id>.voice.json` with its own `id` (ElevenLabs voice id), `label`, `model_id`, `voice_settings`, and `groups`. The groups do **not** need to match `default.voice.json` — a partial voice ships fine and simply skips the callouts it lacks (issue #664). The only constraint is the typo guard: don't invent `<group>/<base>` keys that `default.voice.json` doesn't have.
2. Run `pnpm --filter @iracedeck/audio-assets generate --voice <voice-id>` to render its clips into `voice/<voice-id>/...`.
3. Rebuild the runtime manifest. The runtime auto-discovers voices from the manifest's `voice/<id>/...` paths, so the new voice appears in the PI dropdown automatically.

## Conventions

- One group per callout family (flags, pit-actions, pit-status, track-conditions, …). Mixing families in one group makes the cost-scoping flag `--group` less useful.
- Variants use a `-NN` suffix (`blue-01.mp3`, `blue-02.mp3`). A pool is *all clips sharing a base name* — every `voice/<voice>/<group>/<base>-NN.mp3` **plus the bare `<base>.mp3`** (issue #836: a bare value clip like `position-number/7.mp3` is a size-1 pool) — derived per-voice from the runtime manifest (issue #664), so **adding or removing a variant is just adding or removing an entry + clip**: no pool edit, no code change. Playback picks uniform-random with a no-immediate-repeat guard (not in numeric order).
- Value clips (numbers, temperatures, speeds, names, lap-time digits) define their own speakable range by existing (issue #836): there are no code-side bounds or clamps, so widening a range (e.g. more temp values, higher position numbers) is purely a generate-clips job.
- The `<group>/<base>` pair is the stable identifier — the audio-scenarios `POOL_REGISTRY` references pools by it, so renaming a base is a breaking change for the pool that references it. (The acknowledgment clips are the exception until #837: they don't follow `-NN` yet and are referenced by exact path.)

## Known re-render triggers

Adding a new audio-affecting field to `EntrySchema` that feeds the hash invalidates every entry's cache (a one-time invalidation). Don't add hashed fields casually — accept the regenerate cost or stage the rollout carefully.
