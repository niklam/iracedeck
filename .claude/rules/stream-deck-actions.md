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
- `graphicOverrides` (optional `GraphicOverridesSchema` object) — per-action graphic scaling settings (scaleMode: inherit/default/override, scale: 50-150). Only effective when the icon declares `artworkBounds` in its `<desc>` metadata.

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
    "DEFAULT\nTITLE",  // optional: action-specific default text
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

**`ird-audio-test`** - Preview-playback trigger button. Writes `Date.now()` into a hidden `sdpi-textfield` so the action's `onDidReceiveSettings` handler detects the bump and plays the preview.
```html
<div style="display:none;"><sdpi-textfield id="test-radar-field" setting="_testRadarVolume"></sdpi-textfield></div>
<ird-audio-test target="test-radar-field" label="Test"></ird-audio-test>
```
- `target` - DOM id of the hidden `sdpi-textfield` to bump
- `label` - Button text (default "Test")

**`ird-audio-device-select`** - Plugin-global audio output device dropdown. Binds to a global setting storing the selected device index, and populates its options from a second global setting that holds the device-list JSON (maintained by the plugin at runtime).
```html
<sdpi-item label="Output Device">
  <ird-audio-device-select setting="audioOutputDevice" devices="_audioDeviceList" default-label="System Default"></ird-audio-device-select>
</sdpi-item>
```
- `setting` - Global setting key holding the selected device index (default: `audioOutputDevice`)
- `devices` - Global setting key holding the device-list JSON (default: `_audioDeviceList`). Payload: `[{ "index": number, "name": string, "isDefault"?: boolean }, …]`
- `default-label` - Label for the `-1` (System Default) option (default: `System Default`)

**Never** use raw `<button>`, `<select>`, `<input>`, or `<textarea>` in a PI `.ejs`. Use an `sdpi-*` component or introduce a new `ird-*` component in `packages/pi-components/src/components/` if no suitable one exists.

### sdpi-components Library

See `@.claude/rules/sdpi-components.md` for the full component reference (attributes, value types, helpers, communication).

Key pitfalls summarized here for quick reference:
- **`sdpi-checkbox`**: Never use `default="false"` — it renders checked (HTML attribute is truthy string). Omit `default` for unchecked.
- **`sdpi-select`**: Fires `input` events, not `change`. Listen to both + polling fallback for reliable detection.
- **Zod booleans**: `z.coerce.boolean()` treats `"false"` as `true`. Use `z.union([z.boolean(), z.string()]).transform(val => val === true || val === "true")`.

### Conditional Visibility in Property Inspector

Use this pattern to show/hide sub-settings based on a mode dropdown. Start hidden with `class="hidden"` and toggle via JavaScript.

Reference implementation: `packages/iracing-actions/src/actions/session-info/session-info.ejs` (shows position/fuel sub-settings only when their mode is selected).

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
    // Polling fallback — sdpi-select events can be unreliable
    let lastMode = modeSelect.value || "default";
    setInterval(() => {
      const currentMode = modeSelect.value;
      if (currentMode && currentMode !== lastMode) {
        lastMode = currentMode;
        updateVisibility(currentMode);
      }
    }, 100);
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
.hidden { display: none !important; }
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

**IMPORTANT**: You MUST pass the platform adapter to `initGlobalSettings()`:

```typescript
// plugin.ts
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { initGlobalSettings } from "@iracedeck/deck-core";

// MUST call BEFORE adapter.connect() - handlers must be registered first
// MUST pass the adapter (IDeckPlatformAdapter)
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"));

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
import { getGlobalSettings, parseBinding, isSimHubBinding } from "@iracedeck/deck-core";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
// binding is KeyBindingValue | SimHubBindingValue | undefined
```

### Common Pitfalls

1. **Settings cache empty on startup**: `initGlobalSettings()` must call `adapter.getGlobalSettings()` after registering the listener to fetch initial values
2. **Callback never fires**: Handlers must be registered BEFORE `adapter.connect()`
3. **Wrong adapter instance**: Always pass the `IDeckPlatformAdapter` to `initGlobalSettings(adapter, logger)`

## Encoder Support

For Stream Deck+ encoder (dial) support:

### Manifest Configuration
```json
{
  "Controllers": ["Keypad", "Encoder"],
  "Encoder": {
    "layout": "$B1",
    "TriggerDescription": {
      "Rotate": "Description for rotation",
      "Push": "Description for press"
    }
  }
}
```

### Action Handlers
- `onDialRotate(ev)` - Handle rotation. Use `ev.payload.ticks` (positive = clockwise, negative = counter-clockwise)
- `onDialDown(ev)` - Handle press (only if needed)

### Rotation Pattern
```typescript
override async onDialRotate(ev: IDeckDialRotateEvent<Settings>): Promise<void> {
  const settings = MySettings.parse(ev.payload.settings);
  // Clockwise (ticks > 0) = next/increase
  // Counter-clockwise (ticks < 0) = previous/decrease
  const keyData = ev.payload.ticks > 0 ? settings.keyNext : settings.keyPrevious;
  if (keyData?.key) {
    await getKeyboard().sendKeyCombination({ key: keyData.key, modifiers: keyData.modifiers });
  }
}
```
