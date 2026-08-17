---
# Stream Deck Plugin Structure

## Architecture

The plugin system uses a platform abstraction architecture with these key packages:

- `@iracedeck/deck-core` — Platform-agnostic base classes, types (`IDeckWillAppearEvent`, etc.), and shared utilities
- `@iracedeck/deck-adapter-elgato` — Elgato Stream Deck adapter implementing `IDeckPlatformAdapter`
- `@iracedeck/deck-adapter-mirabox` — Mirabox adapter implementing `IDeckPlatformAdapter` via WebSocket
- `@iracedeck/deck-adapter-ulanzi` — Ulanzi Deck adapter implementing `IDeckPlatformAdapter` via WebSocket (normalizes UlanziStudio `cmd` frames into Elgato-style events)
- `@iracedeck/iracing-actions` — All action implementations (import from `@iracedeck/deck-core`, not platform-specific SDKs)

Actions do NOT import from `@elgato/streamdeck` or any platform SDK. They import from `@iracedeck/deck-core` and are registered via the platform adapter in each plugin.

### Ulanzi naming + PI bridge (issue #508)

The Ulanzi plugin diverges from the Elgato/Mirabox naming conventions below:

- Plugin folder: `com.ulanzi.iracedeck.ulanziPlugin` (installed into `…/UlanziDeck/Plugins/`; the `*.ulanziPlugin` suffix is what UlanziStudio scans for, and the `com.ulanzi.<name>.ulanziPlugin` form matches the installed first-party plugins). The folder name and the manifest UUID are independent.
- Manifest `UUID`: `com.iracedeck.sd.core` (== `PLUGIN_UUID` in `@iracedeck/deck-adapter-ulanzi` — the same UUID the Elgato/Mirabox plugins use). UlanziStudio only requires a 4-segment main-service UUID and does **not** validate the prefix, so iRaceDeck keeps its own namespace.
- Action UUIDs: `com.iracedeck.sd.core.<action>` — the canonical iRaceDeck UUIDs, declared verbatim in the manifest. No remapping: the plugin registers actions directly, exactly like Mirabox.
- Manifest is the Ulanzi format (`Type:"JavaScript"`, per-action `Controllers:["Keypad"|"Encoder"]`, `Encoder:{layout:"$UA1"}` for dials, `States:[{Image}]`). `"Information"` controllers are dropped (no Ulanzi equivalent).
- PI connection: UlanziStudio does not call `connectElgatoStreamDeckSocket`, so the rollup injects `ulanzi-pi-bridge.js` (from `@iracedeck/pi-components`, built from `src/ulanzi-bridge/`) before `sdpi-components.js` into every generated PI HTML except `settings-window.html`, which gets the settings-window bridge instead (#992; `injectBridgeScriptPlugin` from `@iracedeck/pi-components/build`, shared by all three plugins). The bridge monkeypatches `window.WebSocket` and translates Elgato ↔ Ulanzi PI frames, so the shared sdpi-components/`ird-*` stack is reused unchanged. See `packages/iracing-plugin-ulanzi/CLAUDE.md`.

## Active Plugins
- `iracing-plugin-stream-deck` (com.iracedeck.sd.core) — Elgato Stream Deck, uses `@iracedeck/deck-adapter-elgato`
- `iracing-plugin-mirabox` (com.iracedeck.sd.core) — Mirabox, uses `@iracedeck/deck-adapter-mirabox`
- `iracing-plugin-ulanzi` (com.iracedeck.sd.core) — Ulanzi Deck, uses `@iracedeck/deck-adapter-ulanzi`

Both plugins register the same actions from `@iracedeck/iracing-actions`. When adding or modifying actions, changes must be applied to **all** plugin packages (registration in `plugin.ts`, manifest entries, PI templates where applicable).

## Creating New Plugins

Use `iracing-plugin-stream-deck` as the reference implementation for Elgato plugins, and `iracing-plugin-mirabox` for Mirabox/VSD plugins. Create the following structure:

```text
packages/iracing-plugin-stream-deck-{name}/
├── package.json                           # @iracedeck/iracing-plugin-stream-deck-{name}
├── tsconfig.json                          # Extends ../../tsconfig.base.json
├── rollup.config.mjs                      # Update sdPlugin variable only
├── .gitignore                             # node_modules/, *.sdPlugin/bin, *.sdPlugin/logs
├── .vscode/
│   ├── launch.json                        # Debugger attach config
│   └── settings.json                      # JSON schema for manifest
├── src/
│   ├── plugin.ts                          # Entry point
│   ├── svg.d.ts                           # SVG type declarations
│   └── actions/                           # Action implementations
├── icons/                                 # SVG icon templates
└── com.iracedeck.sd.{name}.sdPlugin/
    ├── manifest.json                      # Plugin metadata
    ├── LICENSE                            # Copied at build time from the repo root (#905)
    ├── THIRD-PARTY-LICENSES.md            # Copied at build time from the repo root (#905)
    ├── imgs/
    │   ├── plugin/                        # category-icon.png, marketplace.png (@1x and @2x)
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
1. Add `"@iracedeck/pi-components": "workspace:*"` and `"@iracedeck/iracing-actions": "workspace:*"` to the plugin's `package.json` dependencies. Wire the rollup config to `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, and compute `actionTemplatesDir` locally from the `@iracedeck/iracing-actions` path (see `.claude/rules/pi-templates.md`). The `sdpi-components.js`/`pi-components.js` files are copied automatically by the plugin's rollup build — no manual copy. Per-action `icon.svg`/`key.svg` are copied from each action folder into `{sdPlugin}/imgs/actions/<name>/` by a dedicated rollup plugin step.
2. Run `pnpm install` in the package directory
3. Run `pnpm build` to verify build succeeds
4. Run `streamdeck link com.iracedeck.sd.{name}.sdPlugin` to register with Stream Deck
5. Restart Stream Deck to see the new plugin category

### Rollup Configuration

If the build fails with "Invalid value for option output.file - when building multiple chunks", add `inlineDynamicImports: true` to the output config in `rollup.config.mjs`:

```javascript
output: {
  file: `${sdPlugin}/bin/plugin.js`,
  sourcemap: isWatching,
  inlineDynamicImports: true  // Add this line
},
```

### Native Module Dependencies (keysender, @resvg/resvg-js)

**CRITICAL**: If your plugin uses keyboard functionality (`getKeyboard()`, `initializeKeyboard()`) or PNG rasterization (`initializeRasterizer()`, `@iracedeck/rasterizer`), you MUST:

1. **Mark native modules as external** - Native CommonJS/N-API modules like `keysender` and `@resvg/resvg-js` cannot be bundled into ES modules. Add them to the `external` array:
```javascript
external: ["@iracedeck/iracing-native", "@resvg/resvg-js", "yaml", "keysender"],
```

2. **Include them as runtime dependencies** - Add to the emitted `package.json` in the `generateBundle` hook:
```javascript
const pkg = {
  type: "module",
  dependencies: {
    "@iracedeck/iracing-native": "file:../../../iracing-native",
    "@resvg/resvg-js": "2.6.2",
    "keysender": "2.4.0",
    yaml: "2.8.2",
  }
};
```

**Why this matters**: Bundling `keysender` or `@resvg/resvg-js` (native modules) into an ES module output causes runtime errors like "require is not defined". They must be loaded at runtime from `node_modules`. Unlike `keysender`, `@resvg/resvg-js` ships prebuilt binaries for macOS and Linux too, so it needs no mock and no `optionalDependencies` split — it's a plain `dependencies` entry on every platform.

3. **Use `optionalDependencies` for keysender only** - In the emitted `package.json`, place `keysender` under `optionalDependencies` so it installs on Windows but silently fails on macOS/Linux:
```javascript
const pkg = {
  type: "module",
  dependencies: { /* ... */ },
  optionalDependencies: {
    "keysender": "2.4.0",
  }
};
```

4. **Bundle the rasterizer's fonts** - `@iracedeck/rasterizer` ships bundled Arimo font files (`packages/rasterizer/fonts/`) that must be copied into `{sdPlugin}/assets/fonts/` at build time (a dedicated `generateBundle` copy step, same pattern as the per-action icon copy) so `createSvgRasterizer({ fontsDir })` can find them at runtime.

Reference `iracing-plugin-stream-deck/rollup.config.mjs` for the correct configuration.

### License and Third-Party Notices

Every plugin artifact must ship the project `LICENSE` and the aggregated `THIRD-PARTY-LICENSES.md` at the sdPlugin root (issue #905): LICENSE §3/§5/§7 require the license text in every distributed copy, and several shipped components carry notice obligations of their own (the iRacing SDK's BSD-3-Clause notice, the MPL-2.0 source pointer for `@resvg/resvg-js`, the Lovely Sim Racing corner-data attribution). Both files are copied from the repo root by the `copy-license-files` `generateBundle` step in each plugin's `rollup.config.mjs` (same pattern as the rasterizer-fonts copy), and the copies are gitignored in each plugin package — new plugins must add both the copy step and the `.gitignore` entries.

When a shipped third-party dependency or vendored component is added or removed, update the repo-root `THIRD-PARTY-LICENSES.md` in the same change. `scripts/third-party-licenses.test.mjs` guards the wiring: every non-workspace rollup `external` must have an entry in the file, every plugin config must contain the copy step, and no `.sdignore` pattern may exclude the two files from the packed plugin.

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

### Plugin Initialization Order (plugin.ts)

The initialization order in `plugin.ts` is critical. The plugin uses `ElgatoPlatformAdapter` to bridge the Elgato SDK to the platform-agnostic `IDeckPlatformAdapter` interface:

```typescript
import streamDeck from "@elgato/streamdeck";
import { AudioNative } from "@iracedeck/audio-native";
import { getAudio, initializeAudio } from "@iracedeck/audio-service";
import { MY_ACTION_UUID, MyAction } from "@iracedeck/iracing-actions";
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import {
  focusIRacingIfEnabled,
  getController,
  initAppMonitor,
  initGlobalSettings,
  initializeBindingDispatcher,
  initializeKeyboard,
  initializeRasterizer,
  initializeSDK,
  initializeSimHub,
  initMousePointer,
  initWindowFocus,
} from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import { IRacingNative } from "@iracedeck/iracing-native";
import { createSvgRasterizer } from "@iracedeck/rasterizer";
import { initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";

// 1. Create the Elgato platform adapter
const adapter = new ElgatoPlatformAdapter(streamDeck);

// 2. Enable logging — production defaults to info; the `debugLogging` global
//    setting opts into verbose debug at runtime (see @.claude/rules/logging.md)
streamDeck.logger.setLevel("info");

// 3. Initialize SDK singleton (must come before sim-events-iracing)
initializeSDK(adapter.createLogger("iRacingSDK"));

// 4. Initialize event bus (must come before any publisher or subscriber)
const eventBus = initializeEventBus(adapter.createLogger("EventBus"));

// 5. Wire the iRacing translator: sdkController ticks → semantic events on the bus.
//    The only package that imports `@iracedeck/iracing-sdk` for telemetry consumption.
initializeSimEventsIracing(eventBus, getController(), adapter.createLogger("SimEventsIracing"));

// 6. Initialize keyboard (if using keyboard shortcuts)
const native = new IRacingNative();
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),      // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),    // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),      // release only (key release)
  (chords, holdMs) => native.sendScanKeySequence(chords, holdMs), // atomic multi-chord sequence (#818)
);

// 7. Rasterize device-bound SVG icons to PNG in-plugin (#642), gated by the
//    `pngRasterization` platform flag (temporary kill-switch — see
//    @.claude/rules/platform-feature-flags.md). When the flag is off,
//    initializeRasterizer() is never called, deck-core's rasterizer service
//    stays uninitialized, and every adapter falls back to sending SVG as before.
if (__FEATURE_PNG_RASTERIZATION__) {
  initializeRasterizer(
    createSvgRasterizer({ fontsDir: join(__binDir, "..", "assets", "fonts") }),
    adapter.createLogger("Rasterizer"),
  );
}

// 8. Initialize audio engine for pit engineer voice playback.
//    Third arg = base path of the bundled audio assets (the plugin's assets/audio dir).
const audioNative = new AudioNative();
initializeAudio(adapter.createLogger("Audio"), audioNative, join(__binDir, "..", "assets", "audio"));
getAudio().init();

// 9. Initialize the window service: focus + mouse-pointer placement (#926)
initWindowFocus(adapter.createLogger("WindowFocus"), () => native.focusIRacingWindow());

// 9b. Mouse pointer placement for the Mouse to Sim mode (#926)
initMousePointer(adapter.createLogger("MousePointer"), (x, y) => native.moveMouseToIRacingWindow(x, y));

// 10. Register focus-before-action listeners (BEFORE registering actions)
adapter.onKeyDown(() => focusIRacingIfEnabled());
adapter.onDialDown(() => focusIRacingIfEnabled());
adapter.onDialRotate(() => focusIRacingIfEnabled());

// 11. Register actions via the adapter (logger injected via constructor)
adapter.registerAction(MY_ACTION_UUID, new MyAction(adapter.createLogger("MyAction")));

// 12. Initialize global settings BEFORE connect() - pass adapter!
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"));

// 13. Initialize SimHub service AFTER global settings (reads host/port from settings)
initializeSimHub(adapter.createLogger("SimHub"));

// 14. Initialize binding dispatcher AFTER global settings, keyboard, and SimHub
initializeBindingDispatcher(adapter.createLogger("BindingDispatcher"));

// 15. Initialize app monitor BEFORE connect() - pass adapter!
initAppMonitor(adapter, adapter.createLogger("AppMonitor"));

// 16. Connect LAST
adapter.connect();
```

**CRITICAL**:
- Both `initGlobalSettings()` and `initAppMonitor()` take an `IDeckPlatformAdapter` (not `typeof StreamDeck`)
- All init calls must be BEFORE `adapter.connect()` (handlers must register first)
- `initializeEventBus()` must come before any publisher (e.g. `initializeSimEventsIracing`) or subscriber (actions via `getEventBus().subscribe(...)`)
- `initializeSimEventsIracing()` must come after `initializeSDK()` (requires `getController()`) and after `initializeEventBus()`; it's the only package that reads `sdkController` ticks on behalf of action consumers
- `initializeAudio()` creates the audio service singleton (third argument = audio-assets base path); `getAudio().init()` starts the miniaudio engine. Both must be called before actions that use audio (e.g., Pit Engineer)
- `initWindowFocus` / `focusIRacingIfEnabled` / `focusIRacingNow` come from `@iracedeck/deck-core` (moved there in #930; the unconditional variant added in #926). The focuser is injected, exactly like `initializeKeyboard`'s callbacks, so deck-core stays free of a native import; deck-core mirrors the native `FocusResult` codes and `focus-result.test.ts` in the Stream Deck plugin guards that mirror
- `initMousePointer` / `movePointerToSim` (#926) are the sibling pointer service, injected the same way and mirrored the same way (`pointer-move-result.test.ts`). Kept separate from the focus service: one owns the foreground, the other owns where the pointer goes
- `initializeRasterizer()` is gated by `__FEATURE_PNG_RASTERIZATION__` and must come before any code that renders a device image (it can run anywhere before `adapter.connect()`, since `toDeviceImage()` passes images through unchanged until it's called); see `@.claude/rules/platform-feature-flags.md`
- `initializeSimHub()` must come AFTER `initGlobalSettings()` (reads host/port from settings)
- `initializeBindingDispatcher()` must come AFTER `initGlobalSettings()`, `initializeKeyboard()`, and `initializeSimHub()`
- Actions are imported from `@iracedeck/iracing-actions` and registered via `adapter.registerAction(UUID, handler)`
- Logger is injected into each action via constructor: `new MyAction(adapter.createLogger("MyAction"))`
- `initAppMonitor` requires `initializeSDK()` to be called first
