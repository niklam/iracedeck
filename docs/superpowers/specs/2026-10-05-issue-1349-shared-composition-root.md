# One shared composition root for the three plugins

> **Issue:** [#1349](https://github.com/niklam/iracedeck/issues/1349) · **Also closes:** [#1104](https://github.com/niklam/iracedeck/issues/1104) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Each plugin's `src/plugin.ts` is the whole composition root, run at module scope: about 39 steps over some 33 singletons that throw on a second initialisation. With comments stripped, the Mirabox and Ulanzi copies differ by the adapter import and constructor. The Stream Deck copy differs by about 25 code lines, all host capabilities. The order is load-bearing and is recorded only in comments, three times.

One ordering hazard is invisible in the code. The voice-pack service's `onPacksChanged` callback calls pushers that read `let` dedupe markers declared further down the module. Only an `isGlobalSettingsInitialized()` guard and the statement order keep it from throwing a temporal-dead-zone `ReferenceError`.

`scenario-harness` wires `registerPitCrew` a fourth time. It supplies 13 of its 58 dependencies, and its own comment records that a missing one "has made a call silent for the wrong reason twice already". The three `rollup.config.mjs` files are near-copies too.

## Decision

### Two new packages

| Package | Depends on | Exports | Consumed by |
| --- | --- | --- | --- |
| `@iracedeck/race-engineer-wiring` | `audio-scenarios`, `deck-core`, `event-bus`, `sim-events-iracing`, `logger` | `wireRaceEngineer(bus, deps)` | `plugin-runtime`, `scenario-harness` |
| `@iracedeck/plugin-runtime` | everything the plugins depend on today except the adapters, plus `race-engineer-wiring` | `startPlugin(host)`, the shared action list | the three plugins |

**Why not `deck-core`.** A bootstrap that registers actions and calls `registerPitCrew` cannot live in `deck-core`, for three reasons:

- `iracing-actions` depends on `deck-core`, a direct cycle.
- `audio-scenarios` → `audio-assets` → (dev) `deck-core` closes another.
- It would bind `deck-core` to iRacing, which #1351 exists to undo.

The cycles run one way only: `deck-core` cannot import the packages above it. A package above `deck-core` importing it is the normal direction, as every action, adapter and the harness already does. `deck-core`'s own dependency tree (`callout-script`, `icon-composer`, `iracing-sdk`, `iracing-native`, `logger`) holds none of the wiring's other dependencies, so the wiring imports `deck-core` directly.

**Why the wiring is its own package.** The harness must be able to use the same Race Engineer wiring without `iracing-actions` or the native addons. Putting the wiring in `plugin-runtime` would make the harness depend on both. Putting it in `audio-scenarios` was weighed and declined in favour of a clear boundary of its own.

**`wireRaceEngineer(bus, deps)`** owns three things:

- **The plugin-side bus caches.** `lap.completed`, `cornerName.approaching`, `race.finished`, the overtake loggers, the `incident.scored` timestamp behind the overtake gate, and the pending-car live position. All are subscribed before `registerPitCrew`, because the engine's `where:` clauses read them.
- **The `registerPitCrew` call itself.**
- **Every one of its 58 dependencies,** built from:
  - `deck-core`, imported directly: `getGlobalSettings` for the `*_CALLOUT_SETTING_KEYS` gates and the two master gates (`pitCrewRaceEngineerEnabled`, `pitCrewRadarEnabled`), `evaluateSetupWarning`, and the driver-name resolution. Nothing that `deck-core` already provides is injected.
  - `logger: ILogger`, from which every scoped logger is made with `createScope` (`@iracedeck/logger`); no logger factory is injected. The bootstrap passes `adapter.createLogger("RaceEngineer")`.
  - `sim: SimRuntime`, the translator's query getters (see the sim seam).
  - `voice`, the driver-name state the voice-pack phase owns.
  - `overrides?: Partial<PitCrewDeps>`, which wins over what the wiring builds. The harness uses it for its snapshot stubs. The plugins pass none.

The 30 `get<Family>CalloutEnabled` closures move into the wiring unchanged. Replacing them is #1350.

### The sim seam

One phase, `initSim(core)`, is the only place a sim translator is chosen and constructed. Today that is `initializeSimEventsIracing(...)` plus `getController().setLivePositionsProvider(...)`. It returns a `SimRuntime` object holding the query getters the Race Engineer reads. `wireRaceEngineer` receives that object instead of importing the getters from `sim-events-iracing` at the call site.

`SimRuntime`'s type stays iRacing-shaped here. Making it sim-neutral, and adding a second translator beside the first, is #1351.

### The adapter contract and the Stream Deck extension

`IDeckPlatformAdapter` gains what every host already has or knows:

- `openUrl(url)` and `onOpenSettingsRequest(handler)`, already implemented on all three adapters.
- `setLogLevel(level: LogLevel)`. The Elgato adapter forwards to `streamDeck.logger.setLevel`, and Mirabox and Ulanzi keep their own.
- `logLocation`, which is `{ kind: "file"; path }` (Elgato), `{ kind: "daily"; dir }` (Mirabox, Ulanzi), or `undefined` for a Mirabox or Ulanzi adapter built without a log directory (their tests and the harness do this). The main-thread watchdog and the CPU-profile directory read it; `initCore` throws a clear error on `undefined`, which no plugin shell hits.

What only Stream Deck has comes in as an optional `extension` that only the Stream Deck shell passes:

- the profile switcher
- the deck-device list and its connect/disconnect listeners
- the connected device type for the version check
- `switchProfile` for the settings-window command handler
- `SwitchProfile` as an extra action, registered after the shared list (registration order is not observable: every adapter keys its handlers by UUID)

The bootstrap tests for the extension's presence, never for a host name.

### Startup phases

`startPlugin(host)` is **synchronous**, like the module scope it replaces. The fire-and-forget async work (`voicePacks.refresh()`, `settingsWindow.ensureStarted()`, the launch step, the 15 s notices timer) stays fire-and-forget. Step numbers refer to today's Stream Deck `plugin.ts` order.

| # | Phase | Takes | Returns | Contents |
| --- | --- | --- | --- | --- |
| 1 | `initCore` | host | `Core`: host (adapter, optional extension, bin directory), bus, controller | plugin config, log-level toggle, watchdog, resource monitor, setup-warning listener, SDK, event bus (1–8) |
| 2 | `initSim` | `Core` | `SimRuntime` | translator, live-positions provider (9–10) |
| 3 | `initInput` | `Core` | `Input`: the native addon object | keyboard, clipboard, rasterizer behind `__FEATURE_PNG_RASTERIZATION__` (11–12) |
| 4 | `initAudio` | `Core` | `Audio`, including `armFeatureGateSync` | audio, feature-gate listeners, dormant (13–14) |
| 5 | `initVoicePacks` | `Core`, `Audio` | `VoicePacks`: state, service, installer, launch step, pushers | the #1104 block, including the first `refresh()` (15, 20) |
| 6 | `initRaceEngineer` | `Core`, `SimRuntime`, `Audio`, `VoicePacks` | — | `initializeAudioScenarios`, then `wireRaceEngineer`, then `setScripts` (16–19) |
| 7 | `initSettings` | `Core`, `Audio`, `VoicePacks` | `Settings`: store, replay store, `openSettingsWindow` | settings and replay stores, settings window, startup notices, the global-settings listener with its store-ready block, PI-appear re-pushes (21–26) |
| 8 | `registerActions` | `Core`, `Input` | — | window focus, mouse pointer, focus listeners, then the shared list plus the extension's extras (27–29) |
| 9 | `startServices` | `Core`, `Input`, `Settings`, `VoicePacks` | — | `initGlobalSettings` → launch step `start()` → key migrations and binding seeds → extension start → settings request → SimHub → binding dispatcher → app monitor → elevation and replay subscribers (30–38) |
| 10 | `adapter.connect()` | — | — | always last (39) |

A plugin's `plugin.ts` becomes a shell: construct the adapter, build the extension if the host has one, and call `startPlugin`.

### How the order is held

- **Data dependencies are held by the types.** A phase takes what it needs as arguments, so it cannot run before that exists:
  - `initGlobalSettings` after the first pack refresh
  - the launch step after `initGlobalSettings`
  - the settings window after the store
- **The temporal-dead-zone hazard is removed by construction.** Voice-pack state and its dedupe markers live on the `VoicePacks` object, which exists before anything can call back into it.
- **Orderings with no data edge stay inside one phase, adjacent, with their existing comments:**
  - caches before `registerPitCrew`
  - `setScripts` after `registerPitCrew`
  - first-run check before the version check
  - migrations → `applyStartupFeatureGates` → `armFeatureGateSync`
  - focus listeners before actions
  - SimHub before the binding dispatcher
  - the launch step at the bootstrap level, never in the store-ready block (#1034 ruling 2)
- **An order test pins the whole sequence.** It mocks every `init*` / `register*` / `start*` call the bootstrap makes, runs `startPlugin` against a fake adapter, and asserts the exact recorded call order. A moved call fails it and names the two calls that swapped.

**Error handling is unchanged.** Each step keeps its current failure behaviour. No catch is added or removed.

### Harness

`scenario-harness` calls `wireRaceEngineer` with:

- `logger`: its own root logger
- `sim`: the real translator getters over `MockSDKController`
- `overrides`: its session-start, race-start and qualifying-invalidation snapshot stubs

Settings reach the wiring through `deck-core`'s `getGlobalSettings`, which in the harness reads its seeded memory store with every gate on, so the "everything audible" intent holds; the gates are read when a callout fires, so the harness's late `initGlobalSettings` is no problem. Its own `lap.completed` and corner-name caches are deleted. It gains one dependency, `race-engineer-wiring`, and still has no `iracing-actions` and no native addon. Its late `initGlobalSettings` and its `_reset*` test hooks are unchanged.

### Rollup

A new build-only package, `@iracedeck/plugin-build`, exports `createPluginRollupConfig(options)`, and each plugin's `rollup.config.mjs` passes only what differs. It is a devDependency of the three plugins and declares the Rollup plugins and the `pi-components` / `audio-assets` build imports itself — a module under `scripts/lib/` cannot import them, since the root declares none (amended during slice 3). Being a declared dependency, it orders and invalidates each plugin's build through turbo's package graph with no hand-written input.

| Option | Stream Deck | Mirabox | Ulanzi |
| --- | --- | --- | --- |
| `sdPluginDir` | `com.iracedeck.sd.core.sdPlugin` | `com.iracedeck.sd.core.sdPlugin` | `com.ulanzi.iracedeck.ulanziPlugin` |
| `platform` | `stream-deck` | `mirabox` | `ulanzi` |
| `extraExternals` | none | `ws` | `ws` |
| `assetCopy` | icon, key, dial SVGs | icon, key + `imgs/plugin` | icon, key + `imgs/plugin` |
| `piBridge` | `PI_SETTINGS_BRIDGE` | `PI_SETTINGS_BRIDGE` | `ulanzi-pi-bridge.js` (all three copy the PI browser assets; only the bridge in that list differs) |
| `stripHtmlLang` | false | true | false |

The factory keeps the existing shared helpers: `pluginBuildOnLog`, `runtimePackageJsonPlugin`, `resolveDevVoicePacksRoot`.

### Delivery: three slices, one PR each

1. Both packages, the adapter-interface change, the three plugins reduced to shells, and the voice-pack phase (closes #1104). Because `plugin-runtime` ships as raw TypeScript, like `iracing-actions`, each plugin's `rollup.config.mjs` gets two small edits in this slice (its `typescript({ include })` and its source resolver name the new package). The plugins keep all their current dependencies in this slice; slice 3 drops only those slice 1 left unused (`zod` and `vitest` on Mirabox and Ulanzi, `@elgato/utils` on Stream Deck). Workspace packages a plugin now reaches only through `plugin-runtime` stay declared, so the build graph does not change.
2. The harness moves onto `wireRaceEngineer`.
3. The shared rollup factory in `@iracedeck/plugin-build`, and the orphaned-dependency pruning above.

Each slice is reviewed, manually tested and merged before the next starts.

## Out of scope

- #1350: replacing the `calloutEnabled*` closures. They move into `wireRaceEngineer` as they are.
- #1351: a sim-neutral `SimRuntime` and a second translator.
- Any behaviour change. Same order, same events, same settings, same logs — except that the Race Engineer's scoped log prefixes gain their parent scope (`[LapCompleted]` becomes `[RaceEngineer:LapCompleted]` on Mirabox and Ulanzi, and `RaceEngineer->LapCompleted` on Stream Deck, whose SDK joins scopes with `->`).
- The `pi-components` rollup config, which is a separate browser build of a different shape.
- Moving `iracing-actions`' own wiring (`applyRadar*`, `applyRaceEngineerAudio`) into the shared root.

## Testing

**Guards:**

- `scripts/plugin-shell-guard.test.mjs` fails when any `plugin.ts`:
  - imports `registerPitCrew`, `initializeSimEventsIracing`, `initializeAudioScenarios` or a `*_CALLOUT_SETTING_KEYS`
  - calls `registerAction`
  - exceeds 80 lines
- `scripts/dev-voice-root-guard.test.mjs` is repointed from the three `plugin.ts` files to the voice-pack phase.
- A shared-action-list test fails unless the registered actions match each manifest. Stream Deck's list must contain `SwitchProfile`; Mirabox's and Ulanzi's must not. Nothing ties the registrations to the manifests today.
- The five tests that read each `rollup.config.mjs` (`rollup-logs`, `runtime-deps-guard`, `third-party-licenses`, `settings-window-icon`, `dev-voice-root-guard`) are rewritten to read the factory once and to check that every plugin config calls it.

**Unit tests:**

- Each phase, against mocks.
- The order test.
- `wireRaceEngineer`:
  - each settings-backed gate reads its own key
  - an override wins over the built dependency
  - the caches subscribe before `registerPitCrew`
  - no dependency is left to `DEFAULT_DEPS` in the plugin configuration
- A harness test that it passes no key the wiring already builds, except the declared overrides.
- The adapter additions in all three adapters.

**Manual test, per slice, by the maintainer:**

1. All three hosts start; keys work; the settings window opens; a voice pack installs and switches; a Race Engineer callout fires in a session. On Stream Deck, Switch Profile and the device list also work.
2. The harness auditions a callout from each family.
3. All three plugins build and run with the factory config.
