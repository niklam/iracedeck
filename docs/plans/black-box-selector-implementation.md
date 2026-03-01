# Black Box Selector Action Implementation Plan

## Overview
Implement the Black Box Selector action for the Core plugin that allows users to cycle through or directly select iRacing black box screens via configurable keyboard shortcuts.

## Files to Create/Modify

### 1. Action Implementation
**File:** `packages/stream-deck-plugin/src/actions/black-box-selector.ts`

Create the action class extending `ConnectionStateAwareAction` with:
- **Settings Schema (Zod):**
  ```typescript
  const KeyBindingSchema = z.object({
    key: z.string(),
    modifiers: z.array(z.string()).default([]),
  });

  // Transform to handle JSON string or parsed object from PI
  const keyBindingField = z
    .union([z.string(), KeyBindingSchema])
    .transform((val) => {
      if (typeof val === "string" && val) {
        try { return KeyBindingSchema.parse(JSON.parse(val)); }
        catch { return { key: "", modifiers: [] }; }
      }
      return val as z.infer<typeof KeyBindingSchema>;
    });

  const BlackBoxSelectorSettings = z.object({
    mode: z.enum(["direct", "next", "previous"]).default("direct"),
    blackBox: z.enum([
      "lap-timing", "standings", "relative", "fuel", "tires",
      "tire-info", "pit-stop", "in-car", "mirror", "radio", "weather"
    ]).default("lap-timing"),
    // Key binding for the selected black box (Direct mode) - default set in PI HTML
    keyBinding: keyBindingField,
    // Key bindings for Next/Previous modes - defaults set in PI HTML (empty = user must configure)
    keyNext: keyBindingField,
    keyPrevious: keyBindingField,
  });
  ```
- **Key bindings always come from Property Inspector** - defaults are set in HTML via `default` attribute
- **onKeyDown:** Send keyboard shortcut based on mode/selection using configured bindings
- **onDialRotate:** Handle encoder rotation (next/previous black box)
- **Dynamic icon generation:** Show appropriate icon based on mode and selection

### 2. Plugin Registration
**File:** `packages/stream-deck-plugin/src/plugin.ts`

- Import `BlackBoxSelector` action
- Register with `streamDeck.actions.registerAction(new BlackBoxSelector())`
- Import keyboard initialization from shared package

### 3. Manifest Entry
**File:** `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json`

Add action to the `Actions` array:
```json
{
  "Name": "Black Box Selector",
  "UUID": "com.iracedeck.sd.core.black-box-selector",
  "Icon": "imgs/actions/black-box-selector/icon",
  "Tooltip": "Cycle through or select iRacing black boxes",
  "PropertyInspectorPath": "ui/black-box-selector.html",
  "Controllers": ["Keypad", "Encoder"],
  "Encoder": {
    "layout": "$B1",
    "TriggerDescription": {
      "Rotate": "Next/Previous black box"
    }
  },
  "States": [
    {
      "Image": "imgs/actions/black-box-selector/key",
      "TitleAlignment": "bottom",
      "FontSize": 14
    }
  ]
}
```

### 4. Property Inspector UI
**File:** `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/ui/black-box-selector.html`

Create settings UI with:
- Include both `sdpi-components.js` and `pi-components.js` (for `ird-key-binding`)
- Mode dropdown (Direct, Next, Previous)
- Black Box dropdown (visible when Mode is "Direct") - changes which default key is shown
- Key binding field using `ird-key-binding` component with dynamic default based on black box selection
- Next/Previous key binding fields (visible when Mode is "Next" or "Previous")

**Key insight:** The Property Inspector must dynamically show/hide fields and update defaults based on mode and black box selection. This requires JavaScript in the PI to:
1. Show/hide the black box dropdown based on mode
2. Show the appropriate key binding field based on mode
3. Update the key binding default when black box selection changes

```html
<script src="sdpi-components.js"></script>
<script src="pi-components.js"></script>
...
<!-- Direct mode: black box selector + key binding with dynamic default -->
<sdpi-item label="Black Box" id="blackbox-item">
  <sdpi-select setting="blackBox">
    <option value="lap-timing">Lap Timing</option>
    <!-- ... all 11 options ... -->
  </sdpi-select>
</sdpi-item>
<sdpi-item label="Key Binding" id="keybinding-item">
  <ird-key-binding setting="keyBinding" default="F1"></ird-key-binding>
</sdpi-item>

<!-- Next/Previous modes -->
<sdpi-item label="Next Key" id="keynext-item">
  <ird-key-binding setting="keyNext" default=""></ird-key-binding>
</sdpi-item>
<sdpi-item label="Previous Key" id="keyprevious-item">
  <ird-key-binding setting="keyPrevious" default=""></ird-key-binding>
</sdpi-item>
```

