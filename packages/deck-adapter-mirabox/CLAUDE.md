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
- **`dialRotate.pressed` defaults to `false`** — the adapter passes `pressed` through when a frame carries it and defaults it to `false` otherwise. On the knob devices measured in #1013 it is never `true`: a push+turn sends a lone `dialDown` and no `dialRotate` at all.
- **A knob press is atomic (#1013)** — pushing a knob sends a lone `dialDown` and never a `dialUp`, whatever the push length, while tapping the screen above it sends `dialDown` + `dialUp` 50 ms apart, and the two `dialDown` messages are byte-identical. So on a host `dialDown` the adapter fires the `onDialDown` broadcast callbacks and `handler.onDialDown`, then immediately `handler.onDialUp` for the same context, and it drops every host `dialUp` (logged at debug on the `Dial` scope). Both inputs fire the Press gesture exactly once, at the moment of pressing, and no dial surface changes. No timer. Spec: `docs/superpowers/specs/2026-09-26-issue-1013-mirabox-knob-dials.md` ("The Mirabox adapter makes a knob press atomic").
- **Knob screen, no touch strip** — `dialCanvas()` is the 176×112 `stream-dock-knob` profile on a Knob (or Encoder) context and `setDialCanvas` rasterizes the drawing at that size through `setImage`; `setFeedback`/`setFeedbackLayout`/`setTriggerDescription` stay no-ops and `onTouchTap` is never delivered. The knob has rotate and press only — see `.claude/rules/encoders-and-touchscreen.md`.
- **`switchToProfile` is a no-op** — Stream Deck profiles are Elgato-only and the Stream Dock host has no profile system. The PI "Stream Deck Profiles" accordion is hidden on this platform via the `profiles` feature flag (`packages/iracing-plugin-mirabox/platform-features.json`), so the method exists only to satisfy `IDeckPlatformAdapter`.

## VSD Craft WebSocket Protocol

VSD Craft passes connection parameters via `process.argv`; `parseConnectionParams` reads:
- `argv[3]` = WebSocket port
- `argv[5]` = plugin UUID
- `argv[7]` = registration event name

`argv[9]` (JSON info, includes `application.language`) exists in the protocol but is never parsed.

The protocol uses the same event names as Elgato (`willAppear`, `keyDown`, `setImage`, etc.); the knob/touch-strip differences are documented in `docs/reference/stream-deck-plus-encoders.md` (which links Mirabox's own porting guide).

## Also Contains

- `VSDClient` — Low-level WebSocket client for the VSD Craft protocol. `connect()` dynamically imports `ws` (avoids bundling issues) and auto-fires `requestGlobalSettings()` on open, then reports the open socket to `onHostReady` subscribers (#1056) — deck-core's cue to re-arm the settings-migration deadline, since the read it issued earlier was dropped into a closed socket. That notify sits in a `finally` so a throw earlier in the handler cannot silently cancel the re-arm. `setGlobalSettings()` defers until the socket is open (latest-wins: a call before `open` is stashed and flushed right after the register + `getGlobalSettings` frames) — the plugin's once-per-start host-mirror write can otherwise race the socket connect and get silently dropped by `send()`, which was observed live (#993). Default `onClose` is `process.exit(0)` — the plugin process terminates when the host closes the socket.
- `file-logger.ts` — `FileSink` (per-day `<dir>/<YYYY.M.D>.log` appender, unpadded month/day to match the host's `log/` convention; the first write of each run prunes files older than `LOG_RETENTION_DAYS` = 14, issue #904) + `withFileSink` (tees an `ILogger` to the sink under the same live level gate)
- Public exports (`src/index.ts`) — besides `VSDPlatformAdapter` and `VSDClient`: `parseConnectionParams` and the types `VSDConnectionParams`, `VSDEvent`, `VSDEventHandler`

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (VSD Craft bundles Node.js 20 which lacks stable built-in WebSocket)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
