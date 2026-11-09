<p align="center">
  <img src="assets/iracedeck-logo-full-white.png" alt="iRaceDeck" width="400">
</p>

<p align="center">
  iRaceDeck is an <a href="https://www.elgato.com/stream-deck">Elgato Stream Deck</a>, <a href="https://miraboxbuy.com/">Mirabox</a>, and <a href="https://www.ulanzi.com/">Ulanzi Deck</a> plugin for <a href="https://www.iracing.com/">iRacing</a>. Turn your Stream Deck, Mirabox, or Ulanzi Deck into a fully-featured button box with live telemetry, pit controls, camera management, and more.
</p>

<p align="center">
  <a href="https://coderabbit.ai"><img src="https://img.shields.io/coderabbit/prs/github/niklam/iracedeck?utm_source=oss&utm_medium=github&utm_campaign=niklam%2Firacedeck&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews" alt="CodeRabbit Pull Request Reviews"></a>
  <a href="https://discord.gg/c6nRYywpah"><img src="https://img.shields.io/discord/1477659500851888219?logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
</p>

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Project Structure](#project-structure)
- [Releasing](#releasing)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Usage and license](#usage-and-license)
- [For companies](#for-companies)
- [Inspiration](#inspiration)
- [Acknowledgements](#acknowledgements)

## Features

**33 actions** with **265+ modes** across 10 categories:

| Category                | Actions | Modes | Examples                                                              |
| ----------------------- | ------- | ----- | --------------------------------------------------------------------- |
| **Audio & Voice**       | 3       | 15    | AI spotter, audio (incl. Race Engineer & Radar volume), pit crew      |
| **Display & Session**   | 2       | 15    | Incidents, laps, position, iRating, gaps ahead/behind, fuel, flags    |
| **Driving Controls**    | 3       | 22    | Black box cycling, look direction, car control                        |
| **Cockpit & Interface** | 5       | 32    | Wipers, FFB, splits & reference, telemetry, UI toggles                |
| **View & Camera**       | 6       | 98    | FOV, replay, replay markers, camera controls, broadcast tools         |
| **Media**               | 1       | 7     | Video recording, screenshots                                          |
| **Pit Service**         | 3       | 15    | Fuel (button and dial), tires, compounds, tearoff, fast repair        |
| **Car Setup**           | 7       | 44    | Brakes (button and dial), chassis, aero, engine, fuel mix, hybrid/ERS, traction control |
| **Communication**       | 2       | 35    | Chat, macros, whisper, reply, race admin commands                     |
| **Stream Deck**         | 1       | 1     | Switch to bundled iRaceDeck profiles (Elgato only)                    |

**Key highlights:**

- Live telemetry at 4 Hz with automatic iRacing connection/reconnection
- **Pit Crew** action with **Radar** directional proximity ticks and a spoken **Race Engineer**, both through a multi-channel audio mixer (miniaudio); no voice ships inside the plugin — every one is a downloadable pack, and the plugin installs and updates its own at launch
- All keyboard shortcuts are user-configurable via the Property Inspector
- SDK-first design: uses iRacing broadcast commands where possible, keyboard simulation only as fallback
- Native C++ addon for low-latency Win32 API access (iRacing SDK, keyboard input, audio engine)

## Installation

### Users

1. Download the latest `.streamDeckPlugin` release
2. Double-click to install
3. Find **iRaceDeck** in the Stream Deck action list

### Developers

**Prerequisites:**

- Windows 10+ (iRacing is Windows-only)
- [Node.js](https://nodejs.org/) 24+
- [pnpm](https://pnpm.io/) 10+ — it switches itself to the version pinned in `package.json`
- Python 3.x and [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload (for the native addon)
- [Elgato Stream Deck](https://docs.elgato.com/sdk/) software

```bash
git clone https://github.com/niklam/iracedeck.git
cd iracedeck
pnpm install
pnpm build
```

#### Development workflow

```bash
# Build only the Stream Deck plugin packages
pnpm build:stream-deck

# Watch mode with hot-reload (restarts Stream Deck automatically)
pnpm watch:stream-deck

# Run tests: all of them, a path filter, or one package
pnpm test
pnpm test packages/iracing-sdk/
pnpm --filter @iracedeck/deck-core test

# Lint and format
pnpm lint:fix
pnpm format:fix

# Hear a Race Engineer voice edit in the sim: opt this machine in once
# (then open a new terminal), and every `pnpm build` stages the voice packs
# and points the plugins at them. Build with the deck host stopped; while it
# runs, restage after a voice edit and press Rescan voices (no restart)
setx IRACEDECK_DEV_VOICES 1
pnpm stage:voices
# Override it for one worktree: `off` plays the real download, `auto` follows
# the variable again, `on` turns it on without the variable
pnpm dev:voices off
```

## Project Structure

A pnpm monorepo built with [Turborepo](https://turbo.build/). Its packages are grouped below the way `.claude/CLAUDE.md` groups them; how they depend on each other and how data flows between them is on the [Architecture](https://iracedeck.com/docs/development/architecture/) page.

```text
packages/
  # Sim and telemetry
  iracing-native/              C++ N-API addon: shared memory, window messaging, scan-code input, window focus
  iracing-sdk/                 TypeScript SDK: telemetry, session info, broadcast commands
  event-bus/                   Typed pub/sub with the canonical sim-event catalog (sim- and audio-agnostic)
  sim-events-iracing/          The iRacing translator (SDK ticks to bus events) and the replay recorder
  track-data/                  Bundled Lovely Sim Racing corner markers

  # Audio and the Race Engineer
  audio-native/                C++ N-API addon: the miniaudio five-channel mixer
  audio-service/               The mixer singleton: buses, voice sequences, the output device
  audio-assets/                Voice clips, sound effects, the clip generator, voice configs, packer and catalog
  callout-script/              The voice-pack contract: callout-script grammar and voice-pack.json rules
  voice-packs/                 Voice packs: scanner, catalog, installer, launch step, voice labels
  callout-settings/            Race Engineer callout opt-in registry (zero dependencies)
  audio-scenarios/             The Race Engineer callout catalog: contracts, vocabulary, speak gates
  race-engineer-wiring/        Race Engineer wiring shared by the plugins and the harness
  scenario-harness/            Local QA web UI that plays Race Engineer audio without iRacing

  # Icons and rendering
  icons/                       SVG key icon templates (Mustache)
  icon-composer/               Standalone SVG icon assembly (zero dependencies)
  rasterizer/                  SVG to PNG through resvg, with bundled fonts

  # Deck layer
  logger/                      Shared logger interface and the per-call error boundary
  app-constants/               Constants every layer and the PI bundle share (zero dependencies)
  fetch-utils/                 Request deadline and byte-capped JSON read for Node and the PI bundle
  settings/                    Global settings: schema, settings store, migrations, PI warnings, first run
  replay-store/                Per-session replay store: markers, laps, greens, session starts, incidents
  replay-engine/               iRacing replay engine: command gate, cursor, jump playback, speed state, lap walks
  diagnostics/                 Self-diagnostics: watchdog, resource monitor, CPU profiles, snapshot sections
  app-updates/                 Version-upgrade changelog opener and the What's New update check
  settings-window/             Settings window plugin side: loopback server and guard, launcher, commands
  deck-core/                   The deck abstraction: base classes, types, services; sim-neutral
  deck-iracing/                iRacing's side of the deck layer: sim connection, SimIRacingAction, SDK singleton
  deck-adapter-elgato/         Elgato Stream Deck adapter (Elgato SDK to deck-core)
  deck-adapter-mirabox/        Mirabox VSD Craft adapter (WebSocket protocol to deck-core)
  deck-adapter-ulanzi/         Ulanzi Deck adapter (UlanziStudio WebSocket protocol to deck-core)
  iracing-actions/             Platform-agnostic iRacing action implementations
  plugin-runtime/              Shared plugin bootstrap: startup phases, shared action list
  plugin-build/                Shared Rollup config factory for the three plugins (build-only)
  pi-components/               Property Inspector components, EJS partials, Rollup plugins, bridges
  iracing-plugin-stream-deck/  Elgato Stream Deck plugin
  iracing-plugin-mirabox/      Mirabox device plugin
  iracing-plugin-ulanzi/       Ulanzi Deck device plugin

  # Website
  website/                     Documentation website (iracedeck.com)
```

| Package | Role |
| --- | --- |
| **Sim and telemetry** | |
| `@iracedeck/iracing-native` | C++ Node.js addon for Win32 APIs (memory-mapped files, window messaging, scan-code input, window focus); mocked off Windows |
| `@iracedeck/iracing-sdk` | TypeScript SDK: `SDKController`, session YAML and the broadcast `Commands` |
| `@iracedeck/event-bus` | Typed pub/sub with the canonical sim-event catalog; depends on no simulator SDK |
| `@iracedeck/sim-events-iracing` | The iRacing translator, from SDK ticks to bus events, the replay recorder, and the canonical live race order |
| `@iracedeck/track-data` | Bundled corner markers from Lovely Sim Racing, keyed by track name |
| **Audio and the Race Engineer** | |
| `@iracedeck/audio-native` | C++ Node.js addon around miniaudio: a five-channel mixer with device selection; mocked off Windows |
| `@iracedeck/audio-service` | The mixer singleton over `audio-native`: buses, voice sequences and the device lifecycle |
| `@iracedeck/audio-assets` | The voice clips, `sfx/`, the ElevenLabs generator, per-voice configs, the voice-pack packer and the catalog |
| `@iracedeck/callout-script` | The shared contract of a voice pack: the `callouts.json` grammar and parser and the `voice-pack.json` rules |
| `@iracedeck/voice-packs` | The voice-pack stack: scanner, catalog, download and installer, the launch step that keeps the `default` pack installed |
| `@iracedeck/callout-settings` | Every Race Engineer callout opt-in, declared once: key, label and default |
| `@iracedeck/audio-scenarios` | The Race Engineer catalog: callout contracts, script vocabulary, speak gates and the pack-author tooling |
| `@iracedeck/race-engineer-wiring` | `wireRaceEngineer`: every `registerPitCrew` dependency, its live sim reads through the declared `SimRuntime`, shared by the plugins and the harness |
| `@iracedeck/scenario-harness` | Local QA tool: the real Race Engineer stack against a mock SDK controller, driven from a web UI |
| **Icons and rendering** | |
| `@iracedeck/icons` | SVG key icon Mustache templates with colorization support |
| `@iracedeck/icon-composer` | Standalone SVG icon assembly (pure functions, zero dependencies), re-exported by deck-core |
| `@iracedeck/rasterizer` | SVG to PNG through `@resvg/resvg-js` with bundled Arimo fonts, injected into deck-core at startup |
| **Deck layer** | |
| `@iracedeck/logger` | Shared logging interface with scoped loggers, and `createErrorBoundary` for every dispatcher |
| `@iracedeck/app-constants` | The constants every layer and the PI bundle share — setting keys, value sets, settings-window ids, `LogLocation` — with zero imports |
| `@iracedeck/fetch-utils` | `abortAfter` and `readCappedJson`: request helpers shared by app-updates, voice-packs and the PI bundle |
| `@iracedeck/settings` | Global settings below the deck layer: schema, migrations, the plugin-owned settings store, PI warnings, first run |
| `@iracedeck/replay-store` | The per-session replay store: markers, laps, greens, session starts and incidents, one file per `SubSessionID` |
| `@iracedeck/replay-engine` | The iRacing replay engine the replay actions share: the replay command gate, cursor, jump playback, speed state and lap walks |
| `@iracedeck/diagnostics` | Self-diagnostics: the main-thread watchdog, the resource monitor, CPU profiles and the Telemetry Snapshot's state sections |
| `@iracedeck/app-updates` | The version-upgrade changelog opener and the settings window's What's New update check |
| `@iracedeck/settings-window` | The settings window's plugin side: the loopback server and its request guard, the launcher, the command handler |
| `@iracedeck/deck-core` | The deck abstraction: base classes, types, keyboard service, icon templates; sim-neutral through `SimConnection` |
| `@iracedeck/deck-iracing` | iRacing's side of the deck layer: `SimIRacingConnection`, the `SimIRacingAction` base, the SDK singleton (`getCommands()`) |
| `@iracedeck/deck-adapter-elgato` | Bridges the Elgato SDK to deck-core's `IDeckPlatformAdapter` interface |
| `@iracedeck/deck-adapter-mirabox` | Bridges the Mirabox VSD Craft WebSocket protocol to deck-core |
| `@iracedeck/deck-adapter-ulanzi` | Bridges the UlanziStudio WebSocket protocol to deck-core |
| `@iracedeck/iracing-actions` | Every action implementation, platform-agnostic |
| `@iracedeck/plugin-runtime` | The composition root all three plugins share: startup phases and the shared action list |
| `@iracedeck/plugin-build` | Build-only: `createPluginRollupConfig`, the one Rollup config the three plugins share |
| `@iracedeck/pi-components` | Shared PI web components, EJS partials, Rollup EJS plugin, and the Ulanzi + settings-window bridges |
| `@iracedeck/iracing-plugin-stream-deck` | Elgato Stream Deck plugin: shell over `plugin-runtime`, manifest, bundled profiles |
| `@iracedeck/iracing-plugin-mirabox` | Mirabox plugin: shell over `plugin-runtime` for Mirabox devices |
| `@iracedeck/iracing-plugin-ulanzi` | Ulanzi Deck plugin: shell over `plugin-runtime` for Ulanzi devices |
| **Website** | |
| `@iracedeck/website` | Documentation website at [iracedeck.com](https://iracedeck.com) |

### How it fits together

```text
Plugin start (each plugin's plugin.ts is a shell: build the adapter, call startPlugin)
  -> plugin-runtime (eleven startup phases: core, sim, input, audio, voice packs,
     Race Engineer, settings, replay, actions, services, connect)
    -> initSim starts the sim translator (sim-events-iracing) and returns its query side
      -> race-engineer-wiring builds the Race Engineer's dependencies from it

Button press (Stream Deck, Mirabox, or Ulanzi Deck)
  -> adapter (deck-adapter-elgato / deck-adapter-mirabox / deck-adapter-ulanzi)
    -> actions (platform-agnostic action handler)
      -> deck-core (keyboard service) or deck-iracing (SDK commands)
        -> iracing-sdk (broadcast command) or iracing-native (scan-code keystroke)
          -> iRacing

iRacing telemetry (shared memory)
  -> iracing-native (reads memory-mapped file)
    -> iracing-sdk (parses telemetry buffer, 10 ms poll deduped on SessionTick)
      -> deck-iracing (SimIRacingConnection: connection, flags, title templates for deck-core;
                       SimIRacingAction: telemetry and session info for actions that read them)
        -> actions (updates button display via adapter)
```

## Releasing

All packages share a single version number, driven by [release-it](https://github.com/release-it/release-it) plus one custom hook. Nothing is inferred from commit messages — you choose the version, and release-it asks before it commits, tags, pushes, or creates a GitHub Release.

### How to release

```bash
pnpm release           # prompts for the version
pnpm release -- 3.2.0  # release a specific version
pnpm release:dry       # safe preview — writes nothing
```

`pnpm release` wraps release-it (`scripts/release.mjs`): it strips the `--` separator pnpm inserts, exports `GITHUB_TOKEN` from `gh auth token` when that variable is not already set, and signals a dry run to the hook below.

A release then runs in this order:

1. The `before:bump` hook (`scripts/release-hooks.mjs`) first refuses a version that is not semver, then checks every voice pack's committed record (`packages/audio-assets/pack-records/<id>.json`, see *Voice packs* below) against the tree, before it writes anything: a pack whose clips, script or version changed without a re-pack, or re-packed under a released version, aborts the release with a clean tree, naming the pack and the command to run. On a version with no `dev` prerelease identifier (`3.2.0`, `3.2.0-rc.1`, `3.2.0-beta.2` — the ones that are tagged and whose tag run publishes the packs), the hook later seals each pack's current version as released in its record (`released: { version, sha256 }`), after the changelog fold of step 2 and before the version bumps of steps 3–4, and stages the records with the version files; a pack already sealed at its version is left alone. A `-dev` bump checks and seals nothing, since it is committed untagged and publishes nothing. `pnpm release:dry` prints the seals it would write and writes nothing.
2. On a **stable** version only, the same hook folds the changelog fragments in `changelog.d/` into a new `## <version>` section of `packages/website/src/content/docs/changelog.mdx`, dated today, and deletes and stages the fragments. Everything is validated before anything is written, so a malformed fragment aborts the release with a clean tree, and the fold runs before the version bumps below, so a fold that fails part-way leaves the version files untouched. Any version containing a dash (`3.2.0-dev.0`, `3.2.0-rc.1`) skips the fold and keeps the fragments as the in-development notes; a stable version with no fragments gets no section.
3. The same hook bumps every `packages/*/package.json`. The root `package.json` is bumped separately, by release-it's own npm plugin.
4. The same hook bumps all three plugin `manifest.json` files (Stream Deck, Mirabox, Ulanzi). It discovers them rather than using a hardcoded list, and writes the version each ecosystem requires: a 4-part `major.minor.patch.build` for the Stream Deck and Mirabox manifests — Elgato's manifest schema rejects semver suffixes — with the build slot taken from `git rev-list --count HEAD`, and a plain `major.minor.patch` for Ulanzi, whose marketplace refuses any other form. The changelog edit is staged with the version files.
5. release-it commits the result as `chore(release): vX.Y.Z`.
6. It creates the annotated tag `vX.Y.Z`.
7. It pushes the branch and the tag to origin.
8. It creates a GitHub Release named `vX.Y.Z`.

Steps 5–8 are each **prompted** outside CI, and declining one skips it. Development bumps are normally committed without a tag or a GitHub Release, which is why most `-dev.0` commits in the history are untagged. Pushing a `v*` tag is what triggers the packaging workflow below, so a bump you chose not to tag publishes nothing.

The changelog is written by hand, not generated from commits: each user-facing PR adds a fragment to `changelog.d/` — one file per bullet, so two PRs never edit the same lines (see `.claude/rules/changelog.md`) — and the release only folds them into `changelog.mdx` with its date. The plugin's `changelog.json` is a gitignored build artifact composed from the two, which the release-pack build regenerates from the tag. GitHub Release notes are generated by GitHub from merged PR labels (`github.autoGenerate`, categorised by `.github/release.yml`), not from the changelog.

> **Preview with `pnpm release:dry`, never `npx release-it --dry-run`.** release-it 21.1.1 does not run `before:bump` hooks in its own dry run: it prints `! node scripts/release-hooks.mjs <version>` and skips the command, so a direct `npx release-it --dry-run` previews none of steps 1–4 and would not show a stale pack record or a malformed fragment that stops the real release. The pnpm wrapper (`scripts/release.mjs`) therefore asks release-it which version it would release (`--release-version`), runs the hook itself with that version and `RELEASE_IT_DRY_RUN=1` — the flag that makes the hook print what it would bump, fold and seal instead of writing — and stops with the hook's error when it refuses; only then does it run release-it's own dry run. The flag is set for that run too, so a release-it that ran hooks in a dry run again (older versions did) would still write nothing. Nothing in the sequence touches the tree or the index.

### Plugin packaging (CI)

`.github/workflows/release-pack.yml` is a reusable workflow invoked by `release.yml` (which runs automatically when a version tag is pushed). It:

1. Builds the full monorepo once on Windows
2. Packs every published Race Engineer voice pack and checks it against its committed catalog entry (see below)
3. Packs all three plugins (Stream Deck, Mirabox, Ulanzi) from that single build using `streamdeck pack`
4. Attaches each packed plugin to the GitHub Release

### Voice packs (CI)

Race Engineer voices are distributed as downloadable packs (`packages/audio-assets/src/build/voice-packs.mjs` is the list). Their archives are never uploaded by hand: `scripts/publish-voice-packs.mjs` runs inside the tag workflow above, packs every published voice through the same pipeline the plugin build uses, verifies the archive's sha-256 and size against the committed `packages/audio-assets/catalog/<id>.json`, and attaches it to the `voices-<id>-<version>` GitHub release, created with `--latest=false` so it never takes the "latest" slot the plugin download links resolve through. A pack whose version has not changed is found already published and skipped; an archive the runner cannot reproduce, or a pack whose bytes changed without a version bump, fails the job before anything is published. Every website deploy — the release path and any manual one — first asks each catalog entry's URL and refuses to build if an archive answers anything but 200, so `voice-catalog.json` can never go live naming an archive that does not exist.

A pack carries more than clips: each voice's callout script (`voice/<id>/callouts.json`, extracted from `configs/<id>.voice.json` by `pnpm generate:callout-scripts`) travels in the archive beside them. What each archive was built from is recorded beside its catalog entry in `packages/audio-assets/pack-records/<id>.json`: digests of every voice's clips and script, the `voice-pack.json` the packer writes, the encode pipeline (including the `ffmpeg-static` version) and the archive format, plus `released` once that version has shipped. `pnpm test` recomputes them from the tree in about a second, so a pack whose inputs changed without a re-pack fails on the pull request, naming the pack and what changed. When a pack's clips or script change: if its current version is already released, bump its `version` in `packages/audio-assets/src/build/voice-packs.mjs`; then run `pnpm --filter @iracedeck/audio-assets pack:voice <id>` and commit both `catalog/<id>.json` and `pack-records/<id>.json`. The packer refuses to write either file when the archive changed under a released version. The next release publishes it.

Writing a pack — ours or anyone's — is documented on the site under [Voice Packs](https://iracedeck.com/docs/voice-packs/): the concept, a first-pack tutorial, the `callouts.json` format, and a reference of every callout, every name a script may use and the full recording script, generated from the catalog by `pnpm generate:pack-reference`; from a clone of the repo, `pnpm lint:pack <packDir>` (after `pnpm build`) reports everything in a pack folder that the plugin would otherwise skip quietly.

`.github/workflows/publish-voice-packs.yml` is the manual path, dispatched from the Actions tab. With `publish` off (the default) it is a dry run — pack and verify, upload nothing, attach the archives as a `voice-packs` artifact — worth running once before tagging a release that changes a pack, from any branch. With `publish` on it publishes the archives and then deploys the website so the catalog offers the new version, for a pack that has to ship between plugin releases; it must be dispatched from `master`, and from any other ref it fails before it packs anything. Before dispatching it, seal the pack on `master`: `pnpm seal:voice-packs [<id> …]` (every pack when none is named; an unknown id is refused naming the known ones) checks every record, marks each named pack's current version as released in `packages/audio-assets/pack-records/<id>.json`, prints each record it sealed and says to commit `packages/audio-assets/pack-records/` to `master` before dispatching — a pack already sealed at its version is left alone, and a problem in any record seals nothing. A publish refuses a pack whose version is not sealed — `<id> <version> is about to be published but is not sealed in pack-records/<id>.json — seal it on master first.`, naming every such pack and the seal command — since a tag run's release commit seals every pack but a between-releases publish has no release commit; a dry run needs no seal. Either way, the script checks every record before it packs anything, so a stale record fails in seconds rather than after a full encode. That deploy builds the site from the latest stable plugin tag with only `packages/audio-assets/catalog/` taken from the `master` commit the run verified, so documentation for unreleased work on `master` never reaches the site early. It refuses to deploy if `master`'s catalog has changed since that commit, as a re-run of an older publish would have; dispatch it again from `master` instead.

A tag release deploys the catalog the tag carries, so **a `release/*` branch that is tagged must carry every live voice pack that `master` still carries, at or above its live version** — in practice, the pack commits published from `master` between releases. Otherwise a patch tagged from an older branch would quietly put an older pack back over one published between releases. Every website deploy therefore compares the catalog it is about to deploy with the live one, `https://iracedeck.com/voice-catalog.json`, as its last step, directly before the Firebase deploy, so a between-releases publish cannot go live in the meantime and then be overwritten. Every live pack must be in the deploy at or above its live version (semver precedence): a live pack the deploy names at an older version always fails the deploy before anything goes live (a published version is bumped, never rolled back), and so does one the deploy lacks while `master` still carries its catalog entry, each named with both versions. A live pack the deploy lacks passes only as a deliberate withdrawal: when `master`'s catalog lacks it and `master`'s history shows its entry existed and was deleted there. The deploy then removes it, with a warning naming the pack and the last `master` commit to touch its entry. A live pack `master` has never carried (one shipped from a release branch that was not back-merged yet) is refused. `master` is fetched only to decide that, its whole history without file contents, and a deploy that cannot read that history refuses. A pack that is not live never blocks, so a pack bump committed on `master` but not yet published does not hold up a patch release. When nothing is live (a 404) the deploy goes ahead with a warning, since nothing can regress; a network error, a timeout, any other status or a body that is not a voice catalog refuses it rather than skipping the check. To fix a refusal, bring each named pack onto the release branch from `master` — its clips and its catalog entry together, because the tag's pack job repacks from the branch's clips and checks the archive against the entry — or, to withdraw a pack, delete its `packages/audio-assets/catalog/<id>.json` on `master` first; then re-tag or re-run the deploy. A pack `master` has never carried must reach `master` first, by back-merging the release branch that shipped it; only then can it be brought along or withdrawn. On a between-releases publish the deployed catalog is `master`'s, so a refusal there means a release put a newer version live than `master` holds, or shipped a pack `master` never had: back-merge the release branch's commits for that pack onto `master` first, then dispatch *Publish voice packs* again. The check lives in the tag's own copy of `firebase-hosting-release.yml`, so a release branch cut before it was added (#1613) needs this change too before it is tagged; until then the rule is yours to keep by hand.

### Requirements

- A clean working tree — release-it refuses to start otherwise (`requireCleanWorkingDir`)
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated — `pnpm release` reads a token from `gh auth token` unless `GITHUB_TOKEN` is already set. Only the GitHub Release step needs it, so declining that prompt works without either

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repo and create a branch (`feature/123-your-feature`)
2. Follow [conventional commits](https://www.conventionalcommits.org/) with package scope (e.g. `feat(iracing-plugin-stream-deck): add new action`)
3. Add tests for new code (Vitest)
4. Make sure `pnpm build` and `pnpm test` pass
5. Open a pull request

### Adding a new action

Actions live in `packages/iracing-actions/src/actions/<action-name>/`, one folder per action. Each action needs:

1. `<action-name>.ts` — action class extending `ConnectionStateAwareAction` from `@iracedeck/deck-core` (or `SimIRacingAction` from `@iracedeck/deck-iracing` when it reads iRacing telemetry directly)
2. `<action-name>.test.ts` — unit tests
3. `<action-name>.ejs` — Property Inspector template (compiled to `ui/<action-name>.html`)
4. `icon.svg` + `key.svg` — static category and key icons (copied into each plugin's `imgs/actions/<name>/` at build time)
5. Mustache SVGs in `packages/icons/<action-name>/` for any dynamic variants
6. Registration in `packages/plugin-runtime/src/actions.ts` (`SHARED_ACTIONS`), once for all three plugins
7. Manifest entry in each plugin's `manifest.json`
8. Entries in `packages/iracing-actions/src/actions/data/{key-bindings,docs-urls,icon-defaults}.json` where applicable

See the existing actions for reference, or check `packages/iracing-plugin-stream-deck/CLAUDE.md` for step-by-step instructions.

## Troubleshooting

| Problem                                             | Solution                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Double-clicking `.streamDeckPlugin` doesn't install | Rename the file to add `.zip` at the end, extract the contents to `%APPDATA%\Elgato\StreamDeck\Plugins`, and restart Stream Deck |
| Plugin doesn't connect                              | Make sure iRacing is running and you're in a session (on track)                                                                  |
| Buttons show nothing                                | iRacing telemetry is only available while driving; the plugin reconnects automatically                                           |
| Native addon build fails                            | Install Python 3.x and VS Build Tools with C++ workload. Try `npm config set msvs_version 2022`                                  |
| Key presses don't work                              | Check your key bindings in the Property Inspector match your iRacing configuration                                               |

## Usage and license

iRaceDeck is source-available and licensed under the [iRaceDeck Non-Commercial License v1.1](LICENSE).

Free for personal and non-commercial use, including use in sim racing events and competitions.

Plugin downloads ship the license alongside [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md), which aggregates the license notices of every bundled third-party component.

For full details, see [USAGE.md](USAGE.md).

The name “iRaceDeck” and associated branding are not included in the license and may not be used for derived versions without permission.

If you're unsure whether your use case is allowed, feel free to reach out.

### Why this license?

iRaceDeck is source-available rather than open source.

The goal is simple:
- Keep iRaceDeck free for sim racers, hobbyists, and the community
- Allow people to build on top of it (profiles, icons, tools, integrations)
- Prevent others from selling or commercializing the plugin itself without permission
- Require that anyone who distributes a modified version of iRaceDeck makes their modifications publicly available, so the community keeps benefiting from improvements

If you're just using, modifying, or contributing to iRaceDeck, nothing changes for you.

If you're building something commercial around iRaceDeck, that's usually fine — just don't redistribute or sell the plugin itself. If you're unsure, feel free to reach out.

## For companies

If you're working on something commercial based on iRaceDeck, feel free to reach out.

I'm open to licensing, collaboration, or helping you build on top of it.

Contact: [niklas@iracedeck.com](niklas@iracedeck.com)

## Inspiration

This project was inspired by [iRaceIT](https://iraceit.itxware.de/), a Stream Deck plugin for iRacing.

## Acknowledgements

- [Elgato Stream Deck SDK](https://github.com/elgatosf/streamdeck)
- [iRacing SDK](https://forums.iracing.com/discussion/15068/official-iracing-sdk)
- [Node-API (N-API)](https://nodejs.org/api/n-api.html)
- [pyirsdk](https://github.com/kutu/pyirsdk) (reference implementation)