### 5. Icon Template
**File:** `packages/stream-deck-plugin/icons/black-box-selector.svg`

Create SVG template (72x72) with:
- Mustache placeholders for dynamic content
- "BB" label for distinctiveness
- Support for mode-specific icons

### 6. Static Icons (for manifest)
**Directory:** `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/black-box-selector/`

Create:
- `icon.svg` - Action catalog icon
- `key.svg` - Default button icon

## SDK Availability

**Black box selection has NO SDK support** - all entries in `docs/keyboard-shortcuts.md` show "No" for "Available via SDK". Therefore, keyboard shortcuts are the correct implementation approach for this feature.

## Keyboard Mapping Reference

| Black Box | Key | iRacing Setting |
|-----------|-----|-----------------|
| Lap Timing | F1 | Lap Timing Black Box |
| Standings | F2 | Standings Black Box |
| Relative | F3 | Relative Black Box |
| Fuel | F4 | Fuel Black Box |
| Tires | F5 | Tires Black Box |
| Tire Info | F6 | Tire Info Black Box |
| Pit-stop Adjustments | F7 | Pit-stop Adjustments Black Box |
| In-car Adjustments | F8 | In-car Adjustments Black Box |
| Mirror Adjustments | F9 | Mirror Adjustments Black Box |
| Radio Adjustments | F10 | Radio Adjustments Black Box |
| Weather | F11 | Weather Black Box |

**Note:** All key bindings come from the Property Inspector with defaults set in HTML:
- Direct mode: Default based on selected black box (F1-F11)
- Next/Previous modes: Empty default (users must configure in iRacing and set matching key)

## Implementation Details

### Action Class Structure
```typescript
@action({ UUID: "com.iracedeck.sd.core.black-box-selector" })
export class BlackBoxSelector extends ConnectionStateAwareAction<BlackBoxSelectorSettings> {

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const settings = BlackBoxSelectorSettings.parse(ev.payload.settings);
    const { mode, keyBinding, keyNext, keyPrevious } = settings;

    let binding: KeyCombination | undefined;

    if (mode === "direct" && keyBinding?.key) {
      binding = { key: keyBinding.key as KeyboardKey, modifiers: keyBinding.modifiers as KeyboardModifier[] };
    } else if (mode === "next" && keyNext?.key) {
      binding = { key: keyNext.key as KeyboardKey, modifiers: keyNext.modifiers as KeyboardModifier[] };
    } else if (mode === "previous" && keyPrevious?.key) {
      binding = { key: keyPrevious.key as KeyboardKey, modifiers: keyPrevious.modifiers as KeyboardModifier[] };
    }

    if (binding) {
      await getKeyboard().sendKeyCombination(binding);
    }
  }

  override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
    const settings = BlackBoxSelectorSettings.parse(ev.payload.settings);
    const { keyNext, keyPrevious } = settings;

    // Clockwise (ticks > 0) = next, Counter-clockwise (ticks < 0) = previous
    const keyData = ev.payload.ticks > 0 ? keyNext : keyPrevious;

    if (keyData?.key) {
      await getKeyboard().sendKeyCombination({
        key: keyData.key as KeyboardKey,
        modifiers: keyData.modifiers as KeyboardModifier[]
      });
    }
  }
}
```

### Icon Generation
Dynamic icons based on mode and selection:
- **Next mode:** "BB" with up arrow
- **Previous mode:** "BB" with down arrow
- **Direct mode:** Context-specific icon + "BB" label

### Key Binding Parsing (from do-iracing-hotkey.ts pattern)
The `ird-key-binding` component stores values as JSON strings. The Zod schema handles both formats:
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
```

## Verification Steps

1. Build the plugin: `pnpm build` in `packages/stream-deck-plugin`
2. Restart Stream Deck to load the updated plugin
3. Add the Black Box Selector action to a key
4. Test Direct mode:
   - Select each black box option
   - Press the key and verify correct F-key is sent to iRacing
5. Test encoder (Stream Deck+):
   - Rotate clockwise to trigger "next" key binding
   - Rotate counter-clockwise to trigger "previous" key binding
6. Verify icon updates correctly based on settings
7. Test Next/Previous modes (after configuring keybinds in iRacing)

## File Creation Order

1. Icon template (`icons/black-box-selector.svg`)
2. Static icons (`imgs/actions/black-box-selector/icon.svg`, `key.svg`)
3. Property Inspector (`ui/black-box-selector.html`)
4. Action implementation (`src/actions/black-box-selector.ts`)
5. Update manifest.json
6. Update plugin.ts
7. Build and test
