# @iracedeck/deck-core

Platform-agnostic core interfaces, base classes, and utilities for deck device plugins. This package contains no platform-specific code — it defines the abstraction layer that platform adapters implement.

## Package Contents

### Platform Abstraction (`types.ts`)

- `IDeckActionContext` — Handle to a single action instance. Wraps `id`, optional `deviceId?`/`deviceType?` (populated by adapters that expose them — Elgato; used for profile switching, #736), `setImage`, `setTitle`, `setSettings`, `isKey`, optional `showAlert?()` (flashes the host's warning indicator where supported — Elgato keys only), and (for Stream Deck+ dials) `isDial()`, `setFeedback(feedback)`, `setFeedbackLayout(layout)`, `setTriggerDescription(descriptions)` (takes a `DeckTriggerDescription`). `setFeedback`/`setFeedbackLayout`/`setTriggerDescription` no-op on platforms/controllers without a plugin-drawable touch strip (e.g. Mirabox).
- `IDeckEvent<T>` and variants (`IDeckKeyDownEvent`, `IDeckWillAppearEvent`, etc.) — Platform-neutral events. Dial/touch variants: `IDeckDialRotateEvent` (carries signed `ticks` and `pressed: boolean` — whether the dial button was held during rotation, the basis of push+turn), `IDeckDialDownEvent`, `IDeckDialUpEvent`, and `IDeckTouchTapEvent` (carries `tapPos: [x, y]` and `hold: boolean`).
- `IDeckActionHandler<T>` — Interface for action lifecycle handlers (includes `onDialRotate`/`onDialDown`/`onDialUp`/`onTouchTap`).
- `IDeckPlatformAdapter` — Interface that platform adapters implement (Elgato, VSDinside, etc.)

### Encoder Touch-Strip Feedback (`feedback-types.ts`)

- `DeckFeedbackPayload` — Platform-neutral Stream Deck+ touch-strip feedback payload passed to `IDeckActionContext.setFeedback`, keyed by layout item `key`; values are primitive shorthands or partial item overrides (`DeckFeedbackBarItem` / `DeckFeedbackTextItem` / `DeckFeedbackPixmapItem`). Details + platform caveats in `.claude/rules/encoders-and-touchscreen.md`.

### Base Classes

- `BaseAction<T>` — Abstract base with SVG image management, flag overlay, inactive state tracking, and the title-template live watcher (#899): contexts whose user-entered `titleOverrides.titleText` contains `{{` share one telemetry subscription that re-resolves the template per tick, string-compares, and re-runs the context's regenerate callback through a 10 Hz `IconUpdateThrottle` — so any action that registers `setRegenerateCallback` gets live templated titles for free. Accepts logger via constructor. Implements `IDeckActionHandler<T>`.
- `ConnectionStateAwareAction<T>` — Extends `BaseAction` with automatic iRacing connection tracking via `sdkController`. Also home of the binding-dispatch delegates: `setActiveBinding`, `tapBinding`, `tapBindingSequence` (atomic multi-chord sequence, #818), `holdBinding`, `releaseBinding`, and `isBindingMissing` (per-context missing-binding check — prefer it over the shared `isActiveBindingMissing()`).

### Icon Assembly (re-exported from `@iracedeck/icon-composer`)

Pure icon assembly functions (assembleIcon, extractGraphicContent, generateTitleText, resolveBorderSettings, resolveGraphicSettings, resolveIconColors, etc.) have been moved to the standalone `@iracedeck/icon-composer` package (zero dependencies). They are re-exported from `deck-core` for backward compatibility — existing imports from `@iracedeck/deck-core` continue to work.

**Exception:** `resolveTitleSettings` is no longer a pure re-export (#899) — deck-core's `title-settings.ts` wraps icon-composer's pure function and template-resolves the user-entered `titleOverrides.titleText` against the live SDK template context (`title-template.ts`). Always import it from `@iracedeck/deck-core`, never from `@iracedeck/icon-composer` directly, or titles lose template support.

deck-core adds global settings readers on top of the pure functions:
- `getGlobalTitleSettings()` — reads title defaults from global settings store
- `getGlobalBorderSettings()` — reads border defaults from global settings store
- `getGlobalGraphicSettings()` — reads graphic scale default from global settings store

### Shared Utilities

- `common-settings.ts` — `CommonSettings` Zod schema (flagsOverlay, colorOverrides, titleOverrides, borderOverrides, graphicOverrides)
- `migrate-legacy-action.ts` — `migrateLegacyActionToMode` settings-migration helper
- `global-settings.ts` — Plugin-level global settings manager (takes `IDeckPlatformAdapter`)
- `app-monitor.ts` — iRacing process detection (takes `IDeckPlatformAdapter`); also `isIRacingActive()` (running-flag OR live SDK connection) and the `onIRacingTerminated(listener)` subscription, whose listeners run after the running flag and SDK connection are already down (#870). Exit detection is dual-path: the host terminate event, plus an SDK-disconnect fallback (`IRACING_EXIT_SDK_CONFIRM_MS`, 5 s sustained loss) for hosts that never deliver app-monitoring events — deduped per exit episode, blip-safe when a launch event affirmed the sim is running. Adapters that never deliver launch/terminate events declare `supportsApplicationMonitoring = false` on `IDeckPlatformAdapter` (Ulanzi); the app monitor then keeps SDK reconnect polling enabled at startup instead of pausing it until a launch event that would never come
- `sdk-singleton.ts` — iRacing SDK singleton (`initializeSDK`, `getController`, `getCommands`)
- `keyboard-service.ts` — Keyboard singleton (`initializeKeyboard`, `getKeyboard`)
- `clipboard-service.ts` — Clipboard singleton with injected writer (`initializeClipboard`, `getClipboard`); mirrors the keyboard-service DI pattern
- `simhub-service.ts` — SimHub Control Mapper singleton (`initializeSimHub`, `getSimHub`) plus the reachability API (`isSimHubReachable`, `onSimHubReachabilityChange`)
- `icon-template.ts` — SVG template rendering and color resolution (delegates to `@iracedeck/icon-composer`)
- `title-template.ts` — User-entered title template resolution (#899): `titleHasTemplate` (the cheap `{{` gate) and `resolveTitleTemplate` (resolves via `getCurrentTemplateContext()` + `resolveTemplate`; empty-context fallback when disconnected/uninitialized, so variables render empty and expression parse errors stay verbatim)
- `icon-update-throttle.ts` — `IconUpdateThrottle`, the per-context 10 Hz throttle + trailing-edge coalescer for telemetry-driven `setKeyImage` bursts (#493; moved here from `iracing-actions/src/shared/` in #899 so the `BaseAction` title watcher can use it)
- `overlay-utils.ts` — SVG overlay utilities (inactive state, data URI conversion)
- `key-binding-utils.ts` — Key binding parsing and formatting
- `comm-descriptor.ts` — The #612 per-mode `CommDescriptor` types + `keybind` / `keybindBy` / `keybindKeys` / `keybindFixed` helpers, consumed by iracing-actions' `comms-catalog.ts`
- `dial-gesture.ts` — Shared dial-gesture convention: `classifyDialRelease` (release-time press classifier, `DIAL_LONG_PRESS_THRESHOLD_MS`) plus `resolvePairedAction` / `DirectionalPair` (Push+Turn pair dispatch); see `.claude/rules/encoders-and-touchscreen.md`
- `keyboard-types.ts` — Keyboard type definitions
- `scan-code-map.ts` — PS/2 scan code mapping
- `iracing-hotkeys.ts` — iRacing hotkey presets
- `unit-conversion.ts` — Fuel unit conversion utilities
- `fuel-telemetry.ts` — Shared `isFuelFillOn` / `isAutofuelActive` / `isAutofuelEnabled` telemetry readers used by both Fuel Service surfaces (keypad + dial)
- `setup-warning.ts` + `setup-warning-constants.ts` — Setup-name mismatch warning (#625): `evaluateSetupWarning`, pattern helpers (`compileSetupWarningPattern`, `setupNameMatchesPattern`, `validateSetupWarningPatterns`), and the warning-id/setting-key constants (kept in a dependency-free leaf module)
- `elevation-warning.ts` + `elevation-check.ts` — Administrator/integrity mismatch detection (#610, #902): the pure `evaluateElevationWarning` (structurally typed, no native dependency) plus `createElevationCheckSubscriber`, the shared once-per-connection `sdkController` subscriber every plugin wires with its injected `getElevationStatus()` — logs warn on a mismatch, info on a pass (so support logs capture the outcome at the default level), status detail at debug, and posts/clears the PI banner
- `version-check.ts` — Startup version-upgrade detection + changelog opener (`shouldOpenChangelog`, `resolveChangelogDecision`, `buildChangelogUrl`, `runVersionCheck`, `VERSION_CHECK_STARTUP_GRACE_MS`; #680, #742, #870 — never opens while iRacing is running: a due open defers via the `isSimRunning` delegate and re-runs on `onIRacingTerminated`); full behavior in `.claude/rules/global-settings.md`
- `device-profiles.ts` — Canonical Stream Deck device + profile reference (#736, #753, #790): `DeviceType`, `DEVICE_SPECS`, `DEVICE_SUPPORT`, `PROFILE_NAMES` / `PROFILE_TARGET_DEVICES` / `PROFILE_NAV_ACTIONS`, `CAR_SELECTOR_PROFILE`, `shipsBundledProfiles`, lookup helpers, and the device-suffixed profile-name helpers (`PROFILE_DEVICE_SUFFIXES`, `profileDeviceSuffix`, `deviceProfileName`, `profileDisplayName`, `resolveProfileNameForDevice`); details in `.claude/rules/profiles-and-devices.md` (Elgato-only)
- `profile-switcher.ts` — Profile-switch singleton (#736): `requestProfileSwitch`, `requestProfileSwitchBack`, `notifyProfileVisible` — the layer above the adapters' `switchToProfile`; a safe no-op where unregistered (non-Elgato)
- `window-service.ts` — Window/pointer singleton (#926): `initializeWindowService` (injected `focuser` / `pointerMover` delegates, the `initializeClipboard` pattern), `getWindowService` (`focus` / `focusIfEnabled` / `movePointerToSim`), and the free `focusIRacingIfEnabled` the plugin-level key/dial listeners register. Owns the `WindowFocusResult` / `PointerMoveResult` codes and the `DEFAULT_POINTER_X_FRACTION` / `DEFAULT_POINTER_Y_FRACTION` pointer target. Replaced the three duplicated per-plugin `shared/window-focus.ts` modules, which action code could not reach.

## Build

```bash
pnpm build  # tsc → dist/
```

Pure TypeScript library, no Rollup needed. Outputs ESM with declarations.

## Dependencies

- `@iracedeck/icon-composer` — Pure icon assembly functions (zero-dependency)
- `@iracedeck/iracing-sdk` — For telemetry types and SDK controller
- `@iracedeck/logger` — For `ILogger` interface
- `semver` — Version comparison for the startup version-check (`version-check.ts`)
- `zod` — For settings schemas

Note: `keyboard-service.ts` dynamically imports `keysender` at runtime (Windows-only native module). The types are defined locally to avoid a compile-time dependency.
