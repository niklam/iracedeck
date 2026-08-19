---

# Stream Deck Plugins and Actions

## SDK-First Principle

**ALWAYS use iRacing SDK commands when available** instead of keyboard shortcuts:

- Use `getCommands()` from `@iracedeck/deck-core` (in action code) for SDK operations
- Check `docs/keyboard-shortcuts.md` "Available via SDK" column before implementing
- Only fall back to `getKeyboard().sendKeyCombination()` when SDK doesn't support the feature

Examples:

- Pit service commands → Use `getCommands().pit.*` (SDK supported)
- Chat macros → Use `getCommands().chat.macro()` (SDK supported)
- Black box selection → Use keyboard shortcuts (no SDK support)

## Plugin Package Structure

Each Stream Deck plugin package must have a `.gitignore` file at the package root with:

```gitignore
# Node.js
node_modules/

# Stream Deck files
*.sdPlugin/bin
*.sdPlugin/logs
```

The `bin/` folder contains build output and must not be committed to git.

## Action Locations

- Action implementations live in `packages/iracing-actions/src/actions/`.
- Actions import from `@iracedeck/deck-core` (NOT from `@elgato/streamdeck` or `../shared/index.js`).

Requirements

- All actions must extend `ConnectionStateAwareAction` from `@iracedeck/deck-core`.
- Actions export a UUID constant (e.g., `MY_ACTION_UUID`) — no `@action` decorator.
- Logger is injected via constructor, not created in the action class.
- Event types use `IDeck` prefix: `IDeckWillAppearEvent<T>`, `IDeckKeyDownEvent<T>`, etc.
- Action settings should use Zod schemas when the action has settings.
- Actions must not implement their own global offline handling; offline behavior is handled centrally.
- Actions should implement `onDidReceiveSettings()` to handle settings updates from the Property Inspector.

### CommonSettings

All action settings schemas must extend `CommonSettings` from `@iracedeck/deck-core`:

```typescript
import { CommonSettings } from "@iracedeck/deck-core";

const MyActionSettings = CommonSettings.extend({
  direction: z.enum(["next", "previous"]).default("next"),
});
```

Actions with no custom settings use `CommonSettings` directly.

`CommonSettings` includes:

- `flagsOverlay` (boolean) — flags overlay toggle
- `colorOverrides` (optional object with `backgroundColor`, `textColor`, `graphic1Color`, `graphic2Color`) — per-action color overrides
- `titleOverrides` (optional `TitleOverridesSchema` object) — per-action title overrides (showTitle, showGraphics, titleText, bold, fontSize, position, customPosition)
- `borderOverrides` (optional `BorderOverridesSchema` object) — per-action border settings (enabled, width, color). For toggle actions, pass `borderStateColor` to `assembleIcon()` to override color with state-driven green/red/gray.
- `graphicOverrides` (optional `GraphicOverridesSchema` object) — per-action graphic scaling settings (scaleMode: inherit/default/override, scale: 50-150). Effective for any icon with a parseable `viewBox` — the viewBox dimensions drive the dynamic scaling pipeline.

All fields are automatically available in all action settings schemas.

### Icon Assembly Pattern

Actions use `assembleIcon()` instead of `renderIconTemplate()` + `svgToDataUri()`. This handles the graphic snippet format: extracts artwork, applies colors, generates title text, and wraps in the base template.

```typescript
import {
  assembleIcon,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import myIconSvg from "@iracedeck/icons/my-action/variant.svg";

function generateIcon(settings: MySettings): string {
  const colors = resolveIconColors(myIconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    myIconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    "DEFAULT\nTITLE", // optional: action-specific default text
  );
  const border = resolveBorderSettings(myIconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  return assembleIcon({ graphicSvg: myIconSvg, colors, title, border, graphic });
}
```

The `resolveTitleSettings()` resolution order for each field:

1. `settings.titleOverrides` — per-action override (from Title Overrides PI section)
2. `getGlobalTitleSettings()` — plugin-level global setting (skipped if field is in `<desc>` title `locked` array)
3. `<desc>` title metadata in the SVG — icon default
4. `TITLE_DEFAULTS` (showTitle=true, bold=true, fontSize=9 (doubled to 18 at SVG render), position="bottom")

Icons where the title is integral to the design (e.g., DRS, Push-to-Pass) should declare `"locked":["showTitle","fontSize"]` in their `<desc>` title metadata. See `icons.md` for details.

