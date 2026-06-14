# @iracedeck/deck-adapter-ulanzi

Ulanzi Deck adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the UlanziStudio WebSocket protocol to the platform-agnostic interfaces, so every iRaceDeck action runs unchanged on Ulanzi Deck devices (D200 / D200H / Dial / D200X).

Mirrors `@iracedeck/deck-adapter-mirabox`. The key difference: VSD Craft speaks Elgato-style event names on the wire, so the Mirabox adapter barely translates; Ulanzi uses a flatter `cmd`-dispatched envelope, so the **client** does more work and the **adapter** stays a near-clone of `VSDPlatformAdapter`.

## How It Works

- **`UlanziClient`** (`ulanzi-client.ts`) — low-level WebSocket client. It NORMALIZES every raw Ulanzi frame into an Elgato-style `UlanziEvent` (`normalizeFrame`, a pure function) so the adapter layer can stay structurally identical to Mirabox. It also keeps a **per-context settings cache** (see below) and builds outbound frames.
- **`UlanziPlatformAdapter`** (`adapter.ts`) — wraps the client, translating normalized events into deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, …) via `UlanziActionContext`. Near-identical to `VSDPlatformAdapter`.
- **`UlanziActionContext.setTitle` is a no-op** — Ulanzi has no native title API (labels travel as the `text` field of the icon setter). iRaceDeck bakes the title into the icon SVG and every action only ever calls `setTitle("")` to clear the native title, which Ulanzi never draws (`setImage` sends `showtext:false`).
- **`createLogger(scope)`** — `createConsoleLogger()` teed to `<plugin>/log/<YYYY.M.D>.log` (`file-logger.ts`) when a log dir is passed to the constructor (issue #609). The UlanziStudio host discards plugin stdout, same as Mirabox's Stream Dock host. Console + file share the live `logLevel` (`setLogLevel`).
- **Broadcast callbacks** — `onKeyDown`, `onDialDown`, `onDialRotate` fire before per-action handlers (for window focus).
- **Plugin UUID** — `PLUGIN_UUID` (`com.iracedeck.sd.core`, the same UUID the Elgato/Mirabox plugins use) is sent in the `connected` handshake and the global-settings frames. UlanziStudio only requires a 4-segment main-service UUID and does **not** validate the prefix, so there's no Ulanzi-specific remapping — actions register under, and the manifest declares, their canonical `com.iracedeck.sd.core.*` UUIDs verbatim (same as Mirabox).

## UlanziStudio WebSocket Protocol

The plugin is the WebSocket **client**; UlanziStudio is the server. Connection params come from `process.argv`:

- `argv[2]` = address (default `127.0.0.1`)
- `argv[3]` = port (default `3906`)
- `argv[4]` = language

On open the client sends the handshake `{ code: 0, cmd: "connected", uuid }` (no separate registration payload — the host already parsed `manifest.json`). Inbound frames are dispatched on the **`cmd`** field; the context string is synthesized client-side as `uuid + "___" + key + "___" + actionid`.

### Frame normalization (`normalizeFrame`)

| Ulanzi `cmd`                                              | normalized event             | notes                                                      |
| --------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `add`                                                     | `willAppear`                 | settings in `param`                                        |
| `keydown` / `keyup`                                       | `keyDown` / `keyUp`          | no settings on the wire — backfilled from cache            |
| `dialdown` / `dialup`                                     | `dialDown` / `dialUp`        |                                                            |
| `dialrotate`                                              | `dialRotate`                 | `rotateEvent` (left/right/hold-left/hold-right) → ±1 ticks |
| `clear`                                                   | `willDisappear` (per item)   | `param` is an **array**                                    |
| `didReceiveSettings` / `paramfromapp` / `paramfromplugin` | `didReceiveSettings`         | settings in `param`                                        |
| `didReceiveGlobalSettings`                                | global event                 | settings in `settings`                                     |
| `sendToPlugin` (PI-appear marker)                         | `propertyInspectorDidAppear` | see below                                                  |
| `run` / `setactive` / acks                                | (ignored)                    |                                                            |

Frames with `code` set and no `cmdType === "REQUEST"` are ack/responses and are dropped.

### Per-context settings cache

Ulanzi only carries settings on `add` / `paramfromapp`; `keydown` / `keyup` / `dial*` frames omit them. The client caches the latest settings per context and **backfills** press/dial events before routing — otherwise actions would fire with empty settings. The cache is dropped on `clear`.

### PI-appear (synthesized)

UlanziStudio has no host-generated "PI appeared" event. The Ulanzi PI bridge (in `@iracedeck/pi-components`) sends a `sendToPlugin` marker (`payload.event === "propertyInspectorDidAppear"`) on connect; the client normalizes that into the `propertyInspectorDidAppear` global event so `onPropertyInspectorDidAppear` (e.g. audio-device re-enumeration) works.

### Outbound icons

A single `cmd:"state"` frame with `param.statelist:[{ …, type:1, data:<data-uri>, textData:"", showtext:false }]`. Ulanzi has no `setTitle`/`setState`/`setFeedback` — labels travel via the `text`/`showtext` fields, and dial layouts are manifest-declared only. iRaceDeck passes the `data:image/svg+xml,...` URI straight through (raw passthrough). Validated live in UlanziDeck — the SVG data-URI icons render, so no rasterization fallback is needed.

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (UlanziStudio bundles Node.js 20)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
