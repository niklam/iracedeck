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

- Action implementations live in `packages/actions/src/actions/`.
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

`CommonSettings` includes `flagsOverlay` (boolean) and `colorOverrides` (optional object with `backgroundColor`, `textColor`, `graphic1Color`, `graphic2Color`). Both are automatically available in all action settings schemas.

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

Shared PI components are in `packages/stream-deck-plugin/src/pi/` and compiled to `pi-components.js`.

### Required Files in UI Folder
Each plugin's `ui/` folder MUST contain these files:
- `sdpi-components.js` - Stream Deck Property Inspector components
- `pi-components.js` - iRaceDeck custom components (for `ird-key-binding`)

**IMPORTANT**: These files must be copied from an existing plugin (e.g., `stream-deck-plugin`) when creating a new plugin. The Property Inspector will fail silently if these files are missing.

### Required Scripts in HTML
Always include both scripts in PI HTML files:
```html
<script src="sdpi-components.js"></script>
<script src="pi-components.js"></script>
```

### Custom Components

**`ird-key-binding`** - Keyboard shortcut picker for configurable hotkeys:
```html
<sdpi-item label="Key Binding">
  <ird-key-binding setting="keyBinding" default="F1"></ird-key-binding>
</sdpi-item>
```
- `setting` - The settings key name
- `default` - Default key (e.g., "F1", "Ctrl+Shift+A")
- Stores value as JSON string: `{"key":"f1","modifiers":[]}`

### sdpi-checkbox Pitfalls

**NEVER use `default="false"`** on `sdpi-checkbox`. HTML attributes are always strings, so `"false"` is truthy and the checkbox will render as checked:

```html
<!-- BAD: checkbox starts checked because "false" is a truthy string -->
<sdpi-checkbox setting="myBool" default="false"></sdpi-checkbox>

<!-- GOOD: omit default entirely — checkbox starts unchecked -->
<sdpi-checkbox setting="myBool"></sdpi-checkbox>
```

**Zod boolean schema**: `z.coerce.boolean()` uses `Boolean(value)`, so `Boolean("false")` === `true`. Use a union+transform instead:

```typescript
// BAD: z.coerce.boolean() — "false" string becomes true
positionShowTotal: z.coerce.boolean().default(false),

// GOOD: explicit string-to-boolean transform
positionShowTotal: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(false),
```

### sdpi-select Event Handling

**IMPORTANT**: `sdpi-select` fires `input` events, NOT standard `change` events. For reliable value change detection, use this pattern:

```javascript
// Listen to both events for maximum compatibility
select.addEventListener("change", handleChange);
select.addEventListener("input", handleChange);

// Polling fallback - sdpi-select events can be unreliable
let lastValue = select.value || "default";
setInterval(() => {
  const currentValue = select.value;
  if (currentValue && currentValue !== lastValue) {
    lastValue = currentValue;
    handleChange();
  }
}, 100);
```

### Conditional Visibility in Property Inspector

Use this pattern to show/hide sub-settings based on a mode dropdown. Start hidden with `class="hidden"` and toggle via JavaScript.

Reference implementation: `stream-deck-plugin/src/pi/session-info.ejs` (shows position/fuel sub-settings only when their mode is selected).

sdpi-components are web components. To show/hide elements based on select values:

```html
<sdpi-select id="mode-select" setting="mode" default="direct">
  <option value="direct">Direct</option>
  <option value="next">Next</option>
</sdpi-select>

<sdpi-item id="conditional-item" class="hidden">...</sdpi-item>

<script>
async function initialize() {
  // Wait for web components to be defined
  await customElements.whenDefined("sdpi-select");

  const modeSelect = document.getElementById("mode-select");
  if (modeSelect) {
    // Initial update
    updateVisibility(modeSelect.value || "direct");

    // sdpi-select fires 'input' events (not 'change'), listen to both for safety
    modeSelect.addEventListener("change", (ev) => {
      updateVisibility(ev.target.value);
    });
    modeSelect.addEventListener("input", (ev) => {
      updateVisibility(ev.target.value);
    });

    // Polling fallback for reliable detection
    let lastMode = modeSelect.value || "direct";
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
  if (mode === "direct") {
    item?.classList.add("hidden");
  } else {
    item?.classList.remove("hidden");
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}
</script>

<style>
.hidden { display: none !important; }
</style>
```

### Building PI Components
```bash
cd packages/stream-deck-plugin
pnpm build:pi
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

### Accessing Global Settings in Actions

Use the shared `parseKeyBinding` and `formatKeyBinding` utilities:

```typescript
import {
  getGlobalSettings,
  getKeyboard,
  parseKeyBinding,
  formatKeyBinding,
  type KeyboardKey,
  type KeyboardModifier,
} from "@iracedeck/deck-core";

// Parse key binding from global settings (handles JSON strings automatically)
const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseKeyBinding(globalSettings["blackBoxLapTiming"]);

if (binding?.key) {
  const success = await getKeyboard().sendKeyCombination({
    key: binding.key as KeyboardKey,
    modifiers: binding.modifiers.length > 0
      ? binding.modifiers as KeyboardModifier[]
      : undefined,
  });

  // Use formatKeyBinding for logging
  if (success) {
    this.logger.info("Key sent successfully");
    this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
  }
}
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
