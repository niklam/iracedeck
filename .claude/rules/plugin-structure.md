---
# Stream Deck Plugin Structure

## Production Plugins
- `stream-deck-plugin-pit` (com.iracedeck.sd.pit) - Pit service actions
- `stream-deck-plugin-comms` (com.iracedeck.sd.comms) - Communication actions
- `stream-deck-plugin-core` (com.iracedeck.sd.core) - Core driving/interface actions

## Legacy
- `stream-deck-plugin` (com.iracedeck.sd) - Legacy plugin, will be transitioned away from. Do not add new actions here.

## Test/Reference Only
- `stream-deck-plugin-hotkeys` (com.iracedeck.sd.hotkeys) - Test plugin for keyboard functionality. Not for production actions. Reference `do-iracing-hotkey.ts` for keyboard sending patterns only.

## Creating New Plugins

Use `stream-deck-plugin-core` as the reference implementation for plugin structure, action patterns, icon templates, PI templates, and tests. Create the following structure:

```
packages/stream-deck-plugin-{name}/
├── package.json                           # @iracedeck/stream-deck-plugin-{name}
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
    ├── imgs/
    │   ├── plugin/                        # category-icon.png, marketplace.png (@1x and @2x)
    │   └── actions/{action-name}/         # icon.svg, key.svg for each action
    └── ui/
        ├── settings.html                  # Global settings (disableWhenDisconnected)
        ├── sdpi-components.js             # REQUIRED: Copy from existing plugin
        ├── pi-components.js               # REQUIRED: Copy from existing plugin (for ird-key-binding)
        └── {action-name}.html             # Action-specific Property Inspector
```

### Key identifiers to update when creating a new plugin:
| Item | Format |
|------|--------|
| Package name | `@iracedeck/stream-deck-plugin-{name}` |
| Plugin UUID | `com.iracedeck.sd.{name}` |
| sdPlugin folder | `com.iracedeck.sd.{name}.sdPlugin` |
| Action UUIDs | `com.iracedeck.sd.{name}.{action-name}` |

### After creating the plugin:
1. Copy `sdpi-components.js` and `pi-components.js` from an existing plugin's `ui/` folder to your new plugin's `ui/` folder
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

### Native Module Dependencies (keysender)

**CRITICAL**: If your plugin uses keyboard functionality (`getKeyboard()`, `initializeKeyboard()`), you MUST:

1. **Mark native modules as external** - Native CommonJS modules like `keysender` cannot be bundled into ES modules. Add them to the `external` array:
```javascript
external: ["@iracedeck/iracing-native", "@iracedeck/stream-deck-shared", "yaml", "keysender"],
```

2. **Include them as runtime dependencies** - Add to the emitted `package.json` in the `generateBundle` hook:
```javascript
const pkg = {
  type: "module",
  dependencies: {
    "@iracedeck/iracing-native": "file:../../../iracing-native",
    "@iracedeck/stream-deck-shared": "file:../../../stream-deck-shared",
    "keysender": "^2.3.1",
    yaml: "^2.8.2",
  }
};
```

**Why this matters**: Bundling `keysender` (a native CommonJS module) into an ES module output causes runtime errors like "require is not defined". The module must be loaded at runtime from `node_modules`.

Reference `stream-deck-plugin-core/rollup.config.mjs` for the correct configuration.

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

The initialization order in `plugin.ts` is critical:

```typescript
import streamDeck from "@elgato/streamdeck";
import { initializeSDK, initializeKeyboard, initGlobalSettings, initAppMonitor } from "@iracedeck/stream-deck-shared";

// 1. Enable logging
streamDeck.logger.setLevel("trace");

// 2. Initialize SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// 3. Initialize keyboard (if using keyboard shortcuts)
initializeKeyboard(createSDLogger(streamDeck.logger.createScope("Keyboard")));

// 4. Register actions
streamDeck.actions.registerAction(new MyAction());

// 5. Initialize global settings BEFORE connect() - pass SDK instance!
initGlobalSettings(streamDeck);

// 6. Initialize app monitor BEFORE connect() - pass SDK instance!
initAppMonitor(streamDeck);

// 7. Connect LAST
streamDeck.connect();
```

**CRITICAL**: Both `initGlobalSettings(streamDeck)` and `initAppMonitor(streamDeck)` MUST:
- Be called BEFORE `streamDeck.connect()` (handlers must register first)
- Receive the SDK instance as parameter (bundling creates separate instances otherwise)
- `initAppMonitor` requires `initializeSDK()` to be called first
