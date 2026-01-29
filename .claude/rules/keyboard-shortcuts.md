---
# Keyboard Shortcuts & Hotkey Actions

## SDK-First Principle

**ALWAYS prefer iRacing SDK commands over keyboard shortcuts** when both options exist:
- SDK commands are more reliable (no key binding mismatches)
- SDK commands work regardless of user's iRacing key configuration
- Check `docs/keyboard-shortcuts.md` "Available via SDK" column before implementing

Only use keyboard shortcuts when:
- The feature has no SDK support (e.g., black box selection, camera controls)
- The SDK command doesn't provide the needed functionality

## Reference
`docs/keyboard-shortcuts.md` is the authoritative source for iRacing keyboard defaults and SDK availability.

## Key Binding Architecture

**Key bindings are ALWAYS configured via Property Inspector**, not hardcoded in action code:
- Users must be able to customize key bindings to match their iRacing configuration
- Defaults are set in the PI HTML via the `default` attribute
- The action code reads whatever binding the user has configured

## Property Inspector Setup

Always include both script files for key binding support:
```html
<script src="sdpi-components.js"></script>
<script src="pi-components.js"></script>
```

Use the `ird-key-binding` component:
```html
<sdpi-item label="Key Binding">
  <ird-key-binding setting="keyBinding" default="F1"></ird-key-binding>
</sdpi-item>
```

## Zod Schema for Key Bindings

The `ird-key-binding` component stores values as JSON strings. Use this pattern:

```typescript
const KeyBindingSchema = z.object({
  key: z.string(),
  modifiers: z.array(z.string()).default([]),
});

// Transform handles JSON string from PI or already-parsed object
const keyBindingField = z
  .union([z.string(), KeyBindingSchema])
  .transform((val) => {
    if (typeof val === "string" && val) {
      try { return KeyBindingSchema.parse(JSON.parse(val)); }
      catch { return { key: "", modifiers: [] }; }
    }
    return val as z.infer<typeof KeyBindingSchema>;
  });

// Use in settings schema
const MyActionSettings = z.object({
  keyBinding: keyBindingField,
});
```

## Sending Key Combinations

```typescript
import { getKeyboard, type KeyboardKey, type KeyboardModifier, type KeyCombination } from "@iracedeck/stream-deck-shared";

// In action handler
if (settings.keyBinding?.key) {
  const combination: KeyCombination = {
    key: settings.keyBinding.key as KeyboardKey,
    modifiers: settings.keyBinding.modifiers?.length
      ? settings.keyBinding.modifiers as KeyboardModifier[]
      : undefined,
  };
  await getKeyboard().sendKeyCombination(combination);
}
```

## Plugin Setup for Keyboard Support

When using `getKeyboard()` in a plugin, you MUST:
1. Import `initializeKeyboard` in your plugin.ts
2. Call `initializeKeyboard()` before registering actions

```typescript
// plugin.ts
import { initializeKeyboard } from "@iracedeck/stream-deck-shared";

// Initialize keyboard for hotkey actions
initializeKeyboard();

// Then register actions...
```

## Global Key Bindings (Shared Across Actions)

When key bindings should be shared across all instances of an action type (e.g., black box hotkeys), use global settings instead of per-action settings:

### Property Inspector Setup
```html
<!-- Add 'global' attribute to store in global settings -->
<ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
```

### Plugin Setup
```typescript
// plugin.ts - MUST pass SDK instance and call BEFORE connect()
import streamDeck from "@elgato/streamdeck";
import { initGlobalSettings } from "@iracedeck/stream-deck-shared";

initGlobalSettings(streamDeck);
streamDeck.connect();
```

### Reading Global Key Bindings

Use the shared `parseKeyBinding` utility to handle JSON strings from global settings:

```typescript
import {
  getGlobalSettings,
  getKeyboard,
  parseKeyBinding,
  type KeyboardKey,
  type KeyboardModifier,
} from "@iracedeck/stream-deck-shared";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseKeyBinding(globalSettings["blackBoxLapTiming"]);

if (binding?.key) {
  await getKeyboard().sendKeyCombination({
    key: binding.key as KeyboardKey,
    modifiers: binding.modifiers.length > 0
      ? binding.modifiers as KeyboardModifier[]
      : undefined,
  });
}
```

### Logging Key Bindings

Use the shared `formatKeyBinding` utility for human-readable log output:

```typescript
import { formatKeyBinding, parseKeyBinding } from "@iracedeck/stream-deck-shared";

const binding = parseKeyBinding(globalSettings["blackBoxLapTiming"]);
if (binding?.key) {
  this.logger.info("Key sent successfully");
  this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
  // Output: "Key combination: Ctrl+Shift+F1" or "Key combination: F3"
}
```

## Reference Implementation
- Global key bindings: `packages/stream-deck-plugin-core/src/actions/black-box-selector.ts`
- Cycle action with global key bindings: `packages/stream-deck-plugin-core/src/actions/splits-delta-cycle.ts`
- Per-action key bindings: `packages/stream-deck-plugin-hotkeys/src/actions/do-iracing-hotkey.ts`

## Do NOT Use
- `iracing-hotkeys.ts` presets (test plugin only)
- Hardcoded key mappings in action code
