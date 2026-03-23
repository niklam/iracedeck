# @iracedeck/deck-adapter-mirabox

Mirabox adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the VSD Craft WebSocket protocol to the platform-agnostic interfaces.

## How It Works

`VSDPlatformAdapter` wraps a custom `VSDClient` (TypeScript WebSocket client):

- **`registerAction(uuid, handler)`** — Registers event handlers for each action UUID on the VSD WebSocket client, wrapping VSD events into deck-core events via `VSDActionContext`
- **Event wrapping** — Converts VSD WebSocket events to deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, etc.) via `VSDActionContext`
- **`WillDisappearEvent` special case** — Same as Elgato adapter: provides no-op stubs for `setImage`/`setTitle`
- **`createLogger(scope)`** — Uses `createConsoleLogger()` from `@iracedeck/logger` (VSD has no built-in logger API)
- **Broadcast callbacks** — `onKeyDown`, `onDialDown`, `onDialRotate` fire before per-action handlers (for window focus)
- **Controller tracking** — Tracks `Keypad` vs `Knob` per context from `willAppear` events for `isKey()` method

## VSD Craft WebSocket Protocol

VSD Craft passes connection parameters via `process.argv`:
- `argv[3]` = WebSocket port
- `argv[5]` = plugin UUID
- `argv[7]` = registration event name
- `argv[9]` = JSON info (includes `application.language`)

The protocol uses the same event names as Elgato (`willAppear`, `keyDown`, `setImage`, etc.) with minor differences documented in the VSDinside porting guides.

## Also Contains

- `VSDClient` — Low-level WebSocket client for the VSD Craft protocol

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (VSD Craft bundles Node.js 20 which lacks stable built-in WebSocket)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
