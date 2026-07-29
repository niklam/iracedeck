# @iracedeck/deck-adapter-ulanzi

Ulanzi Deck adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the UlanziStudio WebSocket protocol to the platform-agnostic interfaces, so every iRaceDeck action runs unchanged on Ulanzi Deck devices (D200 / D200H / Dial / D200X).

Mirrors `@iracedeck/deck-adapter-mirabox`. The key difference: VSD Craft speaks Elgato-style event names on the wire, so the Mirabox adapter barely translates; Ulanzi uses a flatter `cmd`-dispatched envelope, so the **client** does more work and the **adapter** stays a near-clone of `VSDPlatformAdapter`.

## How It Works

- **`UlanziClient`** (`ulanzi-client.ts`) — low-level WebSocket client. It NORMALIZES every raw Ulanzi frame into an Elgato-style `UlanziEvent` (`normalizeFrame`, a pure function) so the adapter layer can stay structurally identical to Mirabox. It also keeps a **per-context settings cache** (see below) and builds outbound frames. Default `onClose` is `process.exit(0)` — the plugin process terminates when the host closes the socket.
- **`UlanziPlatformAdapter`** (`adapter.ts`) — wraps the client, translating normalized events into deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, …) via `UlanziActionContext`. Near-identical to `VSDPlatformAdapter`.
- **Controller type defaults to Keypad (gotcha for the #786 dial re-enable)** — Ulanzi `add` frames carry no controller hint (`normalizeFrame("add")` emits only settings), so every context falls back to `Keypad` in `registerAction` and `isDial()` is effectively never true on Ulanzi today. Also, `ControllerType` here is `"Keypad" | "Encoder" | "Information"` — no `"Knob"` (unlike Mirabox).
- **`switchToProfile` is a no-op** — UlanziStudio has no profile system. The PI "Stream Deck Profiles" accordion is hidden on this platform via the `profiles` feature flag (`packages/iracing-plugin-ulanzi/platform-features.json`), so the method exists only to satisfy `IDeckPlatformAdapter`.
- **No app-monitoring events** — the protocol maps nothing to `applicationDidLaunch`/`applicationDidTerminate` (see `normalizeFrame`'s cmd switch), so the adapter declares `supportsApplicationMonitoring = false` (#870). The app monitor then keeps SDK reconnect polling enabled at startup — the shared-memory connection is the only "iRacing is running" signal on this host, and its sustained loss is the exit signal for the version-check deferral's SDK-disconnect fallback.
- **`openUrl(url)`** — the adapter's own method sends the `openurl` cmd best-effort (harmless if the host ignores it). PI link clicks route through here too: UlanziStudio ignores `openurl` sent on the **PI** socket, so the PI bridge relays link clicks as a `sendToPlugin` openUrl marker and the adapter constructor forwards them out the plugin socket via `client.openUrl` (#845).
- **`UlanziActionContext.setTitle` is a no-op** — Ulanzi has no native title API (labels travel as the `text` field of the icon setter). iRaceDeck bakes the title into the icon SVG and every action only ever calls `setTitle("")` to clear the native title, which Ulanzi never draws (`setImage` sends `showtext:false`).
- **`createLogger(scope)`** — `createConsoleLogger()` teed to `<plugin>/log/<YYYY.M.D>.log` (`file-logger.ts`) when a log dir is passed to the constructor (issue #609). The UlanziStudio host discards plugin stdout, same as Mirabox's Stream Dock host. Console + file share the live `logLevel` (`setLogLevel`).
- **Broadcast callbacks** — `onKeyDown`, `onDialDown`, `onDialRotate` fire before per-action handlers (for window focus).
- **Plugin UUID** — `PLUGIN_UUID` (`com.iracedeck.sd.core`, the canonical UUID reused verbatim — see the root `CLAUDE.md`) is sent in the `connected` handshake and the global-settings frames.
- **Global-settings scope + boot bootstrap (#868)** — UlanziStudio persists global settings bucketed by the frame's `uuid` verbatim, so **writes are always plugin-scoped** (`PLUGIN_UUID`, empty key/actionid; the Ulanzi PI bridge in `@iracedeck/pi-components` uses the same scope). The host does not answer the connect-time plugin-scope read (the Ulanzi SDK requires an action context on main-service `getGlobalSettings`), so the adapter re-drives the read once with the **first appearing action's context**. Reply routing: plugin-scoped replies (uuid absent or `PLUGIN_UUID`) are authoritative and always forwarded; action-scoped replies are only the bootstrap fallback and are dropped once a non-empty plugin-scoped reply has been applied — a per-action bucket's stale contents must not clobber it. Ack-shaped (`code`-stamped) `didReceiveGlobalSettings` frames that carry settings are exempt from the ack drop-filter. Finally, plugin-initiated **writes are gated until the first reply** (Ulanzi's own RCA "root cause 2"): before it, the deck-core cache holds schema defaults only, and a full-snapshot write would erase stored passthrough keys (key bindings, `_lastSeenVersion`) — the latest write is buffered, discarded when the reply arrives (deck-core re-writes a fresh snapshot anyway), or flushed after a 30 s timeout on hosts that never answer reads.
- **Public exports** — besides the two classes, `encodeContext` / `decodeContext` / `normalizeFrame` / `parseConnectionParams` (and `PLUGIN_UUID`) are exported from `src/index.ts` — useful for tests and PI-bridge work.

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
| `sendToPlugin` (openUrl marker)                           | `openUrl` (global event)     | url in `payload.url` — see below                           |
| `run` / `setactive` / acks                                | (ignored)                    |                                                            |

Frames with `code` set and no `cmdType === "REQUEST"` are ack/responses and are dropped — except a `didReceiveGlobalSettings` that carries settings, which is a request reply the client must keep (#868).

### Per-context settings cache

Ulanzi only carries settings on `add` / `paramfromapp`; `keydown` / `keyup` / `dial*` frames omit them. The client caches the latest settings per context and **backfills** press/dial events before routing — otherwise actions would fire with empty settings. The cache is dropped on `clear`.

### PI markers (synthesized)

UlanziStudio has no host-generated "PI appeared" event. The Ulanzi PI bridge (in `@iracedeck/pi-components`) sends a `sendToPlugin` marker (`payload.event === "propertyInspectorDidAppear"`) on connect; the client normalizes that into the `propertyInspectorDidAppear` global event so `onPropertyInspectorDidAppear` (e.g. audio-device re-enumeration) works.

External PI links use the same relay (#845): UlanziStudio ignores `openurl` sent on the PI socket but honours it from the plugin socket, so the bridge translates sdpi's `openUrl` event into a `sendToPlugin` openUrl marker, the client normalizes it to an `openUrl` global event (string urls only — no coercion), and the adapter constructor forwards the url via `client.openUrl` after validating it parses as `http:`/`https:` (matching the PI external-link contract, #243; the debug log redacts to origin + path). Any other `sendToPlugin` payload normalizes to nothing.

### Outbound icons

A single `cmd:"state"` frame with `param.statelist:[{ …, type:1, data:<data-uri>, textData:"", showtext:false }]`. Ulanzi has no `setTitle`/`setState`/`setFeedback` — labels travel via the `text`/`showtext` fields, and dial layouts are manifest-declared only. iRaceDeck passes the `data:image/svg+xml,...` URI straight through (raw passthrough; validated on Ulanzi — see the #508 note in `.claude/rules/svg-platform-compatibility.md`).

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `ws` — WebSocket client (UlanziStudio bundles Node.js 20)
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface and `createConsoleLogger`
