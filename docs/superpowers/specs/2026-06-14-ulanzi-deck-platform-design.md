# Ulanzi Deck platform support — design (issue #508)

**Date:** 2026-06-14
**Issue:** [#508](https://github.com/niklam/iRaceDeck/issues/508) — feat(platform): add Ulanzi Deck device family support
**Branch / worktree:** `niklam/ir-508` → `../ir-508`

## Goal

Add support for Ulanzi Deck devices (D200, D200H, Dial, D200X) to iRaceDeck, parallel to the existing Stream Deck (Elgato) and Mirabox plugins. The AGPL licensing blocker that previously gated this work is **resolved** — the Ulanzi SDK repos are now Apache-2.0, so their public SDK source may be referenced directly (no clean-room constraint).

## Scope (this PR)

**In:** the buildable, unit-testable core platform.

- New package `@iracedeck/deck-adapter-ulanzi` (WebSocket client + `IDeckPlatformAdapter` implementation + file logger + unit tests).
- New package `@iracedeck/iracing-plugin-ulanzi` (plugin entry, rollup build, Ulanzi `manifest.json`, PI connection bridge, platform-features).
- Rules / `CLAUDE.md` updates documenting the new platform.

**Out (deferred until hardware validation):**

- The public website Ulanzi page, download links, action-count bumps.
- Per-action supported-device documentation in `docs/`.
- The `iracedeck-actions` skill device-coverage entries.

**Why deferred:** no Ulanzi hardware exists yet for end-to-end verification (a known unknown in the issue). Shipping user-facing/public content for an unverified platform is premature. Everything in scope can be verified with `pnpm build` + `pnpm test` + lint/format; hardware validation is a separate hand-off step.

## Background — verified Ulanzi wire protocol

All facts below come from reading the Apache-2.0 SDK source (`UlanziTechnology/plugin-common-node` `libs/ulanziApi.js` + `constants.js` + `apiTypes.d.ts`, `plugin-common-html/js/ulanziApi.js`, `UlanziDeckPlugin-SDK` `manifest.md` + `UlanziDeckSimulator`).

### Plugin process connection

- The plugin is the **WebSocket client**; UlanziStudio is the server. It dials `ws://${address}:${port}`.
- `process.argv` layout (after `[node, script]`): `argv[2]=address` (default `127.0.0.1`), `argv[3]=port` (default `3906`), `argv[4]=language` (default `en`). **Simpler than Mirabox's `argv[3/5/7]`.**
- On open the plugin sends a single handshake frame: `{ code: 0, cmd: "connected", uuid: <pluginUuid> }`. There is no separate registration payload (the host already parsed `manifest.json` from disk).
- Plugin UUID must be **exactly 4 dot-segments** under `com.ulanzi.ulanzistudio.*`: `com.ulanzi.ulanzistudio.iracedeck`. Action UUIDs are 5+ segments: `com.ulanzi.ulanzistudio.iracedeck.<action>`.

### Inbound (host → plugin) — dispatched by the `cmd` field

Flat envelope `{ cmd, uuid, key, actionid, ...event-specific }`. The SDK synthesizes a `context` string client-side (it is NOT on the wire):

```text
context = uuid + "___" + key + "___" + actionid    // literal triple underscore
```

| `cmd` | meaning | maps to deck-core |
|---|---|---|
| `add` | key instance appears; saved settings in **`param`** | `onWillAppear` |
| `run` | short-press confirmed (fires keydown → run → keyup) | (ignored — keydown covers tap) |
| `keydown` / `keyup` | press / release | `onKeyDown` / `onKeyUp` |
| `clear` | instance removed; **`param` is an ARRAY** of `{uuid,key,actionid}` | `onWillDisappear` (per item) |
| `dialdown` / `dialup` | dial press / release | `onDialDown` / `onDialUp` |
| `dialrotate` | `rotateEvent ∈ {"left","right","hold-left","hold-right"}` | `onDialRotate` (±1 ticks) |
| `didReceiveSettings` | settings reply | `onDidReceiveSettings` |
| `paramfromapp` / `paramfromplugin` | settings change (settings in `param`) | `onDidReceiveSettings` |
| `didReceiveGlobalSettings` | global settings reply | global-settings callback |
| `sendToPlugin` | PI → plugin message (payload in `payload`) | PI message |

Inbound filter rule: the SDK drops frames where `code` is defined unless `cmdType === "REQUEST"`. `code` is reserved for ack/response frames; host→plugin *events* omit it.

### Outbound (plugin → host)

Base envelope `{ cmd, uuid, key, actionid, ...params }` (uuid/key/actionid decoded from the context).

**Icons — single `cmd:"state"` frame** carrying `param.statelist:[ … ]`, one item per key, differentiated by numeric `type`:

| helper | `type` | image field | encoding |
|---|---|---|---|
| state index | 0 | `state` | manifest `States[]` index |
| base64 data | 1 | `data` | base64 image **(this is what we use)** |
| path | 2 | `path` | root-relative file path |
| gif data | 3 | `gifdata` | base64 GIF |
| gif path | 4 | `gifpath` | gif file path |

A statelist item: `{ uuid, key, actionid, type, data, textData, showtext }`. `textData` is the button label; `showtext` is whether to draw it.

**Critical negative finding:** there is **no `setTitle`, `setState`, `setFeedback`, or `setFeedbackLayout`** in the SDK. Labels travel via the `text`/`textData`/`showtext` fields of the icon setter; dial layouts are manifest-declared only (`Encoder.layout`); runtime layout switching is unsupported.

Other outbound used here: `setSettings` (`{cmd:"setSettings", …, settings}`), `getSettings`, `getGlobalSettings`, `setGlobalSettings`, `openUrl` (`{cmd:"openurl", url, local, param}`), `logMessage` (`{cmd:"logMessage", message, level}`).

### Manifest

`Type:"JavaScript"`, `CodePath:"bin/plugin.js"`, `UUID:"com.ulanzi.ulanzistudio.iracedeck"`, per-action `{ Name, UUID, Icon, States:[{Image}], Controllers:["Keypad"|"Encoder"], Devices:[...], Encoder?:{layout} }`. `Devices` filter values: `D200 | D200H | Dial | D200X` (empty = all; `~Name` excludes). `Software:{MinVersion}`, `OS:[{Platform, MinimumVersion}]`, `ApplicationsToMonitor`.

Plugin folder convention is `com.ulanzi.<plugin>.ulanziPlugin` (verified from the SDK demo `com.ulanzi.analogclock.ulanziPlugin`), distinct from the 4-segment UUID. **To verify against the SDK demo during implementation.**

## Architecture

Two new packages mirroring the Mirabox precedent. **Key structural insight:** Mirabox's VSD host speaks Elgato-style event names (`willAppear`/`keyDown`/`setImage`), so its adapter barely translates. Ulanzi's wire format differs more (`cmd`-dispatch, `param` settings, `state` frames, synthesized context). The clean split is therefore:

- **`UlanziClient` normalizes** Ulanzi frames into the same internal event shape the proven `VSDPlatformAdapter` consumes (`{ event, action(uuid), context, payload:{settings} }` + `onActionEvent`/`onGlobalEvent`).
- **`UlanziPlatformAdapter` is a near-clone** of `VSDPlatformAdapter` — the Ulanzi-specific complexity is isolated in the (heavily unit-tested) client.

This maximizes reuse of the battle-tested adapter logic and concentrates the novel translation in one well-tested module.

### Package 1: `@iracedeck/deck-adapter-ulanzi`

```text
packages/deck-adapter-ulanzi/
├── src/
│   ├── ulanzi-client.ts        # WebSocket client (normalizes Ulanzi ↔ internal events)
│   ├── ulanzi-client.test.ts
│   ├── adapter.ts              # UlanziPlatformAdapter implements IDeckPlatformAdapter
│   ├── adapter.test.ts
│   ├── adapter.log-level.test.ts
│   ├── file-logger.ts          # FileSink + withFileSink (port of Mirabox's, identical)
│   ├── file-logger.test.ts
│   ├── action-uuid.ts          # canonical ↔ Ulanzi UUID mapping
│   ├── action-uuid.test.ts
│   └── index.ts
├── package.json                # deps: @iracedeck/deck-core, @iracedeck/logger, ws
├── tsconfig.json
└── CLAUDE.md
```

**`ulanzi-client.ts`** — `UlanziClient`:
- `parseConnectionParams()`: `address = argv[2] ?? "127.0.0.1"`, `port = argv[3] ?? "3906"`, `language = argv[4] ?? "en"`.
- `connect()`: dynamic `import("ws")`, dial `ws://${address}:${port}`, on open send `{ code: 0, cmd: "connected", uuid: pluginUuid }`, then `requestGlobalSettings()`.
- Inbound `onmessage`: parse JSON, drop frames with `code` defined && `cmdType !== "REQUEST"`, synthesize `context`, normalize `cmd` → internal event name + `payload.settings` (from `param`), route to `onActionEvent`/`onGlobalEvent`. `clear` fans out per `param[]` item.
- `dialrotate` → ticks: `left`/`hold-left` → `-1`, `right`/`hold-right` → `+1` (carried in the normalized `payload.ticks`).
- No reconnect — on `close`, `onClose()` (default `process.exit(0)`), host relaunches. (Mirabox parity.)
- Outbound `setImage(context, dataUri, title?)`: decode context, send `{ cmd:"state", uuid, key, actionid, param:{ statelist:[{ uuid, key, actionid, type:1, data: dataUri, textData:"", showtext:false }] } }`. **`showtext:false`** because the title is baked into the icon SVG by the icon pipeline — Ulanzi must not draw its own duplicate label.
- Outbound `setSettings`/`requestGlobalSettings`/`setGlobalSettings`/`openUrl` mirror the VSD client, retargeted to Ulanzi `cmd`s.

**`adapter.ts`** — `UlanziPlatformAdapter`: structurally identical to `VSDPlatformAdapter` (constructor with `logDir` file logging + mutable `setLogLevel`; `registerAction` wiring `onActionEvent` for each normalized event; `onKeyDown`/`onDialDown`/`onDialRotate` broadcast callbacks fired before per-action handlers; `onDidReceiveGlobalSettings`/`getGlobalSettings`/`setGlobalSettings`; `onApplicationDidLaunch`/`Terminate`; `onPropertyInspectorDidAppear`; `openUrl`; `connect`). The `UlanziActionContext.setImage` forwards to the client; `setTitle` is a **no-op** (title baked into SVG; Ulanzi has no setTitle); `isKey()` defaults to Keypad (see known unknown #2).

**`file-logger.ts`** — `FileSink` + `withFileSink`, ported verbatim from Mirabox (the Ulanzi host likewise discards plugin stdout; `<plugin>/log/<YYYY.M.D>.log` keeps the debug-toggle support log working).

**`action-uuid.ts`** — Ulanzi forces the `com.ulanzi.ulanzistudio.*` UUID namespace, but iRaceDeck actions export canonical `com.iracedeck.sd.core.<name>` UUID constants. `toUlanziActionUuid(coreUuid)` rewrites the `com.iracedeck.sd.core` prefix → `com.ulanzi.ulanzistudio.iracedeck`; `ULANZI_PLUGIN_UUID` constant. The plugin registers each action under its Ulanzi UUID and the manifest declares the same — actions stay untouched.

### Package 2: `@iracedeck/iracing-plugin-ulanzi`

```text
packages/iracing-plugin-ulanzi/
├── src/
│   ├── plugin.ts               # entry — init order identical to Mirabox, UlanziPlatformAdapter
│   └── shared/window-focus.ts  # duplicated (same as Mirabox today)
├── com.ulanzi.iracedeck.ulanziPlugin/   # (folder name to verify vs SDK demo)
│   ├── manifest.json           # Ulanzi format
│   ├── bin/ (gitignored)       # rollup output + emitted package.json + config.json
│   ├── ui/                     # compiled PI HTML + sdpi-components.js + pi-components.js + ulanzi PI shim
│   ├── imgs/actions|plugin/    # copied icons (gitignored)
│   └── assets/audio/           # processed audio (gitignored)
├── rollup.config.mjs           # copy of Mirabox's, platform "ulanzi"
├── platform-features.json      # conservative (mirror Mirabox) until hardware says otherwise
├── package.json
├── tsconfig.json
├── .gitignore
└── CLAUDE.md
```

- **`plugin.ts`** — identical initialization order to `iracing-plugin-mirabox/src/plugin.ts` (config → adapter (with log dir) → debug-logging + setup-warning appliers → SDK → event bus → sim-events translator → keyboard → clipboard → audio → scenario engine → `registerPitCrew(...)` with the full per-callout live-read closure list → device/voice/name pushers → window focus → register actions (under Ulanzi UUIDs via `toUlanziActionUuid`) → global settings → SimHub → binding dispatcher → app monitor → elevation probe → `connect()`). Only the adapter type and action-UUID mapping differ.
- **`rollup.config.mjs`** — copy of Mirabox's: SVG import plugin, feature-flag replace, `piTemplatePlugin`, asset copy (icons + PI browser assets), audio processing, externals (`@iracedeck/audio-native`, `@iracedeck/iracing-native`, `yaml`, `keysender`, `ws`), `emit-module-package-file`, `emit-plugin-config` (`platform: "ulanzi"`), `inlineDynamicImports`, terser. The `stripHtmlLangPlugin` (a VSD quirk) is retained only if Ulanzi's QWebEngineView needs it — Ulanzi PI is Chromium-based, so it likely does **not**; decide during implementation. A new rollup step copies the **Ulanzi PI shim** into `ui/`.
- **`manifest.json`** — Ulanzi format, generated from the same action set as the Mirabox manifest. Keypad-only and Keypad+Encoder actions map their `Controllers` accordingly; dial actions get an `Encoder.layout` (built-in `$UA1`). `Devices: []` (all models) unless an action is dial-only. **Generation approach to confirm vs how the Mirabox manifest is maintained** (hand-authored vs scripted).
- **`platform-features.json`** — start conservative, mirroring Mirabox (`svgFilters/Masks/Patterns:false`, `borderGlow:false`), since the device-side SVG renderer is unverified. Revisit after hardware test.

## Icon encoding decision — raw SVG data-URI passthrough

iRaceDeck's icon pipeline produces `data:image/svg+xml,<urlencoded svg>` URIs (title baked in). Per the approved decision, the adapter sends this **string straight through** as the `data` field of a `type:1` state frame, betting on the device rendering SVG (the issue's stated assumption). No new dependency, no rasterization. **Risk + fallback:** if hardware shows the device does not render SVG data-URIs, the change is localized to `UlanziClient.setImage` — swap to rasterize SVG → PNG base64 (e.g. `@resvg/resvg-js`). Documented as known unknown #1.

## PI connection bridge — WebSocket-translating shim

**Investigation findings.** `sdpi-components.js`'s only integration seam is the global `window.connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo)`. When called, sdpi opens its **own** `ws://localhost:{inPort}` and speaks the **Elgato wire protocol hard-coded** on it (outbound `{event, context, payload, action}`; inbound switched on `didReceiveSettings`/`didReceiveGlobalSettings`/`sendToPropertyInspector`). The transport is **not** injectable, and the built-in `sdpi-*` web components use sdpi's internal client — so replacing `window.SDPIComponents` wholesale does **not** work (it would leave the built-in components unconnected). All custom `ird-*` components ride `window.SDPIComponents.useSettings`/`useGlobalSettings`, which are satisfied automatically once sdpi's client connects. Elgato **and** Mirabox both rely on the **host** calling `connectElgatoStreamDeckSocket`; Ulanzi does not (its PI reads URL params and speaks the `cmd` protocol).

**Design — `ulanzi-pi-bridge.js`** (a small browser shim):

1. **Monkeypatch `window.WebSocket`** with a bridge class that mimics the WebSocket API (`send`/`onopen`/`onmessage`/`onclose`/`onerror`/`readyState`) but internally opens a **native** socket to the real Ulanzi server `ws://{address}:{port}` (address/port from the PI page URL params — it ignores sdpi's hard-coded `localhost` and uses the real address). It translates frames both ways:
   - **Outbound (sdpi Elgato → Ulanzi):** `{event:"getGlobalSettings"}` → `{cmd:"getGlobalSettings", uuid, key, actionid}`; `setGlobalSettings`/`getSettings`/`setSettings`/`sendToPlugin` likewise. sdpi's Elgato registration frame is swallowed (the bridge already sent Ulanzi's `{code:0, cmd:"connected", uuid, actionid, key}` on open).
   - **Inbound (Ulanzi → sdpi Elgato):** `{cmd:"didReceiveGlobalSettings", …}` → `{event:"didReceiveGlobalSettings", payload:{settings}}`; `paramfromapp`/`didReceiveSettings` → `{event:"didReceiveSettings", …}`; `sendToPropertyInspector` likewise.
2. **On `window.load`** (after `sdpi-components.js` has redefined the global), read the URL params, synthesize Elgato-shape `info`/`actionInfo` JSON, and call `window.connectElgatoStreamDeckSocket(port, context, registerEvent, info, actionInfo)` where `context = uuid + "___" + key + "___" + actionid`. sdpi stores `propertyInspectorUUID = context` and uses it as the outbound `context`, so the bridge can decode it back to `{uuid, key, actionid}` for outbound Ulanzi frames; `actionInfo.action` carries the action UUID.

**Where it lives.** Source in `@iracedeck/pi-components` (built to `browser/ulanzi-pi-bridge.js`, unit-tested with the existing vitest setup). The pure frame-translation functions (`elgatoToUlanzi` / `ulanziToElgato`) carry the testable logic; the WebSocket glue is thin. The Ulanzi plugin's rollup copies it into `ui/` and a post-generation step inserts `<script src="ulanzi-pi-bridge.js"></script>` before `sdpi-components.js` in each `ui/*.html` (keeps the shared partials untouched — mirrors how Mirabox's `stripHtmlLangPlugin` post-processes generated HTML).

