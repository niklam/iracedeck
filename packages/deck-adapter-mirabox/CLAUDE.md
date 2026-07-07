# @iracedeck/deck-adapter-mirabox

Mirabox adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the VSD Craft WebSocket protocol to the platform-agnostic interfaces.

## How It Works

`VSDPlatformAdapter` wraps a custom `VSDClient` (TypeScript WebSocket client):

- **`registerAction(uuid, handler)`** — Registers event handlers for each action UUID on the VSD WebSocket client, wrapping VSD events into deck-core events via `VSDActionContext`
- **Event wrapping** — Converts VSD WebSocket events to deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, etc.) via `VSDActionContext`
- **`WillDisappearEvent` special case** — Same as Elgato adapter: provides no-op stubs for `setImage`/`setTitle`
- **`createLogger(scope)`** — `createConsoleLogger()` from `@iracedeck/logger`, additionally teed to `<plugin>/log/<YYYY.M.D>.log` (via `file-logger.ts`) when a log directory is passed to the constructor (`new VSDPlatformAdapter(logger?, logDir?)`, issue #609). The Stream Dock host discards plugin stdout, so the file is what the "Enable debug logging" toggle captures for support. Console and file share the live `logLevel` (`setLogLevel`).
- **Broadcast callbacks** — `onKeyDown`, `onDialDown`, `onDialRotate` fire before per-action handlers (for window focus)
- **Controller tracking** — Tracks the controller type (`Keypad` / `Encoder` / `Knob` / `Information`) per context from `willAppear` events. `isKey()` is true for `Keypad` **and** `Information` (the Stream Dock 293S read-only info area updates via `setImage`); `isDial()` is true for `Knob` and `Encoder`.
- **`dialRotate` carries `pressed` natively** — Mirabox's C++ SDK sends `pressed` on rotate frames (rotate-while-held is not Elgato-only); the adapter defaults it to `false` when a frame omits it.
- **No touch strip** — `setFeedback`/`setFeedbackLayout` are **no-ops** (the Stream Dock protocol has no plugin-drawable touch strip; update knob icons via `setImage`), and there is **no touch-tap input** (`onTouchTap` is never delivered). Dial actions branch on `__FEATURE_DIAL_FEEDBACK__` so this code path is stripped from the Mirabox bundle. See `.claude/rules/encoders-and-touchscreen.md`.
- **`switchToProfile` is a no-op** — Stream Deck profiles are Elgato-only and the Stream Dock host has no profile system. The PI "Stream Deck Profiles" accordion is hidden on this platform via the `profiles` feature flag (`packages/iracing-plugin-mirabox/platform-features.json`), so the method exists only to satisfy `IDeckPlatformAdapter`.

## VSD Craft WebSocket Protocol

VSD Craft passes connection parameters via `process.argv`; `parseConnectionParams` reads:
- `argv[3]` = WebSocket port
- `argv[5]` = plugin UUID
- `argv[7]` = registration event name

`argv[9]` (JSON info, includes `application.language`) exists in the protocol but is never parsed.

The protocol uses the same event names as Elgato (`willAppear`, `keyDown`, `setImage`, etc.); the knob/touch-strip differences are documented in `docs/reference/stream-deck-plus-encoders.md` (which links Mirabox's own porting guide).

## Also Contains

- `VSDClient` — Low-level WebSocket client for the VSD Craft protocol. `connect()` dynamically imports `ws` (avoids bundling issues) and auto-fires `requestGlobalSettings()` on open. Default `onClose` is `process.exit(0)` — the plugin process terminates when the host closes the socket.
- `file-logger.ts` — `FileSink` (per-day `<dir>/<YYYY.M.D>.log` appender, unpadded month/day to match the host's `log/` convention) + `withFileSink` (tees an `ILogger` to the sink under the same live level gate)
- Public exports (`src/index.ts`) — besides `VSDPlatformAdapter` and `VSDClient`: `parseConnectionParams` and the types `VSDConnectionParams`, `VSDEvent`, `VSDEventHandler`

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (VSD Craft bundles Node.js 20 which lacks stable built-in WebSocket)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
