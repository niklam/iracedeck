# iRaceDeck — Project memory

Project-wide instructions and overview for iRaceDeck. Topic rules live in `.claude/rules/` (listed at the bottom); a package with its own `CLAUDE.md` documents itself there.

Packages

Sim and telemetry

- `@iracedeck/iracing-native` — native addon for keyboard input, window focus and the elevation probe; mocked off Windows. Has its own `CLAUDE.md`.
- `@iracedeck/iracing-sdk` — TypeScript layer over the native SDK: `SDKController` (10 ms poll deduped on `SessionTick`), session-YAML parsing, `createSDK`/`createCommands` (the `Commands` broadcast surface behind deck-iracing's `getCommands()`), template resolver, flag/position/grid/track utilities.
- `@iracedeck/event-bus` — typed pub/sub with the canonical sim-event catalog. Sim- and audio-agnostic: the envelope's telemetry field is generic so it depends on no simulator SDK. Singleton trio `initializeEventBus`/`getEventBus`/`isEventBusInitialized`; catalog types in `src/index.ts`.
- `@iracedeck/sim-events-iracing` — the iRacing translator: diffs `sdkController` ticks and publishes semantic events, one diff module per family under `src/diff/`. The bus's only source of sim events; a future sim adapter is a parallel sibling emitting the same catalog (`telemetryReadout.requested` is the exception: the deck layer publishes it, not a translator). It is not the only reader of `@iracedeck/iracing-sdk` telemetry: actions read the SDK controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry through `getLatestTelemetry()` — the measured leaks are listed under the Architecture page's "Seams & where the abstraction leaks" (#1351). Owns the canonical live order (`getLiveRacePositions`/`getLivePosition`, `race-order.ts`) — see `race-positions.md`. Also records every car's lap crossings for `@iracedeck/replay-store` (`replay-laps`, `replay.lapStarted` / `replay.lapTimed`, #1203).
- `@iracedeck/track-data` — bundled Lovely Sim Racing corner markers (CC BY-NC-SA 4.0, used with permission — attribution is a grant condition), keyed by `WeekendInfo.TrackName`; generated `src/corners.iracing.ts`, refreshed by `node packages/track-data/scripts/refresh-corner-data.mjs` after building the package; a corner the refresh adds then needs a hand-authored `corner-names` entry and clip in every published voice, the same entry in each (`audio-assets/src/corner-names.test.ts` fails until it has, #1336). Zero runtime deps.

Audio and the Race Engineer (end-to-end walkthrough: `race-engineer-callouts.md`)

- `@iracedeck/audio-native` — native miniaudio 4-channel mixer. Has its own `CLAUDE.md`.
- `@iracedeck/audio-service` — TypeScript mixer singleton over audio-native (`AudioChannel`, `AudioBus`, `initializeAudio`, `getAudio`): bus routing, volumes, voice-sequence engine, device selection, and the on-demand device lifecycle that stops the stream after an idle window so it doesn't block PC sleep (#849). Resolves clips against ordered audio roots; since #1144 a pack root is bound to its own voices, so `voice/<pack>::<voice>/…` is served only by that pack and the ordered walk (which serves the sfx) never reaches a bound root.
- `@iracedeck/audio-assets` — voice clips, `sfx/`, the ElevenLabs generator, per-voice `configs/<voice-id>.voice.json` (lines and callout script), the packer and the catalog. Has its own `CLAUDE.md`.
- `@iracedeck/callout-script` — the JSON grammar for `voice/<id>/callouts.json`, the shared script-vs-clips coverage rules, and the composite voice id (`<pack>::<voice>`, `qualifyVoiceId`). A `zod`-only leaf so its three consumers need not depend on each other. Has its own `CLAUDE.md`.
- `@iracedeck/voice-packs` — the voice-pack stack (#1366, moved out of deck-core): the scanner, the voice-pack service, the catalog and its client, download, archive extraction, storage, the installer, the launch step, the voice labels and the missing-callout-script banner. Voices are `<pack id>::<voice id>` (#1144; ours is `default::default`), and no plugin bundles a voice — the launch step installs and updates the managed `default` pack at every start (#1034). Built on app-constants, callout-script and fetch-utils, with no production edge to settings or deck-core; `plugin-runtime` and the harness import it, and deck-core re-exports none of it. The development voice root it scans first is in `platform-feature-flags.md`. Has its own `CLAUDE.md`.
- `@iracedeck/callout-settings` — the registry of every Race Engineer callout opt-in (#1350): each `calloutEnabled*` key, its checkbox label and its default, declared once per family, plus the settings window's Callouts headings. `@iracedeck/settings` builds the schema fields and `isCalloutEnabled` from it, audio-scenarios derives its callout id types from it, and pi-components renders the checkbox rows from it; zero dependencies, so both sides of the settings / audio-scenarios split can reach it. Has its own `CLAUDE.md`.
- `@iracedeck/audio-scenarios` — the Race Engineer catalog: code-owned contracts paired with pack-owned scripts, the vocabulary, speak gates, and the pack-author tooling (`pnpm generate:pack-reference`, `pnpm lint:pack`). Has its own `CLAUDE.md`.
- `@iracedeck/race-engineer-wiring` — the Race Engineer's wiring: the bus caches its conditions read, every `registerPitCrew` dependency and the call (`wireRaceEngineer`), reading settings and their rules (`isCalloutEnabled`, `evaluateSetupWarning`, `resolveActiveDriverName`) from `@iracedeck/settings` directly and making its loggers as scopes of one `RaceEngineer` logger. Shared by the plugins (through `plugin-runtime`) and the harness. Has its own `CLAUDE.md`.
- `@iracedeck/scenario-harness` — local QA web UI (`127.0.0.1:5750`) that auditions callouts against a mock SDK. Every new bus event needs an `src/event-names.ts` entry and every new callout a shortcut button. Has its own `CLAUDE.md`.

Icons and rendering

- `@iracedeck/icons` — Mustache SVG key icons; regenerate `preview/` with `node scripts/generate-icon-previews.mjs` after an edit (freshness-tested). Conventions in `icons.md`.
- `@iracedeck/icon-composer` — zero-dependency SVG icon assembly, re-exported by deck-core. Has its own `CLAUDE.md`.
- `@iracedeck/rasterizer` — SVG→PNG via `@resvg/resvg-js` with bundled Arimo fonts (OFL); injected once by `plugin-runtime`'s `initInput`, gated by `pngRasterization`.

Deck layer

- `@iracedeck/logger` — the logger.
- `@iracedeck/app-constants` — the constants every layer shares, the Property Inspector bundle included (#1364): setting-key names, the voice-pack status payload and catalog location, the changelog policies, the Focus iRacing Window modes, the Mouse to Sim pointer target, the key map and default-binding parser, the settings-window page name and warning ids, the `_warnings` record shape (`PiWarning`, #1366), and `LogLocation`, where a host's own log lives — the type `IDeckPlatformAdapter.logLocation` reports and the watchdog writes to (#1367). Zero imports (a test refuses any) and no Node or DOM types; each name is imported from here only — deck-core re-exports none. Has its own `CLAUDE.md`.
- `@iracedeck/fetch-utils` — `abortAfter` and `readCappedJson` / `ResponseTooLargeError`, the request helpers app-updates' changelog feed client, voice-packs' catalog client and the Property Inspector bundle share (#1364). Zero dependencies, and typechecked twice, against the browser's globals and Node's, so only what both runtimes declare compiles. Has its own `CLAUDE.md`.
- `@iracedeck/settings` — the plugin's global settings, below the deck layer (#1365): the schema and cache, the one-shot migrations, the plugin-owned settings store, run-scoped keys, the PI warning banners, first run and the per-feature startup gates. It reaches the deck host only through its own `SettingsHost` interface, which deck-core's `IDeckPlatformAdapter` extends; deck-core re-exports none of its names, so each is imported, and mocked in a test, from here only. Rules in `global-settings.md`. Has its own `CLAUDE.md`.
- `@iracedeck/replay-store` — the per-session replay store (#1367, moved out of deck-core): replay markers (#1162) and the lap record (#1203), one file per `SubSessionID` under `%LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>`, debounced atomic writes with a synchronous load. Built on settings' path helpers and write-retry schedule; fed by deck-iracing's replay-session subscriber and the bus's `replay.lap*` events, read by Replay Markers and Replay Control. Has its own `CLAUDE.md`.
- `@iracedeck/diagnostics` — the plugin's self-diagnostics (#1367, moved out of deck-core): the main-thread watchdog (#1330), the resource monitor and the CPU profile capture (#1338), and the plugin-state section registry of the Telemetry Snapshot with its JSON-safe encoder (#1387): each owning package exports a reader of its own state, `plugin-runtime` registers them, and Telemetry Control's Take Snapshot collects them. Built on app-constants and logger; what it needs of iRacing, and of every other package's state, is injected. Log lines in `logging.md`. Has its own `CLAUDE.md`.
- `@iracedeck/app-updates` — the plugin's release notes and update checks (#1367, moved out of deck-core): the version-upgrade changelog opener (#680) and the What's New tab's update check (#1016) — the published-changelog feed client, its parser and sanitizer, and the cached service. Built on app-constants and fetch-utils. Has its own `CLAUDE.md`.
- `@iracedeck/settings-window` — the settings window's plugin side (#1367, moved out of deck-core): the loopback server and its request guard, the controller, the app-window launcher, the command handler, the failure banner, the settings-channel publisher and Explorer reveal. Built on settings, app-constants, callout-script and app-updates (types). Rules in `settings-window.md`; the guard and server are reviewed at `max`. Has its own `CLAUDE.md`.
- `@iracedeck/deck-core` — platform-agnostic base classes, types and services. Sim-neutral: it sees a simulator only through the `SimConnection` interface (`sim-connection.ts`: connected, a per-tick signal, the overlay's flags, title templates), which the sim's own deck package initialises, and a lint rule refuses any import of an iRacing package from its sources (#1351). Since #1367 it holds only the deck abstraction: the settings, the voice packs, the replay store, the diagnostics, the update checks and the settings window are each a package of their own, and deck-core re-exports none of their names. Has its own `CLAUDE.md` (the module map); window focus is in `keyboard-shortcuts.md`, the development voice root in `platform-feature-flags.md`.
- `@iracedeck/deck-iracing` — iRacing's side of that seam: `SimIRacingConnection`, the `SimIRacingAction` base for actions that read the SDK controller directly, the SDK singleton (`initializeSDK`, `getController`, `getCommands`) and the iRacing helpers actions share (app monitor, fuel telemetry, unit conversion, hotkey presets, elevation check, replay-session subscriber). A second sim gets a sibling `deck-<sim>`, chosen in `plugin-runtime`. Has its own `CLAUDE.md`.
- `@iracedeck/deck-adapter-elgato`, `-mirabox`, `-ulanzi` — adapters from each host protocol to deck-core's `IDeckPlatformAdapter`. Each has its own `CLAUDE.md`.
- `@iracedeck/iracing-actions` — every action, one folder each under `src/actions/<name>/` (`.ts`, test, `.ejs` PI, icons); imports from `@iracedeck/deck-core`, from `@iracedeck/settings` for the global-settings names, and, for the iRacing side (`SimIRacingAction`, `getCommands`, the fuel and unit helpers), `@iracedeck/deck-iracing`; the replay actions read `@iracedeck/replay-store`, and Telemetry Control's capture and snapshot modes `@iracedeck/diagnostics`; never `@elgato/streamdeck`. Has its own `CLAUDE.md`.
- `@iracedeck/plugin-runtime` — the composition root the three plugins share (#1349): `startPlugin(host)` runs ten startup phases whose order a test pins, plus the shared action list (`src/actions.ts`). Raw TypeScript compiled by each plugin's Rollup. Has its own `CLAUDE.md`.
- `@iracedeck/plugin-build` — the build-only package with `createPluginRollupConfig`, the shared Rollup config the three plugins pass their differences to (#1349). Has its own `CLAUDE.md`.
- `@iracedeck/pi-components` — the shared Property Inspector framework: `ird-*` web components, EJS partials, the Rollup compile/inject plugins, vendored `sdpi-components.js`, and the three bridges. Its components bundle imports only `@iracedeck/app-constants` and `@iracedeck/fetch-utils` from the workspace, and the bridges import neither; a Rollup guard refuses every other `@iracedeck/` import. See `pi-templates.md` and `settings-window.md`.
- `@iracedeck/iracing-plugin-stream-deck`, `-mirabox`, `-ulanzi` — the three plugins, each a shell (`src/plugin.ts`) that builds its adapter and calls `plugin-runtime`'s `startPlugin`, and build through `@iracedeck/plugin-build` (Ulanzi reuses the `com.iracedeck.sd.core` UUIDs verbatim). Each has its own `CLAUDE.md`; the Stream Deck one has the add-an-action walkthrough.

Website

- `@iracedeck/website` — the Astro + Starlight site at iracedeck.com (conventions in the `website` skill). Its build regenerates the gitignored gallery, changelog and voice-catalog artifacts; `src/data/pack-reference.json` is instead committed and freshness-tested, built by `pnpm generate:pack-reference`, with its shape mirrored by hand in `src/pack-reference-types.ts` — the site imports nothing from the engine.

High-level guidance

- Follow the rule files in `.claude/rules/` for granular conventions.
- **Working an issue? Start with `.claude/rules/issue-workflow.md`** — the ordered pipeline from filing to merge, naming which steps are gates.
- **Work through agents, and coordinate them by message.** The preferred shape is several agents in parallel with the main agent coordinating through `SendMessage` — the same way separate Claude Code sessions on this machine talk to each other. `ListAgents` shows everything addressable: spawned agents, other local sessions, and cloud sessions. Delegating also keeps an agent's tool output out of the coordinator's context, so work that would cost twenty file reads comes back as a paragraph.
- **Choose the model when you spawn an agent** (`opus`, `sonnet`, `haiku`, `fable`) — match it to the complexity of THAT task, never to the issue as a whole or the session's model; the hook refuses a spawn that names no `model`. The mapping (Niklas, 2026-09-06, after #1066 spent half its budget on work that did not need the top tier):
  - `fable` — demanding programming: a new seam across packages, a generator or linter other artifacts depend on, a subtle refactor, anything where a wrong result is expensive to discover.
  - `opus` — ordinary domain code and prose that needs judgement: a family file, an action, a website page, a rule edit, a batch of one-sentence descriptions, and every review that must weigh a claim against the code.
  - `sonnet` — mechanical or read-only work: a rename or extraction by recipe, a fixture update, a scoped re-check of a small fix diff, research fan-outs where the bottleneck is reading breadth.
  - `haiku` — trivial lookups and single-file mechanical passes.
  Say the chosen model and the reason in one line when dispatching. Two limits: `model` is ignored for `subagent_type: "fork"`, which always inherits the parent's model, so a deliberate choice means spawning a fresh agent; and an agent you did **not** spawn already has its own model, which you cannot set.
- **Stage reviews by the seams, not by the task list.** `.claude/rules/code-review.md` ("How reviews are staged inside an issue") is the rule; in one line: review a task before another task builds on its output, verify small fix diffs yourself, and give the whole branch exactly one full read — the `/code-review` — at the end, followed by the second read on the kinds of diff that rule names.
- **Worktrees are per issue, not per agent.** An issue is solved in one `../ir-<issue>` worktree; several agents may work inside it, and the coordinator keeps them from colliding: disjoint files, `git commit --only -F <msg> -- <paths>` (the index is shared), and each worker runs tests only on its OWN files — a directory-wide `pnpm test` picks up a sibling's half-edited file and reads as a red the worker then chases (#1138 cost ~4× on two tasks this way). The hook refuses `isolation: "worktree"` on a spawn, because one issue fragmented across trees is one nobody is tracking. Multi-agent *workflows* are a separate, much heavier tier and still need an explicit per-use request; none of the above authorises them.
- Keep rules focused: one topic per markdown file.
- Use `paths` frontmatter in rules when a rule applies only to certain files. Only the process rules (issue workflow, build and commit, review, hooks, specs, changelog, testing, code style, terminology) load in every session; every topic rule is path-scoped, because the always-loaded set must stay under Claude Code's 150k-char limit. Never start a rule with a lone `---`: the loader reads frontmatter up to the next `---` anywhere, table rows included, and silently drops everything in between. `scripts/claude-rules-frontmatter.test.mjs` guards both.
- **Keep documentation in sync with reality.** When code changes alter conventions, patterns, APIs, or workflows described in any `CLAUDE.md` or `.claude/rules/` file, update those files in the same change. Stale instructions cause repeated mistakes.
- **Keep `README.md` in sync with reality** — project structure, action count, features, development workflow — in the same change.
- **Keep the developer Architecture page in sync with reality.** When a change alters packages or their boundaries, the two abstraction seams (`event-bus`, `IDeckPlatformAdapter`), runtime data/control flow, the internal dependency graph, or adds/removes a sim translator or device adapter, update the hand-maintained Mermaid diagrams and prose in `packages/website/src/content/docs/docs/development/architecture.md` in the same change.

Cross-platform development

This project supports development on both Windows and macOS. Both native addons (`@iracedeck/iracing-native` and `@iracedeck/audio-native`) automatically use mock implementations on non-Windows platforms. See the `cross-platform-development` skill and the respective `CLAUDE.md` files for details.

How to import or reference

You can import or reference specific rule files from other markdown using `@.claude/rules/<file>.md` if needed.

## Rule files

**Always loaded** (no `paths` frontmatter):

- `build-and-commit.md` — worktree workflow, pre-commit checks, build commands, dependency build-script decisions and pinned pnpm versions, conventional commits, issue labels and the Roadmap board, merging, post-merge cleanup, releasing and the voice-pack publishing rules.
- `changelog.md` — when and how to add a changelog fragment in `changelog.d/`: the format, weight and order, one change per fragment, the fold into `changelog.mdx` at a stable release, the machine-read format and the gitignored `changelog.json`.
- `code-review.md` — the effort-level table, targeting the worktree, report-only, and how reviews are staged inside an issue.
- `code-style.md` — formatting, linting, types, Zod, exact versions, tsconfig inheritance, fenced-code languages.
- `hooks.md` — the Claude Code hooks that enforce the mechanical rules; read it before adding a "never do X" anywhere else.
- `issue-workflow.md` — the order an issue is worked in and which steps are gates. **Read this first when picking up an issue.**
- `specs-and-plans.md` — every feature/enhancement gets a spec committed to `master`; plans are never committed. Naming, header, required sections, freeze-after-ship.
- `terminology-and-refs.md` — project terminology (including the "Mode" label rule) and external references.
- `testing.md` — Vitest conventions, `pnpm typecheck`, native mocks in tests, the native config loader, action-test patterns.

**Path-scoped** (loaded when matching files are touched):

- `action-documentation.md` — action doc format: settings, keyboard and icon-state tables, communication method.
- `black-box-icons.md` — black box key icon design.
- `encoders-and-touchscreen.md` — dials and the touch strip: platform facts, release-time press classification, the hold preview, dial-action rules.
- `global-settings.md` — global settings architecture, the plugin-owned settings store and its migrations, run-scoped keys, warning banners, the version-upgrade changelog.
- `icons.md` — icon types, SVG structure, colour slots and locks, previews, distinctiveness.
- `key-icon-types.md` — Default / Black Box / Inverted key icon layouts and labels.
- `keyboard-shortcuts.md` — SDK-first, binding architecture, atomic sequences, window focus modes, cross-package sync.
- `logging.md` — log levels, info vs debug, `createScope()`, the `debugLogging` toggle, file logging and retention.
- `pi-templates.md` — PI EJS templates: layout, partials, shared CSS, Rollup config, key-binding JSON.
- `platform-feature-flags.md` — build-time flags per plugin, `feature-flags.local.json`, and the development voice root (the `IRACEDECK_DEV_VOICES` opt-in, the `dev.local.json` override, the `stage:dev-voices` build task).
- `plugin-structure.md` — plugin naming, Rollup config and log policy, native externals and the runtime `bin/package.json`, licenses, the shell `plugin.ts` and the startup phases.
- `profiles-and-devices.md` — Stream Deck profiles and devices (Elgato-only).
- `race-engineer-callouts.md` — adding or modifying a Race Engineer callout end to end.
- `race-engineer-callout-examples.md` — one entry per past callout and the pattern it established.
- `race-positions.md` — the canonical live race order every position consumer must use.
- `sdpi-components.md` — `sdpi-components` reference.
- `settings-window.md` — the dedicated settings window: server, guard, bridges, page, and its rules.
- `stream-deck-actions.md` — action requirements, `ird-*` components, conditional visibility, dial support, per-mode comms.
- `svg-platform-compatibility.md` — the resvg SVG baseline and the `pngRasterization` caveat.
- `website-action-docs.md` — website action page format (canonical example: `tire-service.md`).
- `website-screenshots.md` — settings-window screenshots come from `pnpm capture:settings`.