## Known unknowns (flagged, not blocking)

1. **Device-side SVG rendering.** Betting on SVG data-URI passthrough. Fallback: rasterize → PNG base64 (one-function change in `UlanziClient.setImage`).
2. **Keypad-vs-Encoder detection at `add`.** The simulator's `add` frame carries no controller field. Default `isKey()` → Keypad; read a `controller`/`device` field if a real device sends one; dial *input* events route correctly regardless. Encoder-specific *rendering* (dial slot feedback) is limited — see #4.
3. **PI-shim fidelity.** Cannot be fully verified without UlanziStudio. Frame translation is unit-tested; behavior validated on hardware.
4. **D200X dial custom feedback layouts.** No SDK `setFeedback`/`setFeedbackLayout` method exists. Dial *input* (rotate/press) is supported; rich dial-slot display is deferred. Dial slots fall back to the standard key image.
5. **Plugin folder / manifest naming.** Verify `com.ulanzi.<plugin>.ulanziPlugin` folder + 4-segment UUID against the SDK demo during implementation.

## Testing strategy (no hardware)

- **Unit tests** (vitest) for: `UlanziClient` frame parse/normalize (every `cmd`), context encode/decode, `clear` array fan-out, `dialrotate` → ticks, outbound `state` frame shape, handshake; `UlanziPlatformAdapter` event translation + log-level; `action-uuid` mapping; `file-logger` (port of Mirabox's tests); PI-shim frame translation.
- **Build:** `pnpm build` (tsc across all packages + rollup plugin bundle) — catches type-level issues vitest's esbuild path misses.
- **Lint/format:** `pnpm lint:fix` + `pnpm format:fix`.
- **Hand-off:** hardware validation (rendering, PI behavior, dial, per-device action availability) is a separate manual step for the maintainer once a D200/D200X is available.

## Affected artifacts / docs (in scope)

- New `packages/deck-adapter-ulanzi/CLAUDE.md` + `packages/iracing-plugin-ulanzi/CLAUDE.md`.
- Root `.claude/CLAUDE.md` package list — add both new packages.
- `.claude/rules/plugin-structure.md` — Ulanzi naming conventions + manifest/connection notes.
- `.claude/rules/svg-platform-compatibility.md` — Ulanzi rendering-engine row (Chromium PI / device renderer unknown).
- `.claude/rules/platform-feature-flags.md` — note the third platform consuming the flags.
- `README.md` — only if it enumerates platforms/plugins (verify; update if so).

## Out of scope

- Ulanzi system-call surface (`openView`, `selectFileDialog`, …) — unused by any iRaceDeck action.
- i18n via Ulanzi `localeCode` — iRaceDeck is English-only.
- Public website page, action-count bumps, per-action device docs, skill device-coverage — deferred to post-hardware-validation.
