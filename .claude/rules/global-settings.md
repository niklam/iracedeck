---
# Global Settings

## Overview

Global settings are plugin-level settings shared across all action instances. Use them for:
- Key bindings that should be consistent across actions (keyboard or SimHub)
- User preferences that apply to all actions
- SimHub connection configuration (host/port)

## When to Use Global vs Action Settings

| Setting Type | Storage | Use Case |
|-------------|---------|----------|
| **Global** | Plugin-level | Key bindings, SimHub config, user preferences |
| **Action** | Per-instance | Mode selection, action-specific options |

## Binding Types

Global settings support two binding types via a discriminated union:

```typescript
// Keyboard binding (type defaults to "keyboard" for backward compatibility)
type KeyBindingValue = {
  type: "keyboard";
  key: string;
  modifiers: string[];
  code?: string;
  displayKey?: string;
};

// SimHub Control Mapper role binding
type SimHubBindingValue = {
  type: "simhub";
  role: string;
};

// Union type
type BindingValue = KeyBindingValue | SimHubBindingValue;

// Type guard
isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue
```

## Property Inspector Usage

### Global Key Binding Input

Use the `global` attribute on `ird-key-binding`. Users can switch between Keyboard
and SimHub modes via a dropdown on each binding:

```html
<sdpi-item label="Lap Timing Key">
  <ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
</sdpi-item>
```

### Using the Global Key Bindings Partial

For multiple key bindings, use the template partial:

```ejs
<%- include('global-key-bindings', {
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

### Executing Bindings (Preferred)

Actions extending `ConnectionStateAwareAction` use binding dispatch delegates:

```typescript
// Declare active binding for readiness tracking
this.setActiveBinding("blackBoxLapTiming");

// Execute (routes to keyboard or SimHub automatically)
await this.tapBinding("blackBoxLapTiming");
await this.holdBinding(ev.action.id, settingKey);
await this.releaseBinding(ev.action.id);
```

### Reading Global Settings Directly

```typescript
import { getGlobalSettings, parseBinding, isSimHubBinding } from "@iracedeck/deck-core";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
// Returns KeyBindingValue | SimHubBindingValue | undefined
```

### Subscribing to Changes

```typescript
import { onGlobalSettingsChange } from "@iracedeck/deck-core";

const unsubscribe = onGlobalSettingsChange((settings) => {
  // React to settings changes
});
// Call unsubscribe() to clean up
```

### GlobalSettingsSchema

Global settings are validated with Zod. The schema is in `deck-core/src/global-settings.ts`:

```typescript
const GlobalSettingsSchema = z.object({
  disableWhenDisconnected: z.boolean().default(true),
  focusIRacingWindow: z.boolean().default(false),
  simHubHost: z.string().default("127.0.0.1"),
  simHubPort: z.coerce.number().min(1).max(65535).default(8888),
}).passthrough();
```

The `.passthrough()` allows dynamic key binding properties (e.g., `blackBoxLapTiming`, `lookDirectionLeft`) without declaring them explicitly in the schema.

## Settings Key Convention

Global key bindings use flat key names:
- `blackBoxLapTiming`, `blackBoxFuel`, `lookDirectionLeft`, etc.

Global settings use flat key names (e.g., `blackBoxLapTiming`), not nested paths.
