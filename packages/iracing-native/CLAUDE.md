# @iracedeck/iracing-native

Native Node.js addon (C++/N-API) for iRacing SDK integration and keyboard input.

Over half of the native exports are the SDK data-access half — `startup`, `shutdown`, `isConnected`, `getHeader`, `getData`, `waitForData`, `getSessionInfoStr`, `getVarHeaderEntry`, `varNameToIndex`, `broadcastMsg` — consumed only through `@iracedeck/iracing-sdk` and not documented individually here. The window/keyboard/clipboard/elevation/chat functions documented below are the parts consumed directly by plugins and `deck-core` services (chat is also wrapped by `iracing-sdk`'s `ChatCommand`).

## Cross-Platform Architecture

The package detects the platform at module load time and behaves accordingly:

- **Windows (`win32`)**: Loads the native `.node` addon via `createRequire()`. If the addon is missing (e.g., fresh clone without `node-gyp rebuild`), falls back to the mock.
- **Other platforms**: Skips native addon loading entirely and uses `IRacingNativeMock`.
- **Force mock**: setting `IRACEDECK_MOCK=1` in the environment or creating a `.mock` file in the process cwd (the sdPlugin folder) forces the mock even on Windows — the same lever as `audio-native`.

The `IRacingNative` class delegates every method call to either `addon` (native) or `IRacingNativeMock`. Consumers never need to know which is active.

### Build behavior

The `build` script (`scripts/build.mjs`) is platform-aware:
- On Windows: runs `node-gyp rebuild` then `tsc`
- On macOS/Linux: runs `tsc` only (skips native compilation)

A `node-gyp rebuild` failure is treated as recoverable **only** when it is a file-lock error (`EBUSY`/`EPERM`/"in use"-style message — a running Stream Deck / deck host app holding the DLL) **and** an existing `build/Release/iracing_native.node` is present to reuse; any other failure rethrows so real build regressions surface. The script is deliberately kept in sync with `audio-native`'s copy — change both together.

The `install` script in `package.json` is a no-op `echo`, so `pnpm install` never triggers node-gyp — building the addon is explicit-only via `pnpm build`.

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

Internally, a static C++ helper does the `FindWindowA(NULL, "iRacing.com Simulator")` lookup and the 1000ms (100 × 10ms) focus-confirmation poll.

## Keyboard Input Functions

The addon provides four keyboard functions using Windows `SendInput()` with `KEYEVENTF_SCANCODE` for layout-independent physical key sending.

All functions accept an array of PS/2 scan codes (modifiers first, then main key). Extended keys (arrows, delete, etc.) use bit `0x100` to signal `KEYEVENTF_EXTENDEDKEY`.

### `sendScanKeys(scanCodes: number[])`
**Tap** — presses each scan code in order, holds for 100ms, then releases all in reverse order. Use for one-shot key presses (e.g., toggling a black box screen).

### `sendScanKeyDown(scanCodes: number[])`
**Press only** — presses each scan code in order without releasing. No sleep. Caller must call `sendScanKeyUp()` to release. Use for key hold / long-press scenarios (e.g., look direction).

### `sendScanKeyUp(scanCodes: number[])`
**Release only** — releases each scan code in reverse order without pressing. No sleep. Should be called after `sendScanKeyDown()` to release held keys.

### `sendScanKeySequence(chords: number[][], holdMs?: number)`
**Atomic sequence** — sends several distinct chords in order, in one call (issue #818). Each chord is its own scan-code array.

With `holdMs = 0` (the default) every down/up event of every chord is emitted in a **single `SendInput` batch** with no `Sleep`, so the target application normally consumes the whole sequence within one frame and no intermediate state is rendered. This is what lets iRaceDeck switch black boxes (press Lap Timing, then Fuel) without the priming box flickering — a black-box hotkey is a toggle, and telemetry never reports which box is shown, so a lone press cannot guarantee the target ends up visible. The batch guarantees delivery *order*, not that the target drains its whole input queue before rendering: iRacing was measured to swallow the intermediate box on nearly every press, with a rare single-frame flash when the events straddle a frame boundary.

With `holdMs > 0` it falls back to per-chord press → `Sleep(holdMs)` → release, the same shape as `sendScanKeys`, for a target that samples keyboard state per frame and would miss a zero-duration press. `holdMs` is read as a double and clamped to `[0, kMaxSequenceHoldMs]` (1000 ms) so a negative JS value can't wrap into a multi-second stall.

All four build their events with a static C++ `makeScanKeyInput(scanCode, isDown)` that derives `wVk` from the scan code with `MapVirtualKeyW()` for compatibility. The first three send one event per `SendInput()` call via `sendScanKey(scanCode, isDown)`; `sendScanKeySequence` at `holdMs = 0` batches every event into one `SendInput()` call instead.

## Clipboard Functions

### `setClipboardText(text: string): boolean`
Writes a UTF-16 string to the Windows clipboard as `CF_UNICODETEXT`. Returns `true` on success, `false` if `OpenClipboard`/`GlobalAlloc`/`GlobalLock` fail. Internally reuses the same `copyToClipboard()` helper that backs the chat-send pipeline.

Pasting is the caller's responsibility — `setClipboardText` only writes. Send `Ctrl+V` via `getKeyboard().sendKeyCombination(...)` from `@iracedeck/deck-core` to paste. Used by race-admin's "Type in Chat" driver-target mode and any future flows that need to put text on the clipboard without going through the full chat-send sequence.

## Elevation / Integrity Detection

### `getElevationStatus(): ElevationStatus`

Compares this process's elevation (integrity) level with iRacing's to detect the case where iRacing runs as Administrator while the plugin does not — Windows UIPI then silently drops every outbound command (scan-code injection and SDK broadcasts) while read-only telemetry keeps working (issue #610). A functional probe can't detect this (UIPI-blocked input still reports success), so the comparison of integrity levels is the only reliable signal.

Returns `{ selfElevated, iracingFound, iracingQueryDenied, iracingElevated, mismatch }`:

- `selfElevated` — this process's `TOKEN_ELEVATION.TokenIsElevated` via `OpenProcessToken` + `GetTokenInformation(TokenElevation)`.
- `iracingFound` — `FindWindowA(NULL, "iRacing.com Simulator")` located the window.
- `iracingQueryDenied` — `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` on iRacing's PID failed with `ERROR_ACCESS_DENIED` (it runs at a higher integrity level than us).
- `iracingElevated` — iRacing's token reports elevated (only meaningful when the `OpenProcess` query succeeded).
- `mismatch` — `!selfElevated && iracingFound && (iracingQueryDenied || iracingElevated)`. Computed in the N-API wrapper from the fields above.

Because the signal is *relative* integrity, it also catches non-"Administrator" integrity differences, not just the literal Administrator case.

This is **not** a keyboard function: it has no keyboard-service / `initializeKeyboard` wiring. The cross-package sync chain below applies only to its native↔TS↔mock mirror (`addon.cc` → `src/index.ts` → `src/mock-impl.ts`) and this document. Consumers (the plugins) read it directly via `new IRacingNative().getElevationStatus()`.

## Chat Functions

### `sendChatMessage(message: string, openToPasteDelayMs?: number, pasteToEnterDelayMs?: number, enterToCloseDelayMs?: number): Promise<boolean>`

Runs the full chat-send pipeline (copy → `Cancel` → `BeginChat` → paste → `Enter` → `Cancel`) on a libuv worker thread and resolves `true` on success, `false` on failure. Concurrent sends are serialized natively via `g_chatSendMutex`.

The three waits around the paste and submit are caller-supplied (issues #581, #589) and each default to `200` ms when omitted:

- `openToPasteDelayMs` — wait after `BeginChat` before pasting. Sourced from the `chatOpenToPasteDelayMs` global setting by the action layer.
- `pasteToEnterDelayMs` — wait after pasting before pressing `Enter`. Sourced from `chatPasteToEnterDelayMs`.
- `enterToCloseDelayMs` — wait after pressing `Enter` before the closing `Cancel` (issue #589). Sourced from `chatEnterToCloseDelayMs`. Too short and the `Cancel` lands before iRacing has processed the submit, so it's dropped and the chat window keeps focus.

Each delay is read defensively and clamped into `[0, kMaxChatDelayMs]` (10000 ms). Reading as a double (not `Uint32Value()`) avoids ECMAScript `ToUint32` wrapping a negative value into a huge `DWORD` and turning `Sleep()` into a multi-day stall while `g_chatSendMutex` is held.

The cancel→begin wait stays on the fixed `kChatStepDelayMs` (100 ms). The `Enter` keypress is split into key-down → `Sleep(kChatEnterHoldMs)` (100 ms) → key-up so a zero-duration press isn't dropped under load; `kChatEnterHoldMs` is a fixed native constant, not user-configurable.

## Cross-Package Sync

The TypeScript wrapper in `src/index.ts` must mirror every function exported from `addon.cc`. When adding or modifying native keyboard functions:

1. Update `addon.cc` — C++ implementation + register in `Init()`
2. Update `src/index.ts` — add corresponding TypeScript method to `IRacingNative` class
3. Update `packages/deck-core/src/keyboard-service.ts` — add callback type, `IKeyboardService` interface method, and `KeyboardService` implementation (re-exported by `packages/iracing-plugin-stream-deck/src/shared/index.ts`)
4. Update plugin `plugin.ts` files — pass new callbacks to `initializeKeyboard()`
5. Update tests — `keyboard-service.test.ts`
6. Update rules — `.claude/rules/keyboard-shortcuts.md`, `.claude/rules/plugin-structure.md`
