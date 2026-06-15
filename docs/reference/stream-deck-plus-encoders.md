# Stream Deck+ Encoders & Touchscreen Reference

Authoritative reference for how Stream Deck+ dials (encoders) and the LCD touch strip actually work, plus the verified state of Mirabox knob/touch support. Produced for issue #640 as the foundation for rebuilding dial support; researched against the official Elgato SDK docs/schemas/Node SDK (v2.1.0, 2026-06-11) and the Mirabox Stream Dock plugin SDK. Project-facing conventions live in `.claude/rules/encoders-and-touchscreen.md`.

**Current project state (rebuild begun, #681):** the dial-support rebuild has started. `fuel-dial` is the first/reference dial action — Elgato declares `["Keypad", "Encoder"]` with a custom touch layout (`com.iracedeck.sd.core.sdPlugin/layouts/fuel-dial.json`) and `setFeedback` wiring; Mirabox declares `["Keypad", "Knob"]` with no layout/feedback. deck-core now carries `IDeckActionContext.isDial/setFeedback/setFeedbackLayout`, `IDeckTouchTapEvent` + `onTouchTap`, and the `DeckFeedbackPayload` model (`feedback-types.ts`); the Elgato adapter bridges these to `DialAction` and the Mirabox adapter no-ops feedback. Project-facing conventions and the gating rules live in `.claude/rules/encoders-and-touchscreen.md`; the reference action is `packages/iracing-actions/src/actions/fuel-dial/fuel-dial.ts`.

## 1. Hardware reality

### Elgato devices with encoders

| Device | Type id | Keys | Dials | Touch strip |
| ------ | ------- | ---- | ----- | ----------- |
| Stream Deck + | 7 | 8 LCD keys | 4 (360° rotation + push) | 800×100 px (108×14 mm) |
| Stream Deck + XL | 13 | 36 LCD keys | 6 (rotation + push) | yes, wider |
| Stream Deck Studio | 10 | 32 LCD keys | 2 (rotation + push) | — |

- The touch strip is divided per dial: **each encoder action renders a 200×100 px slot**, regardless of device. Total strip width scales with dial count.
- Physical gestures: dial **rotate**, dial **press/release**, strip **tap**, strip **long touch** (delivered as `touchTap` with `hold: true`), and strip **swipe**. Swipe is consumed by the Stream Deck app for page switching and is **never delivered to plugins** — there is no swipe event in the SDK.
- Stream Deck Neo (type 9) has 2 capacitive touch points and an info bar, but **neither is exposed to plugins** — the dial/touch APIs below are exclusive to encoder-equipped devices.

### Mirabox Stream Dock devices

| Device | Keys | Knobs | Touchscreen |
| ------ | ---- | ----- | ----------- |
| 293 / 293S / 293V3 | 15 LCD keys | none | 293S adds a read-only "Information" area |
| N3 | 6 LCD keys + 3 buttons | 3 (1 large, 2 small; infinite rotation, clickable) | no |
| N4 / N4 Pro / N4E | 10 LCD keys | 4 | LCD strip (host-managed: shows knob icons, swipes pages) |
| M18 | 15 LCD keys + 3 buttons | none | no |

The only Mirabox hardware iRaceDeck has been confirmed on is the 293-class (PR #473 added 293S `Information`-area sizing) — i.e. devices **without** knobs.

### Image dimensions (Mirabox)

Neither layer is on the plugin-SDK doc site. Manifest asset sizes come from the Stream Dock **Style Guide**; the runtime per-device sizes the host rasterizes to come from the **Device SDK** `_info`/`_feature` structs.

**Manifest static assets** (`sdk.key123.vip` Style Guide): action/list icon **40×40**, category icon **48×48**, key icon **128×128**, plugin icon **128×128**. These are source assets — the host scales them to each device's physical key size below, so author at 128×128 and let the host downscale.

**Per-device runtime image sizes** (`StreamDock-Device-SDK`, CPP `_info->keyWidth/keyHeight`, `_feature->_2rdScreen*`):

| Device | Main screen | Key image | 2nd-screen key |
| ------ | ----------- | --------- | -------------- |
| N4 / N4 Pro | 800×480 | 112×112 | 176×112 (4 keys, press-only) |
| 293V3 | 800×480 | 112×112 | — |
| N1 | 480×854 | 96×96 | 64×64 |
| M3 | 854×480 | 96×96 | — |
| XL | 1024×600 | 80×80 | — |
| N3 V2 | 320×240 | 64×64 | — |
| M18 | 480×272 | 64×64 | — |
| K1 Pro | — | 64×64 | — |

The "2nd-screen key" column is the N4-class touch strip in its **secondary-screen-buttons** interpretation (hardware keys 1–4 / logical `KEY_11`–`KEY_14`, **press events only**) — see §8 for why this never reaches a WebSocket plugin.

## 2. Manifest schema (Elgato)

From the official schemas repo (`elgatosf/schemas`, `src/streamdeck/plugins/manifest/latest.ts`):

- **`Controllers`** (per action): array of `"Keypad"` and/or `"Encoder"`, unique items. An action without `"Encoder"` cannot be assigned to a dial. No documented default — declare it explicitly.
- **`Encoder`** object (per action):
  - `Icon` — image path, extension omitted; PNG/SVG 72×72 + 144×144 (@2x). Shown in the app's circular dial canvas. User-overridable.
  - `background` (lowercase) — image path, extension omitted; PNG/SVG 200×100 + 400×200 (@2x). Drawn on the touch strip behind the layout. User-overridable.
  - `layout` (lowercase) — a pre-defined layout id (`$X1`, `$A0`, `$A1`, `$B1`, `$B2`, `$C1`) or a relative path to a custom layout `.json` inside the plugin folder. No documented default — set it explicitly.
  - `StackColor` — hex color shown in the app when the action is the current member of a user-created Dial Stack.
  - `TriggerDescription` — object with optional **PascalCase** fields `Rotate`, `Push`, `Touch`, `LongTouch`; shown to the user in the app's action configuration UI.
- **Version floor:** encoder manifest support shipped in Stream Deck 6.0; `setTriggerDescription` needs 6.4; the current schema toolchain accepts `Software.MinimumVersion` `"6.4"`–`"7.4"`.

### Mirabox manifest differences

The Stream Dock plugin SDK (sdk.key123.vip) accepts `Controllers` values `"Keypad"`, `"Knob"`, `"Information"`, `"SecondaryScreen"` — **`"Encoder"` is not recognized; use `"Knob"`**. The official docs define **no** `Encoder`/`Knob` config block, no layouts, and no `TriggerDescription`; Mirabox's own first-party knob plugins ship `"Controllers": ["Knob"]` with no block at all. `SecondaryScreen` appears in the manifest docs but has **zero usages** across all of MiraboxSpace and **delivers no plugin input events** — the SDK's TypeScript handler interface (`_streamdock.d.ts`) defines handlers only for `keyDown`/`keyUp`/`touchTap`/`dialDown`/`dialUp`/`dialRotate`, with no SecondaryScreen event; the N4 secondary-screen touch is a **host-app function** (changelog: *"N4 secondary screen touch can choose: scene switching or page switching"*), reachable by a plugin only through the native Device SDK (USB/HID), never the WebSocket. `Information` is view-only (no input events).

## 3. Built-in layout IDs (Elgato)

The item `key` in each layout is exactly what `setFeedback` addresses. Canvas is always 200×100. Rects are `[x, y, w, h]`.

| ID | Name | Items |
| --- | ---- | ----- |
| `$X1` | Icon | `title`: text `[16,10,136,24]`; `icon`: pixmap `[76,40,48,48]` |
| `$A0` | Canvas | `full-canvas`: pixmap `[0,0,200,100]`; `title`: text (zOrder 1); `canvas`: pixmap `[16,34,136,54]` (zOrder 1) |
| `$A1` | Value | `title`; `icon`: pixmap `[16,40,48,48]`; `value`: text `[76,40,108,32]` (right-aligned) |
| `$B1` | Indicator | `title`, `icon`, `value` as `$A1`; `indicator`: bar `[76,74,108,12]` (subtype 4 "Groove") |
| `$B2` | Gradient Indicator | as `$B1` but `indicator` is a gbar with gradient background |
| `$C1` | Double Indicator | `title`; `icon1`/`icon2`: pixmaps; `indicator1`/`indicator2`: bars |

A text item keyed exactly `"title"` is special: the user's PI title settings (font/color/alignment) override the layout's, and `setTitle` updates it. User-set custom title/icon take precedence over plugin-sent values.

## 4. Custom layouts (Elgato)

Schema: `https://schemas.elgato.com/streamdeck/plugins/layout.json`. File shape: `{ "id": string, "items": LayoutItem[] }`, referenced from the manifest (`"layout": "layouts/my-layout.json"`) or switched at runtime via `setFeedbackLayout`.

Common item properties:

- `key` (required, `^[A-Za-z0-9\-_]+$`) — the `setFeedback` key. Immutable at runtime.
- `type` (required) — `"bar" | "gbar" | "pixmap" | "text"`. Immutable.
- `rect` (required) — `[x, y, w, h]` within the 200×100 canvas. Immutable. Out-of-bounds rects make Stream Deck refuse to render the **whole layout**; items with the same `zOrder` must not overlap.
- `enabled` (default `true`), `opacity` (0–1, 0.1 steps), `zOrder` (0–700), `background` (color or gradient string `"0:#ff0000,0.5:yellow,1:#00ff00"`).

Per type: **bar** — `value` (required), `range {min,max}` (default 0–100), `bar_bg_c`, `bar_fill_c`, `bar_border_c`, `border_w`, `subtype` (0 Rectangle, 1 DoubleRectangle, 2 Trapezoid, 3 DoubleTrapezoid, 4 Groove = default); **gbar** — bar plus `bar_h`; **pixmap** — `value` is a plugin-relative path, base64 data URI, or inline SVG string; **text** — `value`, `color`, `alignment` (`center`/`left`/`right`), `text-overflow` (`clip`/`ellipsis`/`fade`), `font {size, weight}`.

## 5. Events the plugin receives

All four share the envelope `{ action, context, device, event, payload }`; the payload carries `controller: "Encoder"`, `coordinates: { column, row }`, and `settings`.

- **`dialRotate`** — `ticks: number` (positive = clockwise, negative = counter-clockwise; **fast rotation coalesces detents, so |ticks| > 1 occurs**) and `pressed: boolean` (rotation happened while the dial was held).
- **`dialDown`** / **`dialUp`** — press/release; no extra payload fields. These replaced `dialPress` (deprecated 6.1, not emitted at all since Stream Deck 6.5).
- **`touchTap`** — `tapPos: [x, y]` **relative to the action's own 200×100 slot** (not the full strip), and `hold: boolean` (the long-touch signal — there is no separate long-touch event).
- **`willAppear`/`willDisappear`** — fire for keys and dials alike; branch on `payload.controller` (`"Keypad" | "Encoder"`). For dials `coordinates.row` is always 0. Encoder actions can never be inside multi-actions (`MultiActionPayload.controller` is hard-typed `"Keypad"`).

Mapping to our abstraction: `deck-core` defines `IDeckDialRotateEvent` (with `ticks`), `IDeckDialDownEvent`, `IDeckDialUpEvent`, and `IDeckTouchTapEvent` (`tapPos`, `hold`) in `packages/deck-core/src/types.ts`, plus the `onTouchTap` handler on `IDeckActionHandler`. The Elgato adapter wires all four (touch via `wrapTouchTapEvent`); the Mirabox adapter wires the dial events but delivers no touch tap (the protocol has no plugin touch strip).

## 6. Commands the plugin sends (Elgato)

- **`setFeedback`** — `{ event, context, payload: { "<itemKey>": <value> } }`. Value is a primitive (`string` for text/pixmap, `number` for bar/gbar) or a partial item object (any mutable properties: `value`, `enabled`, `opacity`, `zOrder`, `background`, bar colors, text styling). `key`/`rect`/`type` are immutable.
- **`setFeedbackLayout`** — `{ payload: { layout: "<$id or relative .json path>" } }`; switch layouts at runtime, then `setFeedback` to populate.
- **`setTriggerDescription`** (6.4+) — `{ payload: { rotate?, push?, touch?, longTouch? } }`. **camelCase** here vs PascalCase in the manifest; empty payload resets to manifest values.
- **`setTitle`** on a dial updates the layout's `title` item (the Node SDK literally implements `DialAction.setTitle` as `setFeedback({ title })`). **`setImage`** on a dial sets the circular dial canvas in the app UI — it does **not** draw on the touch strip; strip imagery goes through a `pixmap` layout item.

### Mirabox commands

The Stream Dock events-sent docs define only `setImage`, `setTitle`, `setSettings`, `get`/`setGlobalSettings` (which is exactly what our `vsd-client.ts` implements). **`setFeedback`/`setFeedbackLayout` do not exist** — Mirabox's own porting guide says to use `setImage` to update knob icons.

## 7. @elgato/streamdeck Node SDK surface (v2.x)

- `SingletonAction` optional handlers: `onDialDown`, `onDialRotate`, `onDialUp`, `onTouchTap` (plus `onKeyDown`/`onKeyUp`, `onWillAppear`/`onWillDisappear` for both controllers).
- `DialAction<T>` (constructed when `willAppear.payload.controller === "Encoder"`): `setFeedback(payload)`, `setFeedbackLayout(layout)`, `setTitle(title)`, `setImage(image)` (app UI canvas), `setTriggerDescription(opts)`.
- Type narrowing: `action.isDial(): this is DialAction<T>` / `action.isKey()` — needed in `onWillAppear` where the action is a union; in `onDialRotate` etc. it is already a `DialAction`.
- Version notes: `@elgato/streamdeck` v2 README requires Node 24 and Stream Deck 7.1+ (`resources` payload field is 7.1+); the underlying encoder protocol features are much older (6.0–6.5).

## 8. Mirabox knobs & touch — the verified answer (#640)

**Question:** do Mirabox knobs/touch actually function for third-party plugins via the VSD Craft / Stream Dock plugin WebSocket protocol?

| Claim | Verdict | Basis |
| ----- | ------- | ----- |
| Protocol defines `dialRotate` (`ticks`, `pressed`), `dialDown`, `dialUp`, `Controllers: ["Knob"]` | **Verified from docs** | Official SDK reference (sdk.key123.vip) + SDK headers |
| Host delivers knob events to WebSocket plugins | **Verified from docs / strongly inferred** | Mirabox's own store-shipped VoiceMeeter and Discord plugins are knob-driven over this exact protocol; a Mirabox collaborator confirmed the shipped Discord knob feature; an independent plugin author reports receiving the events on real hardware |
| Press-and-hold gestures work on knobs | **No (inferred, device-dependent)** | Third-party report: `dialUp` arrives immediately after `dialDown` regardless of physical release; corroborated by Bitfocus Companion's N4 docs ("rotary encoders do not provide individual press and release events" — a hardware limitation) |
| Our adapter's dial wiring is protocol-correct | **Verified from code** | `deck-adapter-mirabox/src/adapter.ts` registers `dialRotate`/`dialDown`/`dialUp`, passes `ticks` through, tracks `controller: "Knob"`; unit-tested against a mocked client |
| Our plugin receives knob events through VSD Craft on real knob hardware | **Unknown — needs hardware test** | All in-repo Mirabox hardware evidence is 293-class (no knobs); no commit/test ever recorded an observed knob event |
| Plugin-drawable touch strip (`touchTap` with position, `setFeedback`, layouts) | **Not supported (verified from docs)** | Absent from the official events docs; zero usages in Mirabox's own plugins; Mirabox's porting guide states `setFeedback`/layouts don't exist and the N4 strip is host-managed (knob icons via `setImage`, built-in swipe paging) |

**On the event names & the native touch bar.** The Mirabox plugin SDK *does* define a `touchTap` handler in its TypeScript defs (`_streamdock.d.ts`), but it carries the key-area payload (`coordinates {column,row}`, **no** `controller` field) — the Stream Deck+-heritage *key tap*, not a strip surface — and is unused/unverified through VSD Craft. `touchBarTap`/`touchBarSlide` (named in a VSDinside blog post) are **not** real protocol events (zero code hits anywhere in MiraboxSpace). The N4 Pro's genuine analog touch bar — absolute `x`/`y` touch points (`EventType.TOUCH_POINT`, `set_touch_bar_callback`) — exists **only** in the native Device SDK (`StreamDockN4Pro`), i.e. USB/HID; it is not exposed over the plugin WebSocket, so iRaceDeck cannot consume it without a different (non-VSD-Craft) integration.

**Practical implication:** Mirabox dial **rotation and press-as-tap** are worth rebuilding — the protocol demonstrably delivers them and our adapter already speaks it. Mirabox **touchscreen feedback should be written off** (no plugin-facing surface exists), and rebuilt dial UX must **not depend on press-and-hold** on Mirabox.

### Hardware-test checklist (needs an N3/N4-class device owner)

1. Can an action declaring `"Knob"` be dragged onto a knob slot in VSD Craft / Mirabox Space, and does a `Knob` config block (layout/TriggerDescription) break anything? (First-party plugins omit the block.)
2. On placement, does the plugin log `willAppear` with `payload.controller: "Knob"`? (Enable `debugLogging`; check `<plugin>/log/<date>.log`.)
3. Rotation: do `dialRotate` events arrive; what is `ticks` per detent; do fast spins coalesce into |ticks| > 1; is `pressed` present?
4. Press: do `dialDown`/`dialUp` arrive, and does `dialUp` fire at physical release or immediately after `dialDown` (hold for 2+ seconds)? This decides whether hold-style dial actions are possible on Mirabox.
5. Does `setImage` on a Knob context render to the N4 LCD strip segment above the knob?
6. Does tapping the LCD strip deliver any event (`touchTap` or otherwise) to the plugin, and with what payload?
7. Regression check on 293S: `Information` contexts still behave as today.

## 9. Implementation patterns & pitfalls for the rebuild

- **Treat `ticks` as a signed delta, not ±1.** Multiply the step size by `ticks`; never count events.
- **Rotate-while-pressed** is native on Elgato via `dialRotate.pressed` — no manual `dialDown` state tracking needed for that. But if `dialUp` also triggers a "click" action, suppress the click when a rotation occurred between down and up.
- **No native dial long-press** exists on Elgato (the trigger vocabulary for the dial is only Rotate/Push) — implement it by timing `dialDown` → `dialUp` yourself. The touchscreen's long-press IS native (`touchTap` with `hold: true`). On Mirabox, do not build long-press at all (see §8).
- **Touch hit-testing**: `tapPos` is relative to the action's 200×100 slot, so hit-test directly against layout item `rect`s. Elgato guideline: interactive touch targets ≥ 35×35 px.
- **Throttle feedback**: official guideline is a maximum of **10 `setFeedback` calls per second** per dial (same as key images). Coalesce telemetry-driven updates.
- **Branch on `controller`** in `willAppear` — an action declaring `["Keypad", "Encoder"]` can be on either surface, and `setImage`/`setFeedback` address different things per surface.
- **Keypad-only actions on dials**: users can wrap them via Stream Deck's "Action Trigger" feature (rotate/press each fire a key action); the plugin just sees normal key events and cannot detect the wrapping.
- **Layout authoring traps**: same-`zOrder` overlap is invalid; one out-of-bounds rect kills the whole layout; `key`/`rect`/`type` are immutable — restructure via `enabled`/`opacity`/`zOrder` or `setFeedbackLayout`; name the user-stylable text item exactly `title`.
- **Platform-agnostic action code**: keep dial behavior in shared `iracing-actions` handlers consuming `IDeck*` events; gate Elgato-only surfaces (touch, feedback layouts) behind platform feature flags per `.claude/rules/platform-feature-flags.md` so the Mirabox bundle never ships dead touch code.

## Sources

- Elgato manifest reference: <https://docs.elgato.com/streamdeck/sdk/references/manifest/>
- Touch strip layout reference: <https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout/>
- Dials guide: <https://docs.elgato.com/streamdeck/sdk/guides/dials/>
- WebSocket plugin events/commands: <https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/>
- WebSocket changelog (6.0/6.1/6.4/6.5 encoder history): <https://docs.elgato.com/streamdeck/sdk/references/websocket/changelog/>
- Devices guide: <https://docs.elgato.com/streamdeck/sdk/guides/devices/>
- Marketplace guidelines (10 Hz cap, 35×35 touch targets): <https://docs.elgato.com/guidelines/stream-deck/plugins/>
- Official schemas: <https://github.com/elgatosf/schemas> (manifest + layout types); layout JSON schema: <https://schemas.elgato.com/streamdeck/plugins/layout.json>
- Official Node SDK v2.1.0 source: <https://github.com/elgatosf/streamdeck>
- Elgato help: SD+ specs <https://help.elgato.com/hc/en-us/articles/10567379685901>, touch strip gestures <https://help.elgato.com/hc/en-us/articles/10567698991629>, Dial Stacks <https://help.elgato.com/hc/en-us/articles/10843581380109>, Action Trigger <https://help.elgato.com/hc/en-us/articles/29655069662609>
- Mirabox Stream Dock SDK: <https://sdk.key123.vip/en/guide/events-received.html>, <https://sdk.key123.vip/en/guide/events-sent.html>, <https://sdk.key123.vip/en/guide/manifest.html>
- Mirabox image sizes — Style Guide (manifest asset sizes 40/48/128): <https://sdk.key123.vip/en/guide/style-guide.html>; changelog (N4 secondary-screen touch = scene/page switching): <https://sdk.key123.vip/en/guide/changelog.html>
- Mirabox SDK + plugins source: <https://github.com/MiraboxSpace/StreamDock-Plugin-SDK>, <https://github.com/MiraboxSpace/StreamDock-Plugins> (VoiceMeeter `gain_adjust.js`, Discord plugin, issue #46); plugin handler set + `touchTap` payload in `SDVueSDK/.../_streamdock.d.ts` (no `SecondaryScreen` event)
- Mirabox Device SDK (per-device key/screen sizes via `_info`/`_feature`; N4 Pro native touch-point API): <https://github.com/MiraboxSpace/StreamDock-Device-SDK>
- VSDinside porting guide (Encoder→Knob, no layouts/setFeedback, dialUp-after-dialDown report): <https://www.vsdinside.com/blogs/blog/porting-stream-deck-plugins-to-stream-dock-m18-a-practical-guide>
- Bitfocus Companion Mirabox surface docs (N3/N4/293V3 hardware, encoder press limitation): <https://companion.free/user-guide/v4.2/surfaces/mirabox-streamdock/>
