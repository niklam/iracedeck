# @iracedeck/iracing-native

Native Node.js addon (C++/N-API) for iRacing SDK integration and keyboard input.

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
3. Update `stream-deck-shared/src/keyboard-service.ts` — add callback type, interface method, and implementation
4. Update plugin `plugin.ts` files — pass new callbacks to `initializeKeyboard()`
5. Update tests — `keyboard-service.test.ts`
6. Update rules — `.claude/rules/keyboard-shortcuts.md`, `.claude/rules/plugin-structure.md`
