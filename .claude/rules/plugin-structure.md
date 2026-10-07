---
paths:
  - "packages/iracing-plugin-*/**"
  - "packages/deck-adapter-*/**"
  - "packages/plugin-runtime/**"
  - "packages/plugin-build/**"
  - "packages/deck-core/src/plugin-config.ts"
  - "scripts/lib/runtime-deps.mjs"
  - "scripts/lib/rollup-logs.mjs"
  - "THIRD-PARTY-LICENSES.md"
---

# Stream Deck Plugin Structure

## Architecture

The plugin system uses a platform abstraction architecture with these key packages:

- `@iracedeck/deck-core` — Platform-agnostic base classes, types (`IDeckWillAppearEvent`, etc.), and shared utilities; sim-neutral, seeing the simulator only through `SimConnection` (#1351)
- `@iracedeck/deck-iracing` — iRacing's side of that seam: `SimIRacingConnection`, the `SimIRacingAction` base, the SDK singleton (`initializeSDK`, `getController`, `getCommands`), the app monitor and the other iRacing helpers
- `@iracedeck/deck-adapter-elgato` — Elgato Stream Deck adapter implementing `IDeckPlatformAdapter`
- `@iracedeck/deck-adapter-mirabox` — Mirabox adapter implementing `IDeckPlatformAdapter` via WebSocket
- `@iracedeck/deck-adapter-ulanzi` — Ulanzi Deck adapter implementing `IDeckPlatformAdapter` via WebSocket (normalizes UlanziStudio `cmd` frames into Elgato-style events)
- `@iracedeck/iracing-actions` — All action implementations (import from `@iracedeck/deck-core` and `@iracedeck/deck-iracing`, not platform-specific SDKs)
- `@iracedeck/plugin-runtime` — the shared composition root: `startPlugin(host)` and the shared action list; each plugin's `plugin.ts` is a shell over it (#1349)

Actions do NOT import from `@elgato/streamdeck` or any platform SDK. They import from `@iracedeck/deck-core` and are registered via the platform adapter by `plugin-runtime`'s `registerActions`, once for all three plugins.

### Ulanzi naming + PI bridge (issue #508)

The Ulanzi plugin diverges from the Elgato/Mirabox naming conventions below:

- Plugin folder: `com.ulanzi.iracedeck.ulanziPlugin` (installed into `…/UlanziDeck/Plugins/`; the `*.ulanziPlugin` suffix is what UlanziStudio scans for, and the `com.ulanzi.<name>.ulanziPlugin` form matches the installed first-party plugins). The folder name and the manifest UUID are independent.
- Manifest `UUID`: `com.iracedeck.sd.core` (== `PLUGIN_UUID` in `@iracedeck/deck-adapter-ulanzi` — the same UUID the Elgato/Mirabox plugins use). UlanziStudio only requires a 4-segment main-service UUID and does **not** validate the prefix, so iRaceDeck keeps its own namespace.
- Action UUIDs: `com.iracedeck.sd.core.<action>` — the canonical iRaceDeck UUIDs, declared verbatim in the manifest. No remapping: the plugin registers actions directly, exactly like Mirabox.
- Manifest is the Ulanzi format (`Type:"JavaScript"`, per-action `Controllers:["Keypad"|"Encoder"]`, `Encoder:{layout:"$UA1"}` for dials, `States:[{Image}]`). `"Information"` controllers are dropped (no Ulanzi equivalent).
- PI connection: UlanziStudio does not call `connectElgatoStreamDeckSocket`, so the shared Rollup config injects `ulanzi-pi-bridge.js` (the Ulanzi config's `piBridge` option; from `@iracedeck/pi-components`, built from `src/ulanzi-bridge/`) before `sdpi-components.js` into every generated PI HTML except `settings-window.html`, which gets the settings-window bridge instead (#992; `injectBridgeScriptPlugin` from `@iracedeck/pi-components/build`, shared by all three plugins). The bridge monkeypatches `window.WebSocket` and translates Elgato ↔ Ulanzi PI frames, so the shared sdpi-components/`ird-*` stack is reused unchanged. See `packages/iracing-plugin-ulanzi/CLAUDE.md`.

## Active Plugins
- `iracing-plugin-stream-deck` (com.iracedeck.sd.core) — Elgato Stream Deck, uses `@iracedeck/deck-adapter-elgato`
- `iracing-plugin-mirabox` (com.iracedeck.sd.core) — Mirabox, uses `@iracedeck/deck-adapter-mirabox`
- `iracing-plugin-ulanzi` (com.iracedeck.sd.core) — Ulanzi Deck, uses `@iracedeck/deck-adapter-ulanzi`

All three plugins register the same actions from `@iracedeck/iracing-actions`, through `plugin-runtime`'s shared list. When adding or modifying actions, changes must be applied to **all** plugin packages (the shared list in `plugin-runtime/src/actions.ts`, manifest entries, PI templates where applicable).

## Creating New Plugins

Use `iracing-plugin-stream-deck` as the reference implementation for Elgato plugins, and `iracing-plugin-mirabox` for Mirabox/VSD plugins. Create the following structure:

```text
packages/iracing-plugin-stream-deck-{name}/
├── package.json                           # @iracedeck/iracing-plugin-stream-deck-{name}
├── tsconfig.json                          # Extends ../../tsconfig.base.json
├── rollup.config.mjs                      # createPluginRollupConfig({...}) from @iracedeck/plugin-build
├── .gitignore                             # node_modules/, *.sdPlugin/bin, *.sdPlugin/logs
├── .vscode/
│   ├── launch.json                        # Debugger attach config
│   └── settings.json                      # JSON schema for manifest
├── src/
│   ├── plugin.ts                          # Shell: build the adapter (+ extension), call startPlugin
│   ├── svg.d.ts                           # SVG type declarations
│   └── actions/                           # Action implementations
├── icons/                                 # SVG icon templates
└── com.iracedeck.sd.{name}.sdPlugin/
    ├── manifest.json                      # Plugin metadata
    ├── LICENSE                            # Copied at build time from the repo root (#905)
    ├── THIRD-PARTY-LICENSES.md            # Copied at build time from the repo root (#905)
    ├── imgs/
    │   ├── plugin/                        # category-icon.png, marketplace.png (@1x and @2x); iracedeck.ico (Volume Mixer, #1253)
    │   └── actions/{action-name}/         # icon.svg, key.svg for each action
    └── ui/
        ├── settings.html                  # Global settings (disableWhenDisconnected) — compiled from @iracedeck/pi-components
        ├── sdpi-components.js             # Copied at build time from @iracedeck/pi-components/browser
        ├── pi-components.js               # Copied at build time from @iracedeck/pi-components/browser
        └── {action-name}.html             # Action-specific Property Inspector — compiled from @iracedeck/pi-components
```

### Key identifiers to update when creating a new plugin:
| Item | Format |
|------|--------|
| Package name | `@iracedeck/iracing-plugin-stream-deck-{name}` |
| Plugin UUID | `com.iracedeck.sd.{name}` |
| sdPlugin folder | `com.iracedeck.sd.{name}.sdPlugin` |
| Action UUIDs | `com.iracedeck.sd.{name}.{action-name}` |

### After creating the plugin:
1. Add `"@iracedeck/plugin-build": "workspace:*"` to the plugin's `devDependencies`, beside `"@iracedeck/pi-components": "workspace:*"` and `"@iracedeck/iracing-actions": "workspace:*"` in its `dependencies`, and make `rollup.config.mjs` one `export default createPluginRollupConfig({ configUrl: import.meta.url, … })` call with the plugin's options (see `packages/plugin-build/CLAUDE.md`). The factory does the wiring: the PI templates, the copy of `sdpi-components.js`/`pi-components.js` and the bridges, and the per-action `icon.svg`/`key.svg` copy into `{sdPlugin}/imgs/actions/<name>/` (the files named in `assetCopy.actionIcons`) — no manual copy and no Rollup plugin of the plugin's own.
2. Run `pnpm install` in the package directory
3. Run `pnpm build` to verify build succeeds
4. Run `streamdeck link com.iracedeck.sd.{name}.sdPlugin` to register with Stream Deck
5. Restart Stream Deck to see the new plugin category

### Rollup Configuration

The three plugins build through one Rollup config: `createPluginRollupConfig` from `@iracedeck/plugin-build` (#1349). A plugin's `rollup.config.mjs` is a single call passing only what differs between the plugins (its folder, platform, extra externals, which assets it copies, its PI bridge, the VSD Craft `lang` strip); every step below lives in the factory, `packages/plugin-build/src/plugin-rollup.mjs`. Its options, step order and the rules for changing it are in `packages/plugin-build/CLAUDE.md`. A plugin build runs from its own package (`rollup -c` there, as every package script does) — the factory refuses any other working directory.

**The build's logs go through one shared policy (#1176).** The factory sets `onLog: pluginBuildOnLog` from `scripts/lib/rollup-logs.mjs`, and no config has an `onwarn` of its own; turbo hashes the helper as an input of each plugin's `#build`. The policy does three things and passes every other log through unchanged:

- **A circular dependency among workspace sources fails the build.** When every module in a cycle is one of the repo's own files (inside the repo, outside every `node_modules`, not a virtual `\0` id), `CIRCULAR_DEPENDENCY` is promoted to an error. A warning nobody reads is how the `sdk-singleton` → `window-focus-service` → `app-monitor` cycle, then all three in deck-core, sat on `master` unnoticed. Break a cycle by injecting the function across the seam, the way the window service receives `isIRacingActive`; never widen the policy to silence one. A cycle that runs through any dependency still prints as a warning.
- **zod's and semver's internal cycles are dropped**, as the configs always did.
- **`INVALID_ANNOTATION` from inside zod's package is dropped.** Since 4.5.4 (still true in 4.6.x), zod has two comments that mention `@__PURE__` in prose; Rollup removes them and warns six times a build, and the bundle is unaffected. The same code from anywhere else still prints. `scripts/lib/rollup-logs.test.mjs` bundles the installed zod with the plugins' own Rollup and fails once it no longer produces that warning, naming the entry to remove.

A new plugin package calls the factory, declares `@iracedeck/plugin-build`, and its `#build` hashes `scripts/lib/rollup-logs.mjs`; the guard in `rollup-logs.test.mjs` discovers plugins from their manifests and checks all three, plus that the factory uses the helper.

`@iracedeck/plugin-runtime` is raw TypeScript like `iracing-actions`: the `typescript` plugin's `include` and the `resolve-actions-ts` resolver name both, and `@rollup/plugin-replace` (no `include` filter) substitutes the `__FEATURE_*__` constants in both. The factory names both packages, so a new plugin gets them by calling it.

### Native Module Dependencies (keysender, @resvg/resvg-js)

**CRITICAL**: If your plugin uses keyboard functionality (`getKeyboard()`, `initializeKeyboard()`) or PNG rasterization (`initializeRasterizer()`, `@iracedeck/rasterizer`), you MUST:

1. **Mark native modules as external** - Native CommonJS/N-API modules like `keysender` and `@resvg/resvg-js` cannot be bundled into ES modules. The factory's `external` is `pluginExternals(extraExternals)`: `BASE_EXTERNALS` from `@iracedeck/plugin-build/externals`, which every plugin leaves out, followed by the plugin's own `extraExternals` option (`["ws"]` on Mirabox and Ulanzi). A native module every plugin loads goes in `BASE_EXTERNALS`; one only some plugins load goes in their `extraExternals`:
```javascript
// packages/plugin-build/src/externals.mjs
export const BASE_EXTERNALS = ["@iracedeck/audio-native", "@iracedeck/iracing-native", "@resvg/resvg-js", "yaml", "keysender"];
```

**Why this matters**: Bundling `keysender` or `@resvg/resvg-js` (native modules) into an ES module output causes runtime errors like "require is not defined". They must be loaded at runtime from `node_modules`. Unlike `keysender`, `@resvg/resvg-js` ships prebuilt binaries for macOS and Linux too, so it needs no mock and no `optionalDependencies` split — it's a plain `dependencies` entry on every platform.

2. **Emit the runtime `package.json` through the shared helper — never type a version** (#1177). The installed plugin's `bin/` runs `npm install` against a `package.json` the build emits beside `plugin.js` — each plugin's `postbuild` runs it through `scripts/install-runtime-deps.mjs` rather than a bare `cd … && npm install`, because the script hands npm only the `npm_config_*` keys npm defines, so npm does not warn about the pnpm-only ones `pnpm run` exports (#1205). `runtimePackageJsonPlugin` from `scripts/lib/runtime-deps.mjs` produces it, and it is the only thing that may. The factory carries the one call, so a plugin config never names it:
```javascript
// packages/plugin-build/src/plugin-rollup.mjs
import { runtimePackageJsonPlugin } from "../../../scripts/lib/runtime-deps.mjs";

// in plugins: [...]
runtimePackageJsonPlugin({ root: repoRoot }),
```
It reads the config's own `external` array, so what is left out of the bundle and what `bin/` installs are one list. Each `@iracedeck/*` external becomes a `file:` link to its workspace package (`file:../../../iracing-native`); every other external ships at the exact version the workspace `package.json` files declare for it (the root one and `packages/*`, in `dependencies` / `optionalDependencies` / `devDependencies`), under `optionalDependencies` when every declaration is optional. It **throws** — naming the package and the files — when an external is declared nowhere, at two different versions, or at a range. Version literals in the three configs were invisible to Dependabot and drifted (`yaml` and `ws` shipped behind the workspace, Mirabox's `ws` inside a published advisory); a security bump now reaches users the moment it lands in the workspace. So a new third-party external needs a declaration, at an exact version, in the workspace package whose code loads it — and nothing in the factory or a plugin's config.

3. **`keysender` is optional, declared by deck-core, and never built by pnpm.** No workspace source imports it statically — `deck-core/src/keyboard-service.ts` loads it at runtime through a variable module name — but `deck-core` declares it under `optionalDependencies` so Dependabot can see it and the helper has a version to ship. It is deliberately declined — **`keysender: false` under `allowBuilds` in `pnpm-workspace.yaml`**: its install script is `node-gyp rebuild` of Windows-only code, so a workspace `pnpm install` downloads it without compiling it and without asking about it, and Linux CI never tries to build it — the failure that removed it from the workspace in `56f9aff7d`. The copy that runs is the one `npm install` compiles in each plugin's `bin/`, where it is optional so a machine that cannot compile it still gets a working bin. `scripts/runtime-deps-guard.test.mjs` holds all of this: the factory emits through the helper and bundles around exactly `pluginExternals(extraExternals)`, every plugin config calls the factory and leaves `external` and the emitter to it, no version literal sits in a config, the factory or `externals.mjs`, every shipped third-party external matches the workspace, `keysender` stays optional and declined in `allowBuilds`, and turbo hashes what the helper reads (`scripts/lib/runtime-deps.mjs`, the root `package.json` and `packages/*/package.json` are inputs of each plugin's `#build`, since a conflicting declaration can sit in a package outside the plugin's dependency graph).

4. **Bundle the rasterizer's fonts** - `@iracedeck/rasterizer` ships bundled Arimo font files (`packages/rasterizer/fonts/`) that must be copied into `{sdPlugin}/assets/fonts/` at build time (a dedicated `generateBundle` copy step, same pattern as the per-action icon copy) so `createSvgRasterizer({ fontsDir })` can find them at runtime.

All four are done once, in the factory (`packages/plugin-build/src/plugin-rollup.mjs`); reference it for the correct configuration.

### License and Third-Party Notices

Every plugin artifact must ship the project `LICENSE` and the aggregated `THIRD-PARTY-LICENSES.md` at the sdPlugin root (issue #905): LICENSE §3/§5/§7 require the license text in every distributed copy, and several shipped components carry notice obligations of their own (the iRacing SDK's BSD-3-Clause notice, the MPL-2.0 source pointer for `@resvg/resvg-js`, the Lovely Sim Racing corner-data attribution). Both files are copied from the repo root by the `copy-license-files` `generateBundle` step in the shared factory (`@iracedeck/plugin-build`, same pattern as the rasterizer-fonts copy), and the copies are gitignored in each plugin package — a new plugin gets the copy step by calling the factory and adds only the `.gitignore` entries.

When a shipped third-party dependency or vendored component is added or removed, update the repo-root `THIRD-PARTY-LICENSES.md` in the same change. `scripts/third-party-licenses.test.mjs` guards the wiring: every non-workspace rollup `external` (`BASE_EXTERNALS` plus each plugin's `extraExternals`) must have an entry in the file, the factory must contain the copy step anchored on the repo root, every plugin config must call the factory and leave the copy to it, and no `.sdignore` pattern may exclude the two files from the packed plugin.

### Supported Operating Systems

Every plugin manifest declares **Windows and nothing else** (issue #994):

```json
{
  "OS": [{ "Platform": "windows", "MinimumVersion": "10" }]
}
```

iRaceDeck exists to control iRacing, which has no macOS build, and the keyboard/window/audio addons are Windows-native. The `@iracedeck/iracing-native` / `@iracedeck/audio-native` mocks exist so the repo can be installed, built, and tested on a Mac or Linux machine (see the `cross-platform-development` skill) — they are **not** a reason to add a `mac` entry, which would only offer host users an install that can do nothing. `scripts/manifest-platform.test.mjs` guards this across every discovered plugin manifest (plugin-level `OS` and per-action `OS` alike), so a new plugin folder is covered automatically.

### Application Monitoring

To enable app monitoring (for features like conditional reconnection that pauses when iRacing isn't running), add to manifest.json:

```json
{
  "ApplicationsToMonitor": {
    "windows": ["iRacingSim64DX11.exe"]
  }
}
```

This allows the plugin to receive `applicationDidLaunch` and `applicationDidTerminate` events when iRacing starts/stops.

### Startup phases (`@iracedeck/plugin-runtime`)

Every plugin starts through one composition root (#1349). Its `plugin.ts` is a shell: it builds the host's `IDeckPlatformAdapter` — and on Stream Deck a `PluginExtension` — and calls `startPlugin(host)`, which runs ten synchronous phases from `packages/plugin-runtime/src/phases/`, called in this order by `src/start-plugin.ts`:

| # | Phase | Takes | Returns | Does |
| --- | --- | --- | --- | --- |
| 1 | `initCore` | `PluginHost` | `Core` | build-time config (`initPluginConfig`), the log level, the main-thread watchdog and resource monitor, the setup-warning check, the SDK, the event bus |
| 2 | `initSim` | `Core` | `SimRuntime` | the sim translator (`initializeSimEventsIracing`), the live race order for the template context, the query-side runtime the Race Engineer reads |
| 3 | `initInput` | `Core` | `Input` | the keyboard and clipboard over `IRacingNative`, the PNG rasterizer behind `__FEATURE_PNG_RASTERIZATION__` |
| 4 | `initAudio` | `Core` | `Audio` | the audio engine rooted at the plugin's assets, the bus-volume and Race Engineer / Radar gate syncers |
| 5 | `initVoicePacks` | `Core`, `Audio` | `VoicePacks` | scanner, storage, catalog, installer, the launch step (constructed, not started), the run-scoped pushes, the settings window's voice-pack commands |
| 6 | `initRaceEngineer` | `Core`, `SimRuntime`, `Audio`, `VoicePacks` | — | the scenario engine, `race-engineer-wiring`'s `wireRaceEngineer` (caches, then `registerPitCrew`), then `setScripts` |
| 7 | `initSettings` | `Core`, `Audio`, `VoicePacks` | `Settings` | the settings and replay stores, the startup notices, the CPU profile capture, the settings window, the global-settings listener with its store-ready block |
| 8 | `registerActions` | `Core`, `Input` | — | window focus and the mouse pointer, the Always-mode focus listeners, then every action: `SHARED_ACTIONS`, then the extension's `extraActions` |
| 9 | `startServices` | `Core`, `Input`, `Settings`, `VoicePacks` | — | `initGlobalSettings`, the launch step's start, the binding migrations, the extension's `start()`, the settings-window request, SimHub, the binding dispatcher, the app monitor, the elevation and replay-session subscribers |
| 10 | `adapter.connect()` | — | — | always last: every handler is registered before the host can deliver an event |

A data dependency is a parameter, so a phase cannot run before what it needs exists: `initGlobalSettings` after the first pack refresh, the launch step after `initGlobalSettings`, the settings window after the store. The voice-pack phase's mutable state lives on the `VoicePacks` object, created before the service that calls back into it, so the old module scope's temporal-dead-zone hazard is gone by construction. An ordering with no data edge stays inside one phase, adjacent, with its comment:

- the bus caches before `registerPitCrew` (the engine's `where:` clauses read them), inside `wireRaceEngineer`
- `setScripts` after `registerPitCrew` — it compiles eagerly against the registered contracts
- the first-run check before the changelog version check (#1061) — the version check writes the `_lastSeenVersion` key the first-run check reads
- in the store-ready block, the startup-policy migration → `applyStartupFeatureGates` → `armFeatureGateSync` (#1007) — arming records the post-write values as already applied, so a startup write never sounds like a user toggle
- the Always-mode focus listeners before the actions, so the listener fires first in the EventEmitter chain
- SimHub before the binding dispatcher, whose `isReady` checks reachability
- the voice-pack launch step started in `startServices`, never inside the store-ready block (#1034 ruling 2) — that block never runs on the fail-closed unreadable-file path, and a plugin that cannot read its settings must still end up with a voice

`packages/plugin-runtime/src/start-plugin.test.ts` records every effectful startup call against a fake adapter and fails naming the first call that moved or ran extra; update its `expectedOrder()` only for an intended change. `scripts/plugin-shell-guard.test.mjs` keeps every `plugin.ts` under 80 lines with no wiring: it may not name `registerPitCrew`, `initializeSimEventsIracing`, `initializeAudioScenarios` a callout registry family (`*_CALLOUTS`) or a pre-#1350 `*_CALLOUT_SETTING_KEYS` map, nor import `@iracedeck/callout-settings` at all (static, type-only or dynamic, whatever it names), may not call `registerAction`, must call `startPlugin`, and only Stream Deck passes an extension.

**Host seams.** Host differences reach the bootstrap through `IDeckPlatformAdapter` or the optional `PluginExtension` — the bootstrap tests for the extension's presence, never for a host name:

- `setLogLevel(level)` — `initCore` applies `debugLogging ? LogLevel.Debug : LogLevel.Info` at start and on every settings change (see `@.claude/rules/logging.md`).
- `logLocation` — the file or per-day directory the host's logger writes. `initCore` hands it to the main-thread watchdog (#1330) as its target and refuses to start without one; the CPU profile capture (#1338) writes into `<log dir>/profiles` beside it (`profilesDirFor`).
- `openUrl(url)` — the changelog version check and the settings window's browser fallback.
- `onOpenSettingsRequest(handler)` — a PI's "Open settings" request; `startServices` refreshes the extension's device list and opens the window.
- `PluginExtension` — what only Stream Deck has, built by `packages/iracing-plugin-stream-deck/src/elgato-extension.ts`: `extraActions` (`STREAM_DECK_ACTIONS`: Switch Profile, #736), `getConnectedDeviceType()` for the changelog URL (#680), `switchProfile` for the settings window's profile buttons (#992), `start()` (the profile switcher and the device connect/disconnect listeners) and `refreshDevices()` (the `_deckDevices` list). Building it has no side effects; `startServices` calls `start()`.

The Mirabox shell, whole but for its header comment (Ulanzi's differs by the adapter; Stream Deck's builds `new ElgatoPlatformAdapter(streamDeck)`, which needs no log directory, and passes `extension: createElgatoExtension(streamDeck, adapter)`):

```typescript
import { VSDPlatformAdapter } from "@iracedeck/deck-adapter-mirabox";
import { startPlugin } from "@iracedeck/plugin-runtime";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `<plugin>/bin`: where this bundle and its build-time config.json live.
const binDir = dirname(fileURLToPath(import.meta.url));

// Tee logs to <plugin>/log/<YYYY.M.D>.log. The Stream Dock host discards plugin
// stdout, so file logging is what makes the debug toggle actually capture a log
// for support on Mirabox (issue #609). binDir is <plugin>/bin, so the log dir
// sits next to it under the plugin root — the same convention the host's own
// plugins use.
const adapter = new VSDPlatformAdapter(undefined, join(binDir, "..", "log"));

startPlugin({ adapter, binDir });
```

**CRITICAL** — what the phases rely on, each now held in one place for all three plugins:
- Both `initGlobalSettings()` and `initAppMonitor()` (`@iracedeck/deck-iracing`) take an `IDeckPlatformAdapter` (not `typeof StreamDeck`)
- `initGlobalSettings()` also takes a required `SettingsStore` (#993). It returns the schema-default cache immediately and loads the file in the background, so nothing may assume settings are present right after the call — gate on `isSettingsStoreReady()` or react in `onGlobalSettingsChange`. The store is created in `initSettings` before the settings-window controller, whose command-handler deps read `settingsStore.path` eagerly, and after `initPluginConfig()` (in `initCore`) — `getPluginPlatform()` throws without it
- `initSettings` registers `process.on("exit", () => settingsStore.flushSync())` right after creating the store (and the same for the replay store) — without it the last ≤250 ms of settings writes are lost when the host stops the plugin
- The settings channel is published through `createSettingsChannelPublisher` (deck-core), never by hand-rolled `updateGlobalSettings({ _settingsChannel })` + `adapter.setGlobalSettings(...)`: it must fire from the controller's `onStarted` hook as well as the store-ready block, and it owns the mirror-skip logging
- All init calls are BEFORE `adapter.connect()` (handlers must register first)
- `initializeEventBus()` comes before any publisher (e.g. `initializeSimEventsIracing`) or subscriber (actions via `getEventBus().subscribe(...)`); both are in `initCore`, ahead of every other phase
- `initializeSDK()` (`@iracedeck/deck-iracing`) also initialises deck-core's sim connection (#1351), so it runs in `initCore` before any action can appear: `BaseAction` and `ConnectionStateAwareAction` subscribe to that connection, and a subscription made before it exists is queued and replayed onto it at initialisation
- `initializeSimEventsIracing()` comes after `initializeSDK()` (requires `getController()`) and after `initializeEventBus()`; it reads `sdkController` ticks on behalf of the bus's subscribers (actions that read the controller directly do so through `SimIRacingAction`), and `initSim` is the one place a sim translator is chosen
- `initializeAudio()` creates the audio service singleton (third argument = the ordered audio roots, an ARRAY since #1034 — a bare string entry is an unrestricted root, and installed voice packs are appended later as `{ dir, clips, voices }` roots limited to the clips the scan admitted; since #1144 each pack root is BOUND by its `voices` map — composite `<pack id>::<voice id>` → the bare voice folder — so a `voice/<pack>::<voice>/…` path resolves only inside that pack's root, and the ordered walk, which still serves the sfx, never reaches a bound root; the optional fourth argument, `{ displayName, iconPath? }`, names our session in the Windows Volume Mixer (#1253) — `initAudio` passes deck-core's `pluginAudioSessionIdentity(binDir)`, which resolves the absolute path of the Elgato plugin's committed `imgs/plugin/iracedeck.ico` (the Mirabox and Ulanzi builds copy it with the rest of that folder), and `getAudio().init()` hands it to the native layer before any engine can exist); `getAudio().init()` starts the miniaudio engine. Both run before actions that use audio (e.g., Pit Engineer)
- `initWindowFocus` / `focusIRacingIfEnabled` / `focusIRacingNow` come from `@iracedeck/deck-core` (moved there in #930; the unconditional variant added in #926). The focuser is injected, exactly like `initializeKeyboard`'s callbacks, so deck-core stays free of a native import; so are its third argument, `isIRacingActive` (#1176), which the service imported from `app-monitor` until that closed the cycle `sdk-singleton` → `window-focus-service` → `app-monitor` → `sdk-singleton`, and its fourth, `hasElevationMismatch` (#1351) — both from `@iracedeck/deck-iracing`, which deck-core may not import; deck-core mirrors the native `FocusResult` codes and `focus-result.test.ts` in the Stream Deck plugin guards that mirror. Since #977 the service also exports `focusIRacingBeforeInput`, the keystroke-side site the keyboard service calls before every native key emit and (via `createSDK`'s `beforeKeystrokes` hook, injected by `deck-iracing`'s `initializeSDK`) the chat command calls before it types — the mode gate lives in the service, so the three hook registrations are identical in every mode.
- `initMousePointer` / `movePointerToSim` (#926) are the sibling pointer service, injected the same way and mirrored the same way (`pointer-move-result.test.ts`). Kept separate from the focus service: one owns the foreground, the other owns where the pointer goes
- `initializeRasterizer()` is gated by `__FEATURE_PNG_RASTERIZATION__` and must come before any code that renders a device image (it can run anywhere before `adapter.connect()`, since `toDeviceImage()` passes images through unchanged until it's called); see `@.claude/rules/platform-feature-flags.md`
- `initializeSimHub()` comes AFTER `initGlobalSettings()` (reads host/port from settings)
- `initializeBindingDispatcher()` comes AFTER `initGlobalSettings()`, `initializeKeyboard()`, and `initializeSimHub()`
- The voice-pack launch step (`createVoicePackLaunchStep`, #1034 stage 3) is constructed in `initVoicePacks` right after the installer and started in `startServices` — it waits for `whenSettingsStoreSettled()` itself and must NOT be moved inside the store-ready block. That block never runs on the fail-closed unreadable-file path, and a plugin that cannot read its settings must still end up with a voice. Its `settled` dep is a THUNK for the same reason `start()` sits after `initGlobalSettings`: that call re-arms the signal, so a promise taken at construction would be the discarded pre-init one. Two more deps are the bootstrap's: `isPackUsable` (the scanner's last result listing the pack with a voice — what is on disk, as against the record's digest — off which the step force-reinstalls a managed pack whose clips are gone), `onSettingsChange` (`onGlobalSettingsChange` — the step watches the Race Engineer gate itself and re-runs the ensure on the false→true edge, subscribed only once it is past the settle wait so a loaded file's first arrival is never mistaken for a flip; the bootstrap keeps no listener of its own). The voice-pack service no longer takes a `priorityPacks` order: since #1144 a voice is `<pack id>::<voice id>`, so the managed pack's voice and a sideload's voice of the same bare id are two voices and nothing has to claim first. The bootstrap pokes the launch step from one place only, the settings window's Rescan command; a poke before the step is ready is latched, and the first ensure then bypasses the catalog TTLs for it. A failure a retry cannot fix is given up for that catalog answer and re-observed hourly, never abandoned for the process
- Actions are imported from `@iracedeck/iracing-actions` by `plugin-runtime/src/actions.ts` alone and registered by `registerActions` via `adapter.registerAction(uuid, create(adapter.createLogger(scope)))`; a new action goes in `SHARED_ACTIONS` (or the extension's `extraActions`) and every manifest, and `src/actions.test.ts` fails until they match
- Logger is injected into each action via constructor: the registration's `create(logger)` receives `adapter.createLogger(scope)`
- `initAppMonitor` requires `initializeSDK()` to be called first
