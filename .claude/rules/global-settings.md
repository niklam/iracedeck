---
# Global Settings

## Overview

Global settings are plugin-level settings shared across all action instances. Use them for:
- Key bindings that should be consistent across actions
- User preferences that apply to all actions
- Configuration that shouldn't vary per button

## When to Use Global vs Action Settings

| Setting Type | Storage | Use Case |
|-------------|---------|----------|
| **Global** | Plugin-level | Key bindings, user preferences |
| **Action** | Per-instance | Mode selection, action-specific options |

## Property Inspector Usage

### Global Key Binding Input

Use the `global` attribute on `ird-key-binding`:

```html
<sdpi-item label="Lap Timing Key">
  <ird-key-binding setting="keys.blackBox.lapTiming" default="F1" global></ird-key-binding>
</sdpi-item>
```

### Using the Global Key Bindings Partial

For multiple key bindings, use the template partial:

```ejs
<%- include('global-key-bindings', {
  subtitle: 'Black Box Key Bindings',
  keyBindings: require('./data/key-bindings.json').blackBox
}) %>
```

This renders a collapsible "Global Settings" section with all key bindings.

### Other Global Settings

For non-key-binding global settings, use the `global` attribute on sdpi components:

```html
<sdpi-checkbox
  setting="disableWhenDisconnected"
  label="Disable when disconnected"
  global
  default="true"
></sdpi-checkbox>
```

## Action Code Usage

### Reading Global Settings

```typescript
import { getGlobalSettings } from "../shared/index.js";

// In your action handler
const globalSettings = getGlobalSettings();
const keyBinding = globalSettings.keys?.blackBox?.lapTiming;

if (keyBinding?.key) {
  await getKeyboard().sendKeyCombination({
    key: keyBinding.key as KeyboardKey,
    modifiers: keyBinding.modifiers as KeyboardModifier[],
  });
}
```

### GlobalSettingsSchema

Global settings are validated with Zod. The schema is in `stream-deck-plugin-core/src/shared/global-settings.ts`:

```typescript
const GlobalSettingsSchema = z.object({
  disableWhenDisconnected: z.boolean().default(true),
  keys: z.object({
    blackBox: z.object({
      lapTiming: KeyBindingValueSchema.optional(),
      // ... other key bindings
    }).optional(),
  }).optional(),
});
```

## Settings Path Convention

Global key bindings use dot-notation paths:
- `keys.{category}.{action}` - e.g., `keys.blackBox.lapTiming`

This allows organizing key bindings by feature category while keeping them in a flat global settings object.