### Title template variables (#899)

deck-core's `resolveTitleSettings` is a wrapper over icon-composer's pure function: it resolves `{{variable}}` / `{{= expression }}` templates in the **user-entered** `titleOverrides.titleText` via `resolveTitleTemplate` (`getCurrentTemplateContext()` + `resolveTemplate`; empty context when disconnected, so variables render empty and expression parse errors stay verbatim). Action default text and icon `<desc>` titles are never resolved, and a template that resolves to `""` stays empty rather than falling back to the default title. The wrapper also sets `ResolvedTitleSettings.layoutText` to the raw template so `computeGraphicArea` sizes the artwork from the stable configured text shape — a value flipping between empty and non-empty must not make the graphic jump size. Actions get this for free by importing `resolveTitleSettings` from `@iracedeck/deck-core` — never from `@iracedeck/icon-composer` directly.

Live updates are also free: `BaseAction` tracks contexts whose user title contains `{{` (a shared SDK-tick watcher, string-comparing the resolved title and re-running the context's regenerate callback through a 10 Hz `IconUpdateThrottle`). This only works when the action registers `setRegenerateCallback` with a closure that re-runs icon generation against current settings — which the Settings Update Handler Pattern below already requires. Telemetry Display's own `title` setting resolves through the same `resolveTitleTemplate` in its `resolveDisplay`.

### Super Calls

All actions must call `super.onWillAppear(ev)` and `super.onDidReceiveSettings(ev)` in their lifecycle hooks:

```typescript
override async onWillAppear(ev: IDeckWillAppearEvent<MySettings>): Promise<void> {
  await super.onWillAppear(ev);
  // ... action-specific logic
}

override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<MySettings>): Promise<void> {
  await super.onDidReceiveSettings(ev);
  // ... action-specific logic
}
```

This is required for BaseAction features (flag overlay, future common features) to work.

### Settings Update Handler Pattern

Always implement `onDidReceiveSettings()` to respond to Property Inspector changes:

```typescript
override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<MySettings>): Promise<void> {
  await super.onDidReceiveSettings(ev);
  await this.updateDisplay(ev);
}

private async updateDisplay(
  ev: IDeckWillAppearEvent<MySettings> | IDeckDidReceiveSettingsEvent<MySettings>,
): Promise<void> {
  // Update icon, state, etc.
}
```

Call `this.setRegenerateCallback(ev.action.id, () => generateMyIconSvg(settings, this.isBindingMissing(...)))` after `setKeyImage()` in `updateDisplay()` — the callback must re-run icon generation against the action's *current* settings (not close over the already-generated SVG string) — so global-settings changes (colors, title, borders) can re-render the icon later. Registration itself reconciles immediately (issue #642): since `setKeyImage()` awaits the image push before the caller registers the callback, a global-settings arrival that lands during that await is otherwise missed, and `setRegenerateCallback` closes that window by re-running `regenerate()` and pushing the result if it differs from what was stored.

Directional Actions (increase/decrease, cycle)

- Use a `direction` setting key for directional actions.
- For +/- actions use values like `Increase`/`Decrease` or `Up`/`Down` depending on context.
- For cycle actions use `Next`/`Previous`.

## Property Inspector Components

Shared PI components live in `packages/pi-components/src/components/` and are bundled to `pi-components.js` by `packages/pi-components/rollup.config.mjs`.

### Required Files in UI Folder

Each plugin's `ui/` folder MUST contain these files:

- `sdpi-components.js` - Stream Deck Property Inspector components (vendored in `@iracedeck/pi-components/browser/`)
- `pi-components.js` - iRaceDeck custom components for `ird-key-binding`, `ird-color-picker`, etc. (built from `@iracedeck/pi-components`)

**IMPORTANT**: Both files are copied in automatically by each plugin's rollup build from `@iracedeck/pi-components/browser`. You do not copy them manually. Ensure the plugin declares `"@iracedeck/pi-components": "workspace:*"` in `package.json` — pnpm will build the shared package before the plugin. The Property Inspector will fail silently if these files are missing.

### Required Scripts in HTML

Always include both scripts in PI HTML files:

```html
<script src="sdpi-components.js"></script>
<script src="pi-components.js"></script>
```

### Custom Components

**`ird-key-binding`** - Keyboard shortcut or SimHub role picker for configurable bindings:

```html
<sdpi-item label="Key Binding">
  <ird-key-binding setting="keyBinding" default="F1"></ird-key-binding>
</sdpi-item>
```

- `setting` - The settings key name
- `default` - Default key (e.g., "F1", "Ctrl+Shift+A")
- A dropdown lets users switch between Keyboard and SimHub modes
- Keyboard mode stores: `{"type":"keyboard","key":"f1","modifiers":[]}`
- SimHub mode stores: `{"type":"simhub","role":"My Role Name"}`

**`ird-audio-test`** - Preview-playback trigger button. Sends `sendToPlugin { event: "audioPreview", kind }`; the plugin runs the preview itself (`runAudioPreview` in `iracing-actions/src/audio/audio-previews.ts`). Settings-window only since #1003 — the Race Engineer audio controls it serves live there, and a PI's `sendToPlugin` goes to its action instead of the window command handler.

```html
<ird-audio-test preview="radar" label="Test"></ird-audio-test>
```

- `preview` - `"radar" | "voice" | "background"`, the preview to play. Without it the button is inert.
- `label` - Button text (default "Test")

**`ird-audio-device-select`** - Plugin-global audio output device dropdown. Binds to a global setting storing the selected device as a stable `ma_device_id` string (hex-encoded), and populates its options from a second global setting holding the device-list JSON (maintained by the plugin at runtime).

```html
<sdpi-item label="Output Device">
  <ird-audio-device-select
    setting="audioOutputDevice"
    devices="_audioDeviceList"
    default-label="System Default"
  ></ird-audio-device-select>
</sdpi-item>
```

- `setting` - Global setting key holding the selected device id (default: `audioOutputDevice`). Empty string means System Default.
- `devices` - Global setting key holding the device-list JSON (default: `_audioDeviceList`). Payload: `[{ "id": string, "name": string, "isDefault"?: boolean }, …]`
- `default-label` - Label for the empty-id (System Default) option (default: `System Default`)

Persistence is by stable device id, not by enumeration index, so unplugging or reordering devices can't silently repoint the selection at a different device. When a saved id is no longer present in the current list, the component falls back to System Default and writes that fallback back through the bound setting.

**`ird-open-settings`** - The "Open iRaceDeck Settings" button (#992). Sends `sendToPlugin {event:"openSettings"}`, routed per host by `onOpenSettingsRequest` on each concrete adapter. In an action PI it is rendered by `key-bindings-section.ejs`, which closes the section with it (`.ird-open-settings.ird-section-footer`, #1003); `settings.ejs` renders it under its header via `section-header.ejs`'s `openSettings: true` slot. Either way a centred block, never inside an `sdpi-item`.

**`ird-open-folder`** - "Open folder" button for the settings window's Diagnostics card (#993). Sends `sendToPlugin` with `{ event: "openSettingsFolder" }`; the plugin's settings-window command handler reveals its OWN settings-file path in Explorer (`openFolderInExplorer`, `storePath` dep) — the page never supplies a path. Built on the shared `defineSendToPluginButton` factory together with `ird-open-settings`; rendered only under `locals.settingsWindow` in `global-common-diagnostics.ejs`.

```html
<ird-open-folder></ird-open-folder>
<ird-open-folder label="Show in Explorer"></ird-open-folder>
```

**`ird-deck-device-select`** - Settings-window-only picker for which Stream Deck a profile switch targets (#992). Populated from the `_deckDevices` global (the Elgato plugin publishes it like `_audioDeviceList`); page-local, not persisted; auto-selects with one deck. `ird-profile-switch device-from="<select id>"` reads it. `ird-audio-test` accepts a `preview="radar|voice|background"` attribute and, inside the settings window, sends `audioPreview` instead of bumping a per-action field.

**`ird-warnings`** - Global warning banner. Auto-injected at the top of every Property Inspector by `head-common.ejs` (no per-template markup). Subscribes to the `_warnings` global setting and renders one banner per `{ id, level, message }` record. Plugins post/clear warnings with `setWarning`/`clearWarning` from `@iracedeck/deck-core`. See `@.claude/rules/global-settings.md` for the data shape. Do not add `<ird-warnings>` to individual templates — it is injected globally. Two attributes narrow what an instance shows, for a warning that belongs beside one control rather than in the page-top strip: `only="id,…"` renders just those ids and `except="id,…"` renders everything else. Use them **as a pair** — the dedicated instance claims the id, the top strip excludes it — so the banner still appears exactly once per page. The settings-window **open**-failure banner is the one case today (`open-settings.ejs`, #1005) — its page-wide server-failure sibling is named in no filter and shows in the strip like any other warning. It is placed in a shared partial rather than per template, so the rule above still stands for action templates.

**Never** use raw `<button>`, `<select>`, `<input>`, or `<textarea>` in a PI `.ejs`. Use an `sdpi-*` component or introduce a new `ird-*` component in `packages/pi-components/src/components/` if no suitable one exists. The one deliberate exception is the settings window's own page chrome (`settings-window.ejs`, #992: the sidebar tab buttons and the key-binding search/category filter) — page-local UI that binds to no setting, on a page that is not a Property Inspector; every control there that stores a setting is still `sdpi-*`/`ird-*`.

### sdpi-components Library

See `@.claude/rules/sdpi-components.md` for the full component reference (attributes, value types, helpers, communication).

Key pitfalls summarized here for quick reference:

- **`sdpi-checkbox`**: Never use `default="false"` — it renders checked (HTML attribute is truthy string). Omit `default` for unchecked.
- **`sdpi-select`**: Fires `input` events, not `change`. Listen to both + polling fallback for reliable detection. Register the fallback via `window.irdPoll(fn)` — never a raw `setInterval` (see below).
- **Zod booleans**: `z.coerce.boolean()` treats `"false"` as `true`. Use `z.union([z.boolean(), z.string()]).transform(val => val === true || val === "true")`.

### Conditional Visibility in Property Inspector

Use this pattern to show/hide sub-settings based on a mode dropdown. Start hidden with `class="hidden"` and toggle via JavaScript.

Reference implementation: `packages/iracing-actions/src/actions/session-info/session-info.ejs` (shows position/fuel sub-settings only when their mode is selected).

**The polling fallback MUST register on the shared page poller `window.irdPoll(fn)`** (exposed by `pi-components.js`, issue #903) — never a raw `setInterval` in a template script. `irdPoll` runs a single 100 ms interval per PI page and clears it on `pagehide`, so a navigated-away page releases its timer; per-script `setInterval` calls were never cleaned up and leaked the whole document on hosts that retain PI pages (observed as memory/CPU growth in UlanziStudio). Web components that own their own timers (`ird-binding-status`, `ird-black-box-caveat`) must stop them on `pagehide` and resume on `pageshow` in addition to their `disconnectedCallback` cleanup — navigating away never detaches elements, so `disconnectedCallback` alone never fires in that scenario.

sdpi-components are web components. To show/hide elements based on select values:

```html
<sdpi-select id="mode-select" setting="mode" default="direct">
  <option value="direct">Direct</option>
  <option value="next">Next</option>
</sdpi-select>

<sdpi-item id="conditional-item" class="hidden">...</sdpi-item>

<script>
  async function initialize() {
    await customElements.whenDefined("sdpi-select");
    const modeSelect = document.getElementById("mode-select");
    if (modeSelect) {
      updateVisibility(modeSelect.value || "direct");
      modeSelect.addEventListener("change", (ev) => updateVisibility(ev.target.value));
      modeSelect.addEventListener("input", (ev) => updateVisibility(ev.target.value));
      // Polling fallback on the shared page poller — sdpi-select events can be unreliable (#903)
      let lastMode = modeSelect.value || "default";
      window.irdPoll(() => {
        const currentMode = modeSelect.value;
        if (currentMode && currentMode !== lastMode) {
          lastMode = currentMode;
          updateVisibility(currentMode);
        }
      });
    }
  }

  function updateVisibility(mode) {
    const item = document.getElementById("conditional-item");
    if (mode === "direct") item?.classList.add("hidden");
    else item?.classList.remove("hidden");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
</script>

<style>
  .hidden {
    display: none !important;
  }
</style>
```

### Building PI Components

`pi-components.js` is produced by `@iracedeck/pi-components`. Both plugins copy it (and `sdpi-components.js`) into their own `ui/` folder at build time.

```bash
# Build the shared PI bundle only
pnpm --filter @iracedeck/pi-components build

# Or run a workspace build — turbo handles topological order
pnpm build
```

### Global Settings with `ird-key-binding`

Use the `global` attribute to store key bindings in plugin-level global settings (shared across all action instances):

```html
<ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
```

Global settings use flat key names (e.g., `blackBoxLapTiming`), not nested paths.

## Global Settings

Global settings are plugin-level settings shared across all action instances. Use them for:

- Key bindings that should be consistent across all instances of an action type
- Plugin-wide preferences

### Plugin Setup (CRITICAL)

**IMPORTANT**: You MUST pass the platform adapter and the plugin-owned settings store to `initGlobalSettings()`:

```typescript
// plugin.ts
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import {
  createFileSettingsStore,
  getPluginPlatform,
  initGlobalSettings,
  resolveSettingsStorePath,
} from "@iracedeck/deck-core";

// The settings file is the single source of truth (#993)
const settingsStore = createFileSettingsStore({
  path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
  logger: adapter.createLogger("SettingsStore"),
});

// MUST call BEFORE adapter.connect() - handlers must be registered first
// MUST pass the adapter (IDeckPlatformAdapter) and the store
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore);

adapter.connect();
```

### Accessing Global Bindings in Actions (Preferred)

Actions extending `ConnectionStateAwareAction` use binding dispatch delegates that
automatically route to keyboard or SimHub based on the binding type:

```typescript
// Declare which binding this action depends on (for readiness tracking)
this.setActiveBinding("blackBoxLapTiming");

// Execute the binding (routes to keyboard or SimHub automatically)
await this.tapBinding("blackBoxLapTiming");

// For hold/release patterns:
await this.holdBinding(ev.action.id, "lookDirectionLeft");
await this.releaseBinding(ev.action.id);
```

### Direct Global Settings Access (Low-Level)

For cases where the binding dispatcher is not suitable:

```typescript
import { getGlobalSettings, isSimHubBinding, parseBinding } from "@iracedeck/deck-core";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
// binding is KeyBindingValue | SimHubBindingValue | undefined
```

### Common Pitfalls

1. **Settings cache empty right after startup**: expected — `initGlobalSettings()` returns schema defaults and loads the store in the background (the deck host is only asked when there is no file yet). Never read settings straight after the call; gate on `isSettingsStoreReady()` or react in `onGlobalSettingsChange` (see `@.claude/rules/global-settings.md`)
2. **Callback never fires**: Handlers must be registered BEFORE `adapter.connect()`
3. **Wrong adapter instance**: Always pass the `IDeckPlatformAdapter` to `initGlobalSettings(adapter, logger, store)`

## Encoder (Dial) & Touchscreen Support

Dial support is being rebuilt (#681); the Fuel Service dial surface (`fuel-service/fuel-dial-surface.ts`, merged from the former fuel-dial action in #759) is the reference implementation. **Read `@.claude/rules/encoders-and-touchscreen.md` first** — it is the authority for the platform facts and gating rules; the full payload/schema reference is `docs/reference/stream-deck-plus-encoders.md`. The per-action mechanics:

### Manifest

Declare both controllers and a custom touch layout **on the Elgato manifest only** — the Mirabox and Ulanzi manifests stay `"Controllers": ["Keypad"]` for dial-capable actions (#786: dial support there is withheld until verified on real hardware; see `.claude/rules/encoders-and-touchscreen.md` for the shapes to restore when re-enabling):

```jsonc
// Elgato (com.iracedeck.sd.core.sdPlugin/manifest.json)
"Controllers": ["Keypad", "Encoder"],
"Encoder": {
  "layout": "layouts/fuel-service.json",
  "TriggerDescription": { "Rotate": "Adjust fuel to add", "Push": "Toggle / clear / fill fueling", "Touch": "Toggle / clear / fill fueling" }
}

// Mirabox and Ulanzi (separate manifests) — Keypad only, no dial declaration (#786)
"Controllers": ["Keypad"]
```

The custom layout JSON is committed under `<sdPlugin>/layouts/*.json` (Elgato only). Item `key`s (e.g. `title`, `value`, `bar`) are exactly what `setFeedback` addresses — a `bar`/`gbar` item takes a number or object, a `text` item a string, and a `pixmap` item a data-URI string (the Fuel Service dial draws its whole slot as one `pixmap`). See `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/layouts/fuel-service.json`.

### Action handlers

Implement `onDialRotate` / `onDialDown` / `onDialUp` / `onTouchTap` alongside `onKeyDown` (a dial-capable action declaring both controllers receives key events on the keypad surface and dial/touch events on the encoder surface). Branch rendering on the surface:

```typescript
override async onDialRotate(ev: IDeckDialRotateEvent<Settings>): Promise<void> {
  // ticks is a SIGNED DELTA (may be >1 on a fast spin) — scale, never count.
  ctx.target += ev.payload.ticks * step;
}

// Branch surfaces inside render(): isKey() → key image, isDial() → touch-strip feedback
if (ev.action.isKey()) await this.setKeyImage(ev, svg);
if (ev.action.isDial()) await ev.action.setFeedback({ title: "FUEL", value: "65 / 90 L", bar: "data:image/svg+xml,…" });
```

- **Push the touchscreen** with `ev.action.setFeedback({...})` (keyed by layout item `key`, values typed by `DeckFeedbackPayload`) or switch layouts at runtime with `ev.action.setFeedbackLayout("layouts/other.json")`.
- **Throttle feedback to ≤ 10 calls/sec per dial** — coalesce a continuous spin into a leading/trailing throttled flush (see the Fuel Service dial surface's `scheduleSend`/`flushSend`).
- **Gate the touch strip** on the compile-time constant `__FEATURE_DIAL_FEEDBACK__` (touch + feedback), not on `isDial()` alone — Mirabox/Ulanzi have no plugin touch strip. Dial press / long-press / push+turn are **not** gated: classify them at `dialUp` with `classifyDialRelease` (a duration comparison ≥ `DIAL_LONG_PRESS_THRESHOLD_MS`, plus a `rotatedWhilePressed` guard so push+turn pre-empts both press actions). No `setTimeout`, no `__FEATURE_DIAL_LONG_PRESS__` — that flag was removed; a knob reporting release instantly just degrades a hold to a short press.

Reference implementation: `packages/iracing-actions/src/actions/fuel-service/fuel-dial-surface.ts` (routed from `fuel-service.ts`, which branches every handler on the surface).

## Per-Mode Communication Method & Binding Status (#612)

Every action mode talks to iRacing through exactly one of three methods — **API** (`getCommands().*`), **key binding** (`tapBinding`/`holdBinding`), or **chat** (`getCommands().chat.sendMessage("#…")`). This is formalized in a per-`(action, mode)` catalog and surfaced in the PI (a status line under the Mode selector) and on the key icon (a centered ⚠️ when a required binding is unset).

When adding or modifying an action, keep these in sync:

1. **Catalog** — add/update the action's entry in `packages/iracing-actions/src/actions/comms-catalog.ts` (one `CommDescriptor` per mode: `api` / `chat`, or a keybind with a constant key, a `keyBy` a secondary setting, multiple keys, or no binding for a fixed key). Use the `keybind` / `keybindBy` / `keybindKeys` / `keybindFixed` helpers. Run `pnpm generate:action-comms` to regenerate `data/action-comms.json`. A freshness test + a cross-check (every keybind key must exist in `key-bindings.json`) guard correctness.
2. **PI status line** — add the shared component under the Mode `<sdpi-item>` in the action's `.ejs`:
   ```ejs
   <% var __comms = require('./data/action-comms.json')['<action-name>']; %>
   <ird-binding-status mode-setting="<%= __comms._meta.modeSetting %>" comms='<%= JSON.stringify(__comms) %>'></ird-binding-status>
   ```
   Use `<%=` (HTML-escaped) for the `comms` attribute, never `<%-`. Display-only / internal actions (session-info, telemetry-display, pit-crew) get no line and no catalog entry.
3. **Icon overlay** — for keybind modes, compute the missing-binding flag **per button context** with the base-class `this.isBindingMissing(<key(s) for this mode's settings>)` — NOT the shared `isActiveBindingMissing()`, which bleeds one button's state onto every button of the action. Reuse the same key expression the action passes to `setActiveBinding`. Pass `bindingMissing` into the icon generator: `assembleIcon({ …, bindingMissing })` for static icons, or `applyBindingWarning(content)` for dynamic-template icons. Compute it fresh inside regenerate-callback closures so a live binding change updates the icon.
4. **Docs** — state the per-mode method in the action docs and on the website action page (see `action-documentation.md` and `website-action-docs.md`).
