# @iracedeck/deck-adapter-mirabox

Mirabox adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the VSD Craft WebSocket protocol to the platform-agnostic interfaces.

## How It Works

`VSDPlatformAdapter` wraps a custom `VSDClient` (TypeScript WebSocket client):

- **`registerAction(uuid, handler)`** — Registers event handlers for each action UUID on the VSD WebSocket client, wrapping VSD events into deck-core events via `VSDActionContext`
- **Event wrapping** — Converts VSD WebSocket events to deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, etc.) via `VSDActionContext`
- **`WillDisappearEvent` special case** — Same as Elgato adapter: provides no-op stubs for `setImage`/`setTitle`
- **`createLogger(scope)`** — `createConsoleLogger()` from `@iracedeck/logger`, additionally teed to `<plugin>/log/<YYYY.M.D>.log` (via `file-logger.ts`) when a log directory is passed to the constructor (`new VSDPlatformAdapter(logger?, logDir?)`, issue #609). The Stream Dock host discards plugin stdout, so the file is what the "Enable debug logging" toggle captures for support. Console and file share the live `logLevel` (`setLogLevel`). `logLocation` is the per-day `log` directory passed to the constructor (`{ kind: "daily", dir }`), or `undefined` without one; the shared bootstrap hands it to the main-thread watchdog and refuses to start without it.
- **Per-context order (#1597)** — every handler event of `registerAction` goes through one deck-core `ContextEventOrder` per adapter (logger scope `EventOrder`). Each client callback calls `order.enqueue(context, kind, task)` before any await of its own, so arrival order is the order the handlers see; the task builds the deck-core event and calls the handler when it runs, synchronously inside the enqueue when nothing is ahead. `willAppear`, `willDisappear` and `didReceiveSettings` are exclusive (each waits for every earlier event of the context and holds every later one); `keyDown`, `keyUp`, `dialDown` and `dialRotate` wait only for lifecycle, so two presses still run concurrently. `VSDClient.routeEvent` awaits the returned promise and logs a handler's error as before. The rules, the 10 s bound and the log lines are deck-core's: `context-event-order.ts` and the spec `docs/superpowers/specs/2026-11-02-issue-1597-lifecycle-event-ordering.md`.
- **A `willAppear` for a live context is a settings change** — when `order.isLive(context)` at its arrival, it is enqueued as an exclusive `didReceiveSettings` carrying that frame's settings and the controller the context appeared as (read from `contextControllers` when the task runs), logged at debug on the `Lifecycle` scope; never a second appear, never dropped.
- **Input for a context that never appeared is dropped** — the order drops input, a settings change and a disappear for a context whose `willAppear` has not arrived (or whose `willDisappear` has), logging a never-appeared drop once per context at warn and later ones at debug. This replaced the old fallback that delivered such input with a defaulted `Keypad` controller. It rests on the Stream Dock sending `willAppear` for every context before its input, including after a plugin restart; a wrong assumption shows as `it never appeared` lines in a default-level log.
- **Broadcast callbacks** — `onKeyDown`, `onDialDown`, `onDialRotate` fire at the event's arrival, before it is enqueued (so before the handler, for window focus), and only when `order.isLive(context)` — never for a context that has not appeared or whose disappear has arrived.
- **Controller tracking** — Tracks the controller type (`Keypad` / `Encoder` / `Knob` / `Information`) per context in `contextControllers`, written only inside the ordered tasks: the appear task sets the entry and then calls the handler, the disappear task deletes it and then calls the handler, so every other task of the context reads the controller it appeared as. `isKey()` is true for `Keypad` **and** `Information` (the Stream Dock 293S read-only info area updates via `setImage`); `isDial()` is true for `Knob` and `Encoder`.
- **The ordering contract suite** — `adapter.test.ts` runs deck-core's `CONTEXT_EVENT_ORDER_SCENARIOS` (`@iracedeck/deck-core/testing`) with `it.each`, one fresh adapter per scenario, through a harness that calls the handler the adapter registered on the mocked client synchronously, as `routeEvent` does. Its `hostEvents` leave out `dialUp` (dropped, below) and `touchTap` (no touch strip). `scripts/deck-adapter-order-contract.test.mjs` fails the package if the run goes. A test that drives input, a settings change or a disappear appears its context first (the `appear` helper), or the order drops the event.
- **`dialRotate.pressed` defaults to `false`** — the adapter passes `pressed` through when a frame carries it and defaults it to `false` otherwise. On the knob devices measured in #1013 it is never `true`: a push+turn sends a lone `dialDown` and no `dialRotate` at all.
- **A knob press is atomic (#1013)** — pushing a knob sends a lone `dialDown` and never a `dialUp`, whatever the push length, while tapping the screen above it sends `dialDown` + `dialUp` 50 ms apart, and the two `dialDown` messages are byte-identical. So on a host `dialDown` the adapter fires the `onDialDown` broadcast callbacks and `handler.onDialDown`, then immediately `handler.onDialUp` for the same context, and it drops every host `dialUp` (logged at debug on the `Dial` scope). The down and up are ONE input task in the per-context order, so a `willDisappear` arriving between them runs after both and the press stays atomic. Both inputs fire the Press gesture exactly once, at the moment of pressing, and no dial surface changes. No timer. Spec: `docs/superpowers/specs/2026-09-26-issue-1013-mirabox-knob-dials.md` ("The Mirabox adapter makes a knob press atomic").
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

- `VSDClient` — Low-level WebSocket client for the VSD Craft protocol. `connect()` dynamically imports `ws` (avoids bundling issues) and auto-fires `requestGlobalSettings()` on open, then reports the open socket to `onHostReady` subscribers (#1056) — the cue for `@iracedeck/settings`' `initGlobalSettings` to re-arm the settings-migration deadline, since the read it issued earlier was dropped into a closed socket. That notify sits in a `finally` so a throw earlier in the handler cannot silently cancel the re-arm. `setGlobalSettings()` defers until the socket is open (latest-wins: a call before `open` is stashed and flushed right after the register + `getGlobalSettings` frames) — the plugin's once-per-start host-mirror write can otherwise race the socket connect and get silently dropped by `send()`, which was observed live (#993). Default `onClose` is `process.exit(0)` — the plugin process terminates when the host closes the socket.
- `file-logger.ts` — `FileSink` (per-day `<dir>/<YYYY.M.D>.log` appender, unpadded month/day to match the host's `log/` convention; the first write of each run prunes files older than `LOG_RETENTION_DAYS` = 14, issue #904) + `withFileSink` (tees an `ILogger` to the sink under the same live level gate)
- Public exports (`src/index.ts`) — besides `VSDPlatformAdapter` and `VSDClient`: `parseConnectionParams` and the types `VSDConnectionParams`, `VSDEvent`, `VSDEventHandler`

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (VSD Craft bundles Node.js 20 which lacks stable built-in WebSocket)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/app-constants` — `LogLocation`, the type `logLocation` reports (#1367)
- `@iracedeck/diagnostics` — devDependency only: `file-logger.test.ts` checks the file name the `FileSink` writes against the watchdog's `watchdogDailyLogFileName` (#1367)
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
