# A Development Voice Root for the Plugin

> **Issue:** [#1143](https://github.com/niklam/iracedeck/issues/1143) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Since #1034 stage 3 no plugin bundles a voice. The plugin plays the copy in `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\default`, and the launch step keeps that folder matching the published catalog: it installs `default` when missing, replaces a folder whose provenance is absent or foreign, and force-reinstalls one whose provenance is intact but whose clips are gone. Every one of those rules exists so that a user's engineer works. Every one of them also fights the person editing the voice.

Before stage 3, `pnpm build` was the step that refreshed the voice in-game, because the build copied the filtered clips into the plugin's `assets/audio`. After it, the two ways to hear a change are: sideload the packer's staged output under a different pack id (rename the pack id, the voice id and the `voice/<id>` folder after every change), or copy the staged files over the managed folder while leaving `.install.json` intact so the launch step keeps believing the digest. Neither is a loop anyone will run twenty times an afternoon, and #1131 — the next change to the voice — needs one.

## Goals

- A repo developer hears a voice change in-game with one command and one button press, no copying.
- What plays is the bytes the packer stages — the radio-filtered clips a user would download — never the raw source tree.
- A release build can never carry the mechanism.
- Testing the real download path stays an explicit choice, not something relinking switches off by accident.

## Non-goals

- Serving a local catalog. #1106 (a loopback base may serve loopback archive URLs) stays open and separate; the download pipeline is exercised by the manual test and the stage-3 recipe, not by every voice edit.
- Anything for authors without a clone. They keep the documented sideload path under their own pack id.
- Hot reload without a press. Rescan is one press and already reloads the engine.

## Decisions

**A build-time marker, not a runtime setting.** A gitignored `dev.local.json` at the repo root:

```json
{ "voicePacksRoot": "packages/audio-assets/dist/voice-packs" }
```

Each plugin's Rollup config reads it the way it reads `feature-flags.local.json`, resolves the path to an absolute one, and writes it into `bin/config.json` as `devVoicePacksRoot`. `PluginConfig` gains the optional field; `getPluginConfig()` exposes it. A release build cannot carry it because the file is not in git; a development build carries it per worktree, and it dies with the worktree. Rejected: a passthrough key in `global-settings.json` in the style of `_devBaseUrl` — that file is shared by every build of an ecosystem on the machine, so a release plugin linked back in would read the dev root too. Rejected: an environment variable — the deck host launches the plugin, and `IRACEDECK_VOICE_PACKS_PATH` already shows how awkward that is to set for it.

**The plugin scans the dev root first.** `VoicePackServiceDeps` gains `devRoot?: string`. The scanner takes an ordered list of roots rather than one; packs found in an earlier root claim their voice ids ahead of packs in a later one, which is the `priorityPacks` idea of #1034 stage 3 generalised from "one pack first" to "one root first". A pack from the dev root carries the provenance `development` — a fourth value beside `catalog`, `bundled-seed` and `sideload`, but unlike those it is never written to disk: it is assigned from where the pack was found, so no folder can claim it. The Installed Voices row shows a *Development build* badge and the pack's directory, and no Remove button (the plugin never deletes from a directory it did not create). The packer's staged output `dist/voice-packs/<id>/` is already the folder shape the scanner accepts (`voice-pack.json` + `voice/<id>/callouts.json` + clips), so nothing is copied or renamed.

**The launch ensure skips every pack the dev root provides.** The launch step's `isPackUsable` sibling becomes `isProvidedByDevRoot(id)`; a target the dev root provides is dropped before the install, and the whole step logs one parameter-free info line at every start — `Voice packs: development root active` — with the path at debug. It does not skip other packs: a second catalog pack still updates, which is what a developer testing an update path wants to see.

**Rescan re-reads the dev root.** No new command: `refreshVoicePacks` already rescans and pokes the launch step; the scan now covers both roots. The loop is edit → `pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog` → **Rescan voices** → race.

**`pack:voice --no-catalog`.** Stages and zips without writing `catalog/<id>.json`. The committed entry is the release contract; the dev loop must never rewrite it, and today every `pack:voice` run does. The flag is per run, not a mode: the release workflow keeps calling the script without it.

**One switch.** `scripts/dev-voices.mjs` behind `pnpm dev:voices on|off`. `on` writes `dev.local.json` (refusing to overwrite a file with other keys), rebuilds the three plugins, and relinks whichever hosts are linked; `off` removes the file and does the same. `switch-test-env` and the `relink:*` scripts leave the file alone. A `dev.local.json.example` is committed beside `feature-flags.local.json.example`.

## Failure modes

| Situation | Behaviour |
|---|---|
| Dev root path does not exist | Logged at warn once; scanned as empty; the launch ensure runs as normal. |
| Dev root provides `default`, AppData holds one too | The dev copy claims the voice; the AppData pack is listed under problems with the existing "already provided by" reason. Nothing is deleted. |
| Release build | No key in `config.json`; every path above is inert. `scripts/manifest-platform.test.mjs`'s sibling guards that a packed plugin carries no `devVoicePacksRoot`. |
| Developer forgets dev mode is on | The start-of-run info line and the badge in the window say so. |

## Testing

- Rollup: `dev.local.json` present → absolute `devVoicePacksRoot` in `config.json`; absent → key absent; relative path resolved from the repo root.
- Scanner: two roots, the earlier claims first; `development` provenance is assigned, never read from a record.
- Launch step: a dev-provided `default` is not a target even with verdict `install`; a non-dev pack still updates.
- `pack:voice --no-catalog`: the entry file's bytes are untouched.
- The pack-guard test: no distributable carries the key.

## Affected artifacts

- `@iracedeck/deck-core` — `PluginConfig`, scanner roots, service `devRoot`, launch step skip, tests
- All three plugins — Rollup `emit-plugin-config`, `plugin.ts` wiring, byte-identical
- `@iracedeck/pi-components` — the badge
- `@iracedeck/audio-assets` — `pack:voice --no-catalog`, `CLAUDE.md`
- Root — `scripts/dev-voices.mjs`, `package.json`, `.gitignore`, `dev.local.json.example`
- Rules — `platform-feature-flags.md`, `race-engineer-callouts.md`, `settings-window.md`
- Website — the voice-pack tutorial and the development page describe the loop; no changelog entry (not a user-facing plugin change)
