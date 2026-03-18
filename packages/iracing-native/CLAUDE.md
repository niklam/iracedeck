# @iracedeck/iracing-native

Native Node.js addon (C++/N-API) for iRacing SDK integration and keyboard input.

## Cross-Platform Architecture

The package detects the platform at module load time and behaves accordingly:

- **Windows (`win32`)**: Loads the native `.node` addon via `createRequire()`. If the addon is missing (e.g., fresh clone without `node-gyp rebuild`), falls back to the mock.
- **Other platforms**: Skips native addon loading entirely and uses `IRacingNativeMock`.

The `IRacingNative` class delegates every method call to either `addon` (native) or `IRacingNativeMock`. Consumers never need to know which is active.

### Build behavior

The `build` script (`scripts/build.mjs`) is platform-aware:
- On Windows: runs `node-gyp rebuild` then `tsc`
- On macOS/Linux: runs `tsc` only (skips native compilation)

### Mock implementation

`IRacingNativeMock` (in `src/mock-impl.ts`) provides:
- Simulated connection lifecycle (`startup`/`shutdown`/`isConnected`)
- Mock telemetry data that rotates through 3 snapshots (mid-straight, braking, pit entry)
- Mock session info YAML (Spa practice, 3 drivers)
- No-op implementations for broadcast messages, chat, and keyboard input

### Mock data

Located in `src/mock-data/`:
- `session-info.ts` — YAML string for a practice session at Spa
- `telemetry.ts` — Variable headers with computed offsets and a `buildTelemetryBuffer()` function
- `snapshots.ts` — 3 telemetry snapshots with realistic values

### When adding new native methods

In addition to the cross-package sync steps below, you must also add the method to `IRacingNativeMock` in `src/mock-impl.ts`.

## Window Management Functions

### `focusIRacingWindow(): number`
Brings the iRacing simulator window (`"iRacing.com Simulator"`) to the foreground using the `AttachThreadInput` + `SetForegroundWindow` pattern. Returns a `FocusResult` status code:
- `0` (`AlreadyFocused`) — window was already in the foreground
- `1` (`Focused`) — window was found and successfully focused
- `2` (`WindowNotFound`) — no window with the expected title exists
- `3` (`FocusTimedOut`) — window was found but focus did not transfer within 1000ms

Used by the window focus service when the `focusIRacingWindow` global setting is enabled. Called before every action to ensure inputs reach iRacing.

### Internal helper: `focusIRacingWindow()` (static C++)
Uses `FindWindowA(NULL, "iRacing.com Simulator")` to locate the window, checks if it is already focused via `GetForegroundWindow()`, and uses `AttachThreadInput` to temporarily attach the current thread to the foreground thread before calling `SetForegroundWindow`. Polls for up to 1000ms (100 iterations × 10ms) to confirm the focus change took effect.

## Keyboard Input Functions

The addon provides three keyboard functions using Windows `SendInput()` with `KEYEVENTF_SCANCODE` for layout-independent physical key sending.

All functions accept an array of PS/2 scan codes (modifiers first, then main key). Extended keys (arrows, delete, etc.) use bit `0x100` to signal `KEYEVENTF_EXTENDEDKEY`.

### `sendScanKeys(scanCodes: number[])`
**Tap** — presses each scan code in order, holds for 100ms, then releases all in reverse order. Use for one-shot key presses (e.g., toggling a black box screen).

### `sendScanKeyDown(scanCodes: number[])`
**Press only** — presses each scan code in order without releasing. No sleep. Caller must call `sendScanKeyUp()` to release. Use for key hold / long-press scenarios (e.g., look direction).

### `sendScanKeyUp(scanCodes: number[])`
**Release only** — releases each scan code in reverse order without pressing. No sleep. Should be called after `sendScanKeyDown()` to release held keys.

### Internal helper: `sendScanKey(scanCode, isDown)`
Static C++ function used by all three public functions. Sends a single key event via `SendInput()`. Derives `wVk` from scan code using `MapVirtualKeyW()` for compatibility.

## Cross-Package Sync

The TypeScript wrapper in `src/index.ts` must mirror every function exported from `addon.cc`. When adding or modifying native keyboard functions:

1. Update `addon.cc` — C++ implementation + register in `Init()`
2. Update `src/index.ts` — add corresponding TypeScript method to `IRacingNative` class
3. Update `stream-deck-plugin/src/shared/keyboard-service.ts` — add callback type, interface method, and implementation
4. Update plugin `plugin.ts` files — pass new callbacks to `initializeKeyboard()`
5. Update tests — `keyboard-service.test.ts`
6. Update rules — `.claude/rules/keyboard-shortcuts.md`, `.claude/rules/plugin-structure.md`
