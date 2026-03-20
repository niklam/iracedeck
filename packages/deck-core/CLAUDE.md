# @iracedeck/deck-core

Platform-agnostic core interfaces, base classes, and utilities for deck device plugins. This package contains no platform-specific code — it defines the abstraction layer that platform adapters implement.

## Package Contents

### Platform Abstraction (`types.ts`)

- `IDeckActionContext` — Handle to a single action instance (wraps `setImage`, `setTitle`, `isKey`, `id`)
- `IDeckEvent<T>` and variants (`IDeckKeyDownEvent`, `IDeckWillAppearEvent`, etc.) — Platform-neutral events
- `IDeckActionHandler<T>` — Interface for action lifecycle handlers
- `IDeckPlatformAdapter` — Interface that platform adapters implement (Elgato, VSDinside, etc.)

### Base Classes

- `BaseAction<T>` — Abstract base with SVG image management, flag overlay, inactive state tracking. Accepts logger via constructor. Implements `IDeckActionHandler<T>`.
- `ConnectionStateAwareAction<T>` — Extends `BaseAction` with automatic iRacing connection tracking via `sdkController`.

### Shared Utilities (moved from stream-deck-plugin)

- `common-settings.ts` — `CommonSettings` Zod schema (flagsOverlay, colorOverrides)
- `global-settings.ts` — Plugin-level global settings manager (takes `IDeckPlatformAdapter`)
- `app-monitor.ts` — iRacing process detection (takes `IDeckPlatformAdapter`)
- `sdk-singleton.ts` — iRacing SDK singleton (`initializeSDK`, `getController`, `getCommands`)
- `keyboard-service.ts` — Keyboard singleton (`initializeKeyboard`, `getKeyboard`)
- `window-focus.ts` — Window focus service (`initWindowFocus`, `focusIRacingIfEnabled`)
- `icon-template.ts` — SVG template rendering and color resolution
- `overlay-utils.ts` — SVG overlay utilities (inactive state, data URI conversion)
- `key-binding-utils.ts` — Key binding parsing and formatting
- `keyboard-types.ts` — Keyboard type definitions
- `scan-code-map.ts` — PS/2 scan code mapping
- `iracing-hotkeys.ts` — iRacing hotkey presets
- `unit-conversion.ts` — Fuel unit conversion utilities

## Build

```bash
pnpm build  # tsc → dist/
```

Pure TypeScript library, no Rollup needed. Outputs ESM with declarations.

## Dependencies

- `@iracedeck/iracing-sdk` — For telemetry types and SDK controller
- `@iracedeck/iracing-native` — For `FocusResult` enum (window focus)
- `@iracedeck/logger` — For `ILogger` interface
- `zod` — For settings schemas
- `keysender` — devDependency for types only (keyboard service)
