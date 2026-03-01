# Cross-Platform Development: Mock Native Layer for macOS

## Context

`@iracedeck/iracing-native` is a C++ N-API addon that wraps the iRacing SDK (Windows-only). Every downstream package (`iracing-sdk`, `stream-deck-plugin-core`) depends on it, and all have `"os": ["win32"]` in their `package.json`. This means `pnpm install`, `pnpm build`, and `pnpm test` all fail on macOS.

**Goal**: Make the full development loop (install → build → test → runtime mock) work on macOS while keeping Windows behavior identical.

## Approach: Platform-Aware `iracing-native`

Modify `iracing-native` to detect the platform and export a mock `IRacingNative` class on non-Windows systems. All upstream packages remain unchanged since they already code to the `IRacingNative` class interface.

## Architecture

### Platform detection

- `platform() === "win32"` is the primary guard (never tries to load .node on macOS)
- `try/catch` is the safety net (handles missing .node on Windows, e.g. fresh clone)
- Lazy mock instantiation (only created when needed)
- No top-level await — keeps the same synchronous module loading pattern

### Mock behavior

| Method | Mock behavior |
|--------|--------------|
| `startup()` | Sets connected flag, returns `true` |
| `shutdown()` | Clears connected flag |
| `isConnected()` | Returns connected flag |
| `getHeader()` | Returns mock `IRSDKHeader` (ver=2, numVars matching mock data) |
| `getData(index)` | Returns Buffer built from current snapshot |
| `waitForData(timeout?)` | Rotates snapshot if interval elapsed, returns Buffer |
| `getSessionInfoStr()` | Returns mock YAML string (Spa practice, 3 drivers) |
| `getVarHeaderEntry(index)` | Returns from mock var headers array |
| `varNameToIndex(name)` | Looks up in mock name→index map |
| `broadcastMsg(...)` | No-op, `console.debug` |
| `sendChatMessage(msg)` | No-op, `console.debug`, returns `true` |
| `sendScanKeys/Down/Up(...)` | No-op, `console.debug` |

### Telemetry snapshots

The mock cycles through 3 telemetry snapshots every 3 seconds:
1. Mid-straight (high speed, high RPM)
2. Braking zone (low speed, heavy braking)
3. Pit entry (on pit road, low speed)

### Dependencies

- `keysender` is moved to `optionalDependencies` (silently fails on macOS)
- A type shim provides TypeScript types when `keysender` is not installed

## Key files

| File | Purpose |
|------|---------|
| `packages/iracing-native/src/index.ts` | Platform check + mock delegation |
| `packages/iracing-native/src/mock-impl.ts` | Mock IRacingNative class |
| `packages/iracing-native/src/mock-data/` | Session info, var headers, snapshots |
| `packages/iracing-native/scripts/build.mjs` | Platform-aware build script |
| `packages/stream-deck-plugin-core/src/shared/keysender.d.ts` | Type shim for keysender |
