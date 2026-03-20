# @iracedeck/deck-adapter-elgato

Elgato Stream Deck adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the `@elgato/streamdeck` SDK to the platform-agnostic interfaces.

## How It Works

`ElgatoPlatformAdapter` wraps the Elgato SDK:

- **`registerAction(uuid, handler)`** — Creates a bridge `SingletonAction` subclass with the `@action({ UUID })` decorator, delegates all lifecycle methods (`onWillAppear`, `onKeyDown`, etc.) to the platform-neutral handler
- **Event wrapping** — Converts Elgato events (`WillAppearEvent`, `KeyDownEvent`, etc.) to deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, etc.) via `ElgatoActionContext`
- **`WillDisappearEvent` special case** — Elgato's `ActionContext` lacks `setImage`/`setTitle`/`isKey`, so `wrapDisappearEvent()` provides no-op stubs
- **`createLogger(scope)`** — Wraps `streamDeck.logger.createScope()` via `createSDLogger()`
- **Other adapter methods** — Delegate directly to the Elgato SDK (`onDidReceiveGlobalSettings`, `onApplicationDidLaunch`, `connect`, etc.)

## Also Contains

- `createSDLogger()` / `SDLoggerLike` — Wraps Elgato's SDK logger into the `ILogger` interface with level filtering

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `@elgato/streamdeck` — The Elgato Stream Deck SDK
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface
