# @iracedeck/deck-core

Platform-agnostic core interfaces, base classes, and utilities for deck device plugins. This package contains no platform-specific code — it defines the abstraction layer that platform adapters implement.

## Package Contents

### Platform Abstraction (`types.ts`)

- `IDeckActionContext` — Handle to a single action instance (wraps `setImage`, `setTitle`, `isKey`, `id`; optional `showAlert?()` flashes the host's warning indicator where supported — Elgato keys only)
- `IDeckEvent<T>` and variants (`IDeckKeyDownEvent`, `IDeckWillAppearEvent`, etc.) — Platform-neutral events
- `IDeckActionHandler<T>` — Interface for action lifecycle handlers
- `IDeckPlatformAdapter` — Interface that platform adapters implement (Elgato, VSDinside, etc.)

### Base Classes

- `BaseAction<T>` — Abstract base with SVG image management, flag overlay, inactive state tracking. Accepts logger via constructor. Implements `IDeckActionHandler<T>`.
- `ConnectionStateAwareAction<T>` — Extends `BaseAction` with automatic iRacing connection tracking via `sdkController`.

### Icon Assembly (re-exported from `@iracedeck/icon-composer`)

Pure icon assembly functions (assembleIcon, extractGraphicContent, generateTitleText, resolveTitleSettings, resolveBorderSettings, resolveGraphicSettings, resolveIconColors, etc.) have been moved to the standalone `@iracedeck/icon-composer` package (zero dependencies). They are re-exported from `deck-core` for backward compatibility — existing imports from `@iracedeck/deck-core` continue to work.

deck-core adds global settings readers on top of the pure functions:
- `getGlobalTitleSettings()` — reads title defaults from global settings store
- `getGlobalBorderSettings()` — reads border defaults from global settings store
- `getGlobalGraphicSettings()` — reads graphic scale default from global settings store

### Shared Utilities

- `common-settings.ts` — `CommonSettings` Zod schema (flagsOverlay, colorOverrides, titleOverrides, borderOverrides, graphicOverrides)
- `global-settings.ts` — Plugin-level global settings manager (takes `IDeckPlatformAdapter`)
- `app-monitor.ts` — iRacing process detection (takes `IDeckPlatformAdapter`)
- `sdk-singleton.ts` — iRacing SDK singleton (`initializeSDK`, `getController`, `getCommands`)
- `keyboard-service.ts` — Keyboard singleton (`initializeKeyboard`, `getKeyboard`)
- `icon-template.ts` — SVG template rendering and color resolution (delegates to `@iracedeck/icon-composer`)
- `overlay-utils.ts` — SVG overlay utilities (inactive state, data URI conversion)
- `key-binding-utils.ts` — Key binding parsing and formatting
- `keyboard-types.ts` — Keyboard type definitions
- `scan-code-map.ts` — PS/2 scan code mapping
- `iracing-hotkeys.ts` — iRacing hotkey presets
- `unit-conversion.ts` — Fuel unit conversion utilities
- `version-check.ts` — Startup version-upgrade detection + changelog opener (`shouldOpenChangelog`, `resolveChangelogDecision`, `buildChangelogUrl`, `runVersionCheck`), gated by the `changelogNotification` policy (always/features/monthly/never, issue #742); see `.claude/rules/global-settings.md`
- `device-profiles.ts` — Stream Deck device + profile reference (issues #736, #753): the `DeviceType` enum, `DEVICE_SPECS` (keys/grid/dials/touch), `DEVICE_SUPPORT` (iRaceDeck control + profile-template policy), `PROFILE_NAMES` / `PROFILE_TARGET_DEVICES` / `PROFILE_NAV_ACTIONS`, lookup helpers, and the device-suffixed profile-name scheme (`PROFILE_DEVICE_SUFFIXES`, `profileDeviceSuffix`, `deviceProfileName`, `profileDisplayName`, `resolveProfileNameForDevice`). Canonical device-data source — pairs with `.claude/rules/profiles-and-devices.md` (Elgato-only)

## Build

```bash
pnpm build  # tsc → dist/
```

Pure TypeScript library, no Rollup needed. Outputs ESM with declarations.

## Dependencies

- `@iracedeck/icon-composer` — Pure icon assembly functions (zero-dependency)
- `@iracedeck/iracing-sdk` — For telemetry types and SDK controller
- `@iracedeck/logger` — For `ILogger` interface
- `zod` — For settings schemas

Note: `keyboard-service.ts` dynamically imports `keysender` at runtime (Windows-only native module). The types are defined locally to avoid a compile-time dependency.
