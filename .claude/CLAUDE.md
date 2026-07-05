# iRaceDeck — Project memory

Project-wide instructions and overview for iRaceDeck. See the `.claude/rules/` directory for focused, topic-specific rules (code style, testing, icons, Stream Deck actions, build & commit conventions, etc.).

Packages

- `@iracedeck/logger`
- `@iracedeck/iracing-native` — has its own `CLAUDE.md` documenting native keyboard functions
- `@iracedeck/audio-native` — native miniaudio-backed 4-channel mixer; has its own `CLAUDE.md`
- `@iracedeck/audio-service` — TypeScript multi-channel audio mixer singleton over `@iracedeck/audio-native`. Exports `AudioChannel`, `AudioBus`, `initializeAudio`, `getAudio`, `isAudioInitialized`, `IAudioService`. Owns bus routing, per-channel volumes, voice-sequence engine, and device selection.
- `@iracedeck/audio-assets` — Voice clips for the Race Engineer + the ElevenLabs TTS generator. `configs/<voice-id>.voice.json` is the per-voice source of truth for every line (canonical: `default.voice.json`); clips live under `voice/<voice>/<group>/<name>.mp3` and are committed to git. Has its own `CLAUDE.md` covering the generation workflow (dry-run preview, `--group`/`--voice` scoping, manifest rebuild, seed omitted-or-`1` on new entries — never arbitrary).
- `@iracedeck/audio-scenarios` — Race Engineer voice catalog. Subscribes to bus events via the scenario engine, picks pools, applies family preemption + master-gate + per-callout opt-in wrappers. Pit-crew family lives under `src/catalog/pit-crew/`. Has its own `CLAUDE.md`. End-to-end how-to-add-a-callout walkthrough in `.claude/rules/race-engineer-callouts.md`.
- `@iracedeck/event-bus` — Typed pub/sub with a canonical sim-event catalog. Sim- and audio-agnostic. Exports `initializeEventBus`, `getEventBus`, `isEventBusInitialized`, `IEventBus`, `EventHandler`, `SimEvent`, `SimEventMap`, `SimEventName`, `SimEventOf`, `EmptySimEventPayload`, `RadarState`, `FlagScope`, `PitServiceKind`, `TrackWetness`. The envelope's telemetry field is generic so this package has no dependency on any simulator SDK; sim translators (e.g. `@iracedeck/sim-events-iracing`) bind it to their own snapshot type.
- `@iracedeck/sim-events-iracing` — iRacing translator. Subscribes to `sdkController` ticks, diffs against the previous snapshot, and publishes semantic events on `@iracedeck/event-bus` (pit lane / flag / toggle / limiter / incident / overtake / radar / fuel / lifecycle / lap). The only package that imports `@iracedeck/iracing-sdk` for telemetry consumption — future sim adapters (`sim-events-ac`, …) sit as parallel siblings emitting the same catalog. Exports `initializeSimEventsIracing`, `getLatestTelemetry`, `getSessionType`, `getFuelStats`, `isSimEventsIracingInitialized`, `FUEL_THRESHOLDS`, `FUEL_LAP_HISTORY_CAP`, `OVERTAKE_HOLD_MS`, `OVERTAKE_MAX_JUMP`, `YELLOW_CLEARED_HOLD_MS`, `resolveRadarState`.
- `@iracedeck/iracing-sdk`
- `@iracedeck/icon-composer` — Standalone SVG icon assembly with zero dependencies. Contains all pure assembly functions (assembleIcon, resolveIconColors, resolveTitleSettings, resolveBorderSettings, resolveGraphicSettings, etc.). Re-exported by deck-core for backward compatibility.
- `@iracedeck/deck-core` — Platform-agnostic base classes, types, and shared utilities (base actions, keyboard service, global settings, icon templates, etc.). Re-exports icon-composer and adds global settings readers.
- `@iracedeck/deck-adapter-elgato` — Elgato Stream Deck adapter bridging the Elgato SDK to deck-core's `IDeckPlatformAdapter` interface; also provides `createSDLogger`
- `@iracedeck/deck-adapter-mirabox` — Mirabox adapter bridging the VSD Craft WebSocket protocol to deck-core's `IDeckPlatformAdapter` interface
- `@iracedeck/deck-adapter-ulanzi` — Ulanzi Deck adapter bridging the UlanziStudio WebSocket protocol to deck-core's `IDeckPlatformAdapter` interface. Its `UlanziClient` normalizes Ulanzi `cmd` frames (and a per-context settings cache, since press/dial frames omit settings) into Elgato-style events, so the adapter mirrors the Mirabox one. Has its own `CLAUDE.md`.
- `@iracedeck/iracing-actions` — All action implementations; import from `@iracedeck/deck-core` (not `@elgato/streamdeck`). Each action lives in its own folder under `src/actions/<name>/` containing `<name>.ts`, `<name>.test.ts`, `<name>.ejs` (PI template), and `icon.svg`/`key.svg` (static icons). Shared template data lives in `src/actions/data/`. Plugin-global PI templates (e.g., `settings.ejs`) live in `src/actions/settings/`.
- `@iracedeck/pi-components` — Shared Property Inspector framework: web components (compiled to `pi-components.js`), EJS partials, the Rollup EJS compile plugin, the vendored `sdpi-components.js`, and the Ulanzi PI bridge (`ulanzi-pi-bridge.js`, built from `src/ulanzi-bridge/`). Per-action templates and template data live in `@iracedeck/iracing-actions`. Consumed by all plugins via `import { piTemplatePlugin, partialsDir, browserDir } from "@iracedeck/pi-components/build"`.
- `@iracedeck/iracing-plugin-stream-deck` — has its own `CLAUDE.md` with step-by-step instructions for adding new actions. Registers actions from `@iracedeck/iracing-actions` via `ElgatoPlatformAdapter`. The `src/shared/index.ts` re-exports from `@iracedeck/deck-core` and `@iracedeck/deck-adapter-elgato` for backward compatibility.
- `@iracedeck/iracing-plugin-mirabox` — Registers actions from `@iracedeck/iracing-actions` via `VSDPlatformAdapter` for Mirabox devices. Has its own `CLAUDE.md` documenting differences from the Elgato plugin.
- `@iracedeck/iracing-plugin-ulanzi` — Registers actions from `@iracedeck/iracing-actions` via `UlanziPlatformAdapter` for Ulanzi Deck devices (D200 / D200H / Dial / D200X). Reuses the canonical `com.iracedeck.sd.core` plugin UUID and `com.iracedeck.sd.core.*` action UUIDs verbatim (UlanziStudio only requires a 4-segment main-service UUID and doesn't validate the prefix), and injects a PI WebSocket bridge (`ulanzi-pi-bridge.js`, from `@iracedeck/pi-components`) so the shared sdpi-components PI works over UlanziStudio's protocol. Has its own `CLAUDE.md`. Validated live in UlanziDeck.
- `@iracedeck/website`

High-level guidance

- Follow rule files in `.claude/rules/` for granular conventions.
- Keep rules focused: one topic per markdown file.
- Use `paths` frontmatter in rules when a rule applies only to certain files.
- **Keep documentation in sync with reality.** When code changes alter conventions, patterns, APIs, or workflows described in any `CLAUDE.md` or `.claude/rules/` file, update those files in the same change. Stale instructions cause repeated mistakes.
- **Keep `README.md` in sync with reality.** When changes affect the project structure, action count, features, or development workflow described in `README.md`, update it in the same change.
- **Keep the developer Architecture page in sync with reality.** When a change alters the system's structure — packages or their boundaries, the two abstraction seams (`event-bus`, `IDeckPlatformAdapter`), runtime data/control flow, the internal dependency graph, or adding/removing a sim translator or device adapter — update the diagrams and prose in `packages/website/src/content/docs/docs/development/architecture.md` in the same change. Its Mermaid diagrams are hand-maintained, not generated.

Cross-platform development

This project supports development on both Windows and macOS. Both native addons (`@iracedeck/iracing-native` and `@iracedeck/audio-native`) automatically use mock implementations on non-Windows platforms. See the `cross-platform-development` skill and the respective `CLAUDE.md` files for details.

How to import or reference

You can import or reference specific rule files from other markdown using `@.claude/rules/<file>.md` if needed.

## Rule files

- `action-documentation.md`: How to document Stream Deck actions: settings tables, keyboard simulation tables, icon state tables, and the reference template.
- `black-box-icons.md`: Design guidelines for iRacing black box key icons: canvas layout, inner frame spec, text labels, layout patterns, and per-icon details. Scoped to black-box-selector files.
- `build-and-commit.md`: Worktree-based development workflow, pre-commit checks (`pnpm install` + `pnpm build`), build commands, conventional commit conventions, and post-merge worktree cleanup.
- `changelog.md`: When and how to update the public changelog page (`changelog.mdx`) — required on merge to `master`/`release/*` for user-facing changes, one-line-per-change (a feature and its follow-up fixes collapse into a single line), the in-development version section, and the fixed entry format.
- `code-style.md`: Formatting, linting, type conventions, Zod usage, and general code quality rules.
- `global-settings.md`: Plugin-level global settings architecture: Property Inspector usage, `ird-key-binding` with `global` attribute, Zod schema, and settings path conventions.
- `icons.md`: General icon guidelines: icon types (category, key, template), SVG structure, design specs, color palette, Mustache templates, and distinctiveness rules.
- `key-icon-types.md`: Standardized key icon type definitions (Default, Black Box, Inverted): canvas layout, two-line label system, Standard vs Inverted label layouts, per-action background colors, and icon content separation patterns. Scoped to icon SVG/TS files.
- `keyboard-shortcuts.md`: SDK-first principle, key binding architecture, Property Inspector setup for `ird-key-binding`, Zod schemas for key bindings, sending key combinations (tap and long-press/hold), global vs per-action bindings, and cross-package sync rules.
- `logging.md`: Log levels, info vs debug separation, `createScope()` usage, and dependency-injected logger patterns.
- `pi-templates.md`: EJS templates for Property Inspector HTML: directory structure, available partials, Rollup plugin config, key bindings JSON format.
- `platform-feature-flags.md`: Build-time feature flags per plugin (capabilities + features) with a gitignored `feature-flags.local.json` dev override; compile-time `__FEATURE_*__` / `__CAPABILITY_*__` constants for tree-shaking; PI template gating via `locals.platform`.
- `plugin-structure.md`: Plugin package naming conventions, Rollup config, native module handling (`keysender`), app monitoring, and critical initialization order in `plugin.ts`.
- `profiles-and-devices.md`: Stream Deck profiles + device reference (Elgato-only): the `DeviceType` id map, iRaceDeck device support matrix, the three bundled templates, the device-suffixed profile naming scheme (`iRaceDeck <template> <suffix>` files with clean user-facing names, #753), manifest `Profiles[]` registration, the author-in-app → export → register workflow, the distributed `.streamDeckProfile` bundle format, folder-navigation actions (`openchild`/`backtoparent`), and `switchToProfile` (by name). Canonical data source: `packages/deck-core/src/device-profiles.ts`. Scoped to that module + the Stream Deck plugin.
- `race-positions.md`: Single source of truth for race position/standings — the translator's canonical live order (`getLiveRacePositions` / `getLivePosition`, built on `calculateFrozenRacePositions`). Any feature needing a car's position, the running order, a position-relative neighbour, or class position MUST consume it (injected where the dependency direction requires) and never invent its own calculation; official `CarIdxPosition` is a fallback only. Scoped (`paths:`) to the position packages.
- `race-engineer-callouts.md`: How to add or modify a Race Engineer voice callout end-to-end. Architecture across event-bus / sim-events-iracing / audio-assets / audio-scenarios / deck-core / plugins / scenario-harness, naming conventions, and a step-by-step checklist with where each piece lives. Scoped (`paths:`) to the callout packages, so it only loads during callout work.
- `race-engineer-callout-examples.md`: Reference-implementation catalog for `race-engineer-callouts.md` — one entry per past callout (issue #) naming the pattern it established and the reusable lesson. Scoped to the same callout packages; consult when a new callout needs a variation the checklist doesn't cover.
- `sdpi-components.md`: Comprehensive reference for the `sdpi-components` web component library used in all Property Inspectors: every component's attributes and value types, Stream Deck client communication helpers, data sources, and localization. Scoped to PI files.
- `stream-deck-actions.md`: Action requirements (`ConnectionStateAwareAction`), SDK-first principle, PI components (`sdpi-select` quirks, conditional visibility), global settings setup, and dial support.
- `terminology-and-refs.md`: Project terminology (Property Inspector, Key Icon, Dial, Action ID) and external reference links.
- `testing.md`: Vitest conventions, test file naming, mocking patterns for Stream Deck SDK, and action test structure.
- `svg-platform-compatibility.md`: SVG feature support across platforms (QT5 SVG Tiny 1.2 for Mirabox vs QT6.7+ for Elgato): safe features, Elgato-only features, unsupported features, and guidelines for new icons.
- `website-action-docs.md`: Website action documentation format: per-mode sections with self-contained settings, dial info, and h5 setting subheaders. Scoped to website action pages. Canonical example: tire-service.md.
