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
import { getKeyboard, type KeyboardKey, type KeyboardModifier, type KeyCombination } from "../shared/index.js";

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

## Long-Press / Key Hold

For actions that need to hold a key while the button is pressed (e.g., look direction), use `pressKeyCombination()` and `releaseKeyCombination()` instead of `sendKeyCombination()`:

```typescript
// onKeyDown — press and hold
await getKeyboard().pressKeyCombination(combination);

// onKeyUp — release
await getKeyboard().releaseKeyCombination(combination);
```

### When to use hold vs tap
- **Tap** (`sendKeyCombination`): one-shot actions (toggle, cycle, select)
- **Hold** (`pressKeyCombination` + `releaseKeyCombination`): continuous actions (look direction, push-to-talk)

### Long-press action pattern

**IMPORTANT**: Track held keys per action context (`ev.action.id`), not as a single field. A single action class handles all instances of that action type — using a single field causes stuck keys when multiple buttons are pressed concurrently.

```typescript
private heldCombinations = new Map<string, KeyCombination>();

override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
  const combination = this.resolveCombination(ev.payload.settings);
  if (!combination) return;

  const success = await getKeyboard().pressKeyCombination(combination);
  if (success) this.heldCombinations.set(ev.action.id, combination);
}

override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
  const combination = this.heldCombinations.get(ev.action.id);
  if (!combination) return;
  this.heldCombinations.delete(ev.action.id);
  await getKeyboard().releaseKeyCombination(combination);
}

// SAFETY: always release held keys when action disappears
override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
  const combination = this.heldCombinations.get(ev.action.id);
  if (combination) {
    this.heldCombinations.delete(ev.action.id);
    await getKeyboard().releaseKeyCombination(combination);
  }
  await super.onWillDisappear(ev);
}
```

### Reference implementation
- Long-press action: `packages/stream-deck-plugin/src/actions/look-direction.ts`

## Plugin Setup for Keyboard Support

When using `getKeyboard()` in a plugin, you MUST:
1. Import `initializeKeyboard` in your plugin.ts
2. Call `initializeKeyboard()` before registering actions
3. Pass all four scan code callbacks for full functionality (tap, press, release)

```typescript
// plugin.ts
import { initializeKeyboard } from "./shared/index.js";
import { IRacingNative } from "@iracedeck/iracing-native";

const native = new IRacingNative();
initializeKeyboard(
  logger,
  (scanCodes) => native.sendScanKeys(scanCodes),      // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),    // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),      // release only (key release)
);

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
import { initGlobalSettings } from "./shared/index.js";

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
} from "../shared/index.js";

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
import { formatKeyBinding, parseKeyBinding } from "../shared/index.js";

const binding = parseKeyBinding(globalSettings["blackBoxLapTiming"]);
if (binding?.key) {
  this.logger.info("Key sent successfully");
  this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
  // Output: "Key combination: Ctrl+Shift+F1" or "Key combination: F3"
}
```

## Reference Implementation
- Global key bindings: `packages/stream-deck-plugin/src/actions/black-box-selector.ts`
- Cycle action with global key bindings: `packages/stream-deck-plugin/src/actions/splits-delta-cycle.ts`
- Long-press (key hold): `packages/stream-deck-plugin/src/actions/look-direction.ts`

## Do NOT Use
- Hardcoded key mappings in action code

## Cross-Package Sync

When modifying keyboard functionality, changes must be synchronized across all layers:

1. **Native addon** (`iracing-native/src/addon.cc`) — C++ implementation + register in `Init()`
2. **TS wrapper** (`iracing-native/src/index.ts`) — must mirror every native export
3. **Keyboard service** (`stream-deck-plugin/src/shared/keyboard-service.ts`) — callback types, `IKeyboardService` interface, `KeyboardService` implementation, `initializeKeyboard()` signature
4. **Plugin init** (`stream-deck-plugin/src/plugin.ts`) — `initializeKeyboard()` call must pass all callbacks
5. **Tests** (`keyboard-service.test.ts`) — must cover all paths (scan code + keysender fallback)
6. **Rules** (`.claude/rules/keyboard-shortcuts.md`, `.claude/rules/plugin-structure.md`) — must reflect the current API
7. **Package CLAUDE.md** (`iracing-native/CLAUDE.md`) — must document all native keyboard functions
