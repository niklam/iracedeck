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

## Executing Bindings (Preferred Pattern)

Actions that extend `ConnectionStateAwareAction` use the binding dispatch delegates.
These route to keyboard or SimHub automatically based on the binding type configured in global settings.

```typescript
// Tap (one-shot press + release)
await this.tapBinding("blackBoxLapTiming");

// Hold (press on key down, release on key up)
await this.holdBinding(ev.action.id, "lookDirectionLeft");
await this.releaseBinding(ev.action.id);
```

### When to use hold vs tap
- **Tap** (`tapBinding`): one-shot actions (toggle, cycle, select)
- **Hold** (`holdBinding` + `releaseBinding`): continuous actions (look direction, push-to-talk)

### Declaring active bindings for readiness tracking

Call `setActiveBinding()` in both `onWillAppear` and `onDidReceiveSettings` to declare which
binding the action depends on. The base class automatically tracks readiness (active/inactive
overlay) based on the binding type. Cleanup is automatic via `onWillDisappear`.

```typescript
override async onWillAppear(ev: IDeckWillAppearEvent<Settings>): Promise<void> {
  await super.onWillAppear(ev);
  const key = resolveSettingKey(ev.payload.settings);
  this.setActiveBinding(key);
}

override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<Settings>): Promise<void> {
  await super.onDidReceiveSettings(ev);
  const key = resolveSettingKey(ev.payload.settings);
  this.setActiveBinding(key);
}
```

### Long-press action pattern

The `BindingDispatcher` tracks held bindings per action context internally.
Actions just call `holdBinding`/`releaseBinding`:

```typescript
override async onKeyDown(ev: IDeckKeyDownEvent<Settings>): Promise<void> {
  const settings = Settings.parse(ev.payload.settings);
  const key = GLOBAL_KEYS[settings.direction];
  await this.holdBinding(ev.action.id, key);
}

override async onKeyUp(ev: IDeckKeyUpEvent<Settings>): Promise<void> {
  await this.releaseBinding(ev.action.id);
}

// SAFETY: always release held bindings when action disappears
override async onWillDisappear(ev: IDeckWillDisappearEvent<Settings>): Promise<void> {
  await this.releaseBinding(ev.action.id);
  await super.onWillDisappear(ev);
}
```

### Reference implementations
- Tap action with global key bindings: `packages/actions/src/actions/black-box-selector.ts`
- Cycle action with global key bindings: `packages/actions/src/actions/splits-delta-cycle.ts`
- Long-press (key hold): `packages/actions/src/actions/look-direction.ts`

## Direct Keyboard Access (Plugin-Level Only)

Direct `getKeyboard()` calls are reserved for plugin initialization code and infrastructure,
**not** for action implementations. Actions must use `tapBinding`/`holdBinding`/`releaseBinding`.

```typescript
import { getKeyboard, type KeyboardKey, type KeyboardModifier, type KeyCombination } from "@iracedeck/deck-core";

await getKeyboard().sendKeyCombination(combination);       // tap
await getKeyboard().pressKeyCombination(combination);      // hold
await getKeyboard().releaseKeyCombination(combination);    // release
```

## Plugin Setup for Keyboard Support

When using `getKeyboard()` in a plugin, you MUST:
1. Import `initializeKeyboard` and `initWindowFocus` from `@iracedeck/deck-core`
2. Call `initializeKeyboard()` before registering actions
3. Call `initWindowFocus()` to set up window focusing
4. Register `focusIRacingIfEnabled()` listeners on the adapter before registering actions

```typescript
// plugin.ts
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { focusIRacingIfEnabled, initializeKeyboard, initWindowFocus } from "@iracedeck/deck-core";
import { IRacingNative } from "@iracedeck/iracing-native";

const adapter = new ElgatoPlatformAdapter(streamDeck);
const native = new IRacingNative();

initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),      // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),    // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),      // release only (key release)
);

initWindowFocus(adapter.createLogger("WindowFocus"), () => native.focusIRacingWindow());

// Focus iRacing before any action (BEFORE registering actions)
adapter.onKeyDown(() => focusIRacingIfEnabled());
adapter.onDialDown(() => focusIRacingIfEnabled());
adapter.onDialRotate(() => focusIRacingIfEnabled());

// Then register actions...
```

When the `focusIRacingWindow` global setting is enabled, `focusIRacingIfEnabled()` is called before any action handler fires. This is registered as a listener on the adapter's key/dial events.

## Global Key Bindings (Shared Across Actions)

When key bindings should be shared across all instances of an action type (e.g., black box hotkeys), use global settings instead of per-action settings:

### Property Inspector Setup
```html
<!-- Add 'global' attribute to store in global settings -->
<ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
```

### Plugin Setup
```typescript
// plugin.ts - MUST pass adapter and call BEFORE connect()
import { initGlobalSettings } from "@iracedeck/deck-core";

initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"));
adapter.connect();
```

### Executing Global Key Bindings

Use the binding dispatch delegates from `ConnectionStateAwareAction`:

```typescript
// Declare binding for readiness tracking
this.setActiveBinding("blackBoxLapTiming");

// Execute (routes to keyboard or SimHub automatically)
await this.tapBinding("blackBoxLapTiming");
```

### Logging Key Bindings

Use the shared `formatKeyBinding` utility for human-readable log output:

```typescript
import { formatKeyBinding, parseBinding } from "@iracedeck/deck-core";

const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
if (binding && !isSimHubBinding(binding)) {
  this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
  // Output: "Key combination: Ctrl+Shift+F1" or "Key combination: F3"
}
```

## Reference Implementations
- Binding dispatch (tap): `packages/actions/src/actions/black-box-selector.ts`
- Binding dispatch (cycle): `packages/actions/src/actions/splits-delta-cycle.ts`
- Binding dispatch (hold/release): `packages/actions/src/actions/look-direction.ts`
- Binding dispatcher service: `packages/deck-core/src/binding-dispatcher.ts`

## Do NOT Use
- Hardcoded key mappings in action code
- Direct `getKeyboard()` calls in actions (use `tapBinding`/`holdBinding`/`releaseBinding` instead)

## Cross-Package Sync

When modifying keyboard functionality, changes must be synchronized across all layers:

1. **Native addon** (`iracing-native/src/addon.cc`) — C++ implementation + register in `Init()`
2. **TS wrapper** (`iracing-native/src/index.ts`) — must mirror every native export
3. **Keyboard service** (`deck-core/src/keyboard-service.ts`) — callback types, `IKeyboardService` interface, `KeyboardService` implementation, `initializeKeyboard()` signature
4. **Plugin init** (all plugin `plugin.ts` files: `stream-deck-plugin`, `mirabox-plugin`) — `initializeKeyboard()` call must pass all callbacks
5. **Tests** (`keyboard-service.test.ts`) — must cover all paths (scan code + keysender fallback)
6. **Rules** (`.claude/rules/keyboard-shortcuts.md`, `.claude/rules/plugin-structure.md`) — must reflect the current API
7. **Package CLAUDE.md** (`iracing-native/CLAUDE.md`) — must document all native keyboard functions
