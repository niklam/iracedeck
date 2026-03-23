# @iracedeck/stream-deck-plugin

Core Stream Deck plugin for iRaceDeck. Registers actions from `@iracedeck/actions` with the Elgato Stream Deck via `@iracedeck/deck-adapter-elgato`.

Action implementations live in `packages/actions/src/actions/`. Shared utilities (base actions, keyboard service, global settings, icon templates, etc.) live in `packages/deck-core/src/`. Actions import from `@iracedeck/deck-core`. The `src/shared/index.ts` in this package re-exports from `@iracedeck/deck-core` and `@iracedeck/deck-adapter-elgato` for backward compatibility.

PI components (browser-side web components for Property Inspector) live in `src/pi-components/` and are built separately via `rollup.pi.config.mjs`. PI template partials (EJS) live in `src/pi-templates/`. The build plugin for EJS templates is at `src/build/pi-template-plugin.mjs`.

## Adding a New Action

Every action requires **6 new files** and **3 modified files**. Use `splits-delta-cycle` as the reference pattern for simple actions with global key bindings.

### Files to create

Replace `{action-name}` with the kebab-case name (e.g., `my-action`) and `{ActionName}` with the PascalCase name (e.g., `MyAction`).

#### 1. Action source — `packages/actions/src/actions/{action-name}.ts`

```typescript
import {
  CommonSettings,
  ConnectionStateAwareAction,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
import z from "zod";

import defaultIconSvg from "@iracedeck/icons/{action-name}/default.svg";

// Settings schema (use CommonSettings directly if no action-specific settings)
const {ActionName}Settings = CommonSettings.extend({
  direction: z.enum(["next", "previous"]).default("next"),
});

type {ActionName}Settings = z.infer<typeof {ActionName}Settings>;

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAME = "{camelCaseCategory}{CamelCaseBinding}";

/**
 * @internal Exported for testing
 */
export function generate{ActionName}Svg(settings: {ActionName}Settings): string {
  const colors = resolveIconColors(defaultIconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(defaultIconSvg, {
    mainLabel: "LABEL",
    subLabel: "SUBLABEL",
    ...colors,
  });
  return svgToDataUri(svg);
}

/**
 * {ActionName} Action
 * Description of what this action does.
 */
export const {ACTION_NAME}_UUID = "com.iracedeck.sd.core.{action-name}" as const;

export class {ActionName} extends ConnectionStateAwareAction<{ActionName}Settings> {
  // Logger is injected via constructor — no need to declare a logger field.
  // The base class receives it: constructor(logger: ILogger)

  // Required lifecycle handlers: onWillAppear, onWillDisappear,
  // onDidReceiveSettings, onKeyDown, onDialRotate
  // IMPORTANT: Call super.onWillAppear(ev) and super.onDidReceiveSettings(ev)
  // as the first line in those handlers (required for flag overlay and CommonSettings).
  // See splits-delta-cycle.ts for the full pattern.
  //
  // In updateDisplay, after setKeyImage, register the regenerate callback:
  //   await this.setKeyImage(ev, svgDataUri);
  //   this.setRegenerateCallback(ev.action.id, () => generate{ActionName}Svg(settings));
}
```

Key requirements:
- Import from `@iracedeck/deck-core` (NOT `@elgato/streamdeck` or `../shared/index.js`)
- Extend `ConnectionStateAwareAction`
- Export a UUID constant (e.g., `{ACTION_NAME}_UUID`) — no `@action` decorator
- Logger is injected via constructor (from `plugin.ts`), not created in the action
- Event types use `IDeck` prefix: `IDeckWillAppearEvent<T>`, `IDeckKeyDownEvent<T>`, etc.
- Parse settings with Zod's `safeParse` (never throw on invalid settings)
- Export constants and icon generation functions with `@internal` JSDoc for testing
- Use `parseKeyBinding()` / `formatKeyBinding()` from `@iracedeck/deck-core`
- Subscribe to SDK controller in `onWillAppear`, unsubscribe in `onWillDisappear`
- Implement `onDidReceiveSettings` to respond to PI changes
- Logging: `info` for events (no params), `debug` for details (with params)

#### 2. Unit tests — `packages/actions/src/actions/{action-name}.test.ts`

Must mock `@iracedeck/deck-core` before importing. Test exported constants and SVG generation:

```typescript
vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };
      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) =>
    b.modifiers?.length ? `${b.modifiers.join("+")}+${b.key}` : b.key),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((_t, data) => `<svg>${data.mainLabel || ""}${data.subLabel || ""}</svg>`),
  svgToDataUri: vi.fn((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));
```

See `packages/actions/src/actions/splits-delta-cycle.test.ts` for the full pattern.

#### 3. Icon SVGs — `packages/icons/{action-name}/*.svg`

Standalone 144x144 SVGs with Mustache label placeholders and `<desc>` color metadata. One file per variant (e.g., `next.svg`, `previous.svg`, `default.svg`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#BACKGROUND","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>

    <!-- Icon content area: y=18 to y=86 -->
    <!-- ... artwork using {{graphic1Color}} for strokes/fills ... -->

    <!-- Labels -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

- The `<desc>` element contains a JSON object mapping color slot names to their default hex values. This metadata is used by `resolveIconColors()` and by `scripts/generate-color-defaults.mjs`.
- Background rect uses `{{backgroundColor}}` (no `rx` attribute — corners are handled by Stream Deck)
- Text elements use `{{textColor}}` instead of hardcoded `#ffffff`
- Graphic elements use `{{graphic1Color}}` (or `{{graphic2Color}}` if needed)
- Background color must be unique per action (check existing actions to avoid duplicates)
- All coordinates doubled from 72x72 (Stream Deck downscales as needed)
- Placeholders: `{{mainLabel}}` (bold), `{{subLabel}}` (smaller)

#### 4. Category icon — `com.iracedeck.sd.core.sdPlugin/imgs/actions/{action-name}/icon.svg`

20x20, monochrome white on transparent. Shown in Stream Deck category browser:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#ffffff">
  <!-- Simple monochrome icon -->
</svg>
```

#### 5. Key icon — `com.iracedeck.sd.core.sdPlugin/imgs/actions/{action-name}/key.svg`

72x72, full color. Default button appearance on Stream Deck. Same structure as icon template but with static content (no Mustache placeholders, no `activity-state` filter):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <rect x="0" y="0" width="72" height="72" rx="8" fill="#BACKGROUND"/>
  <!-- Static icon content -->
  <text x="36" y="52" ...>LABEL LINE 1</text>
  <text x="36" y="63" ...>LABEL LINE 2</text>
</svg>
```

#### 6. PI template — `src/pi/{action-name}.ejs`

Property Inspector template. For actions with only global key bindings:

```ejs
<!doctype html>
<html lang="en">
  <head>
    <%- include('head-common') %>
  </head>
  <body>
    <%- include('global-key-bindings', {
      keyBindings: require('./data/key-bindings.json').{camelCaseCategory}
    }) %>
  </body>
</html>
```

For actions with per-action settings, add `sdpi-item` elements before the key bindings include. See `splits-delta-cycle.ejs` or `car-control.ejs` for examples.

Every action PI template must include the color-overrides and common-settings partials. Place them between action-specific settings and global sections:
```ejs
<%- include('color-overrides', { slots: ['backgroundColor', 'textColor', 'graphic1Color'], defaults: require('./data/color-defaults.json')['{action-name}'] }) %>
<%- include('common-settings') %>
```
The color-overrides partial adds per-action color customization controls. The common-settings partial adds the "Flags Overlay" checkbox and any future common settings.

### Files to modify

#### 7. Register in Stream Deck plugin — `packages/stream-deck-plugin/src/plugin.ts`

Add import and registration. **Maintain alphabetical order** in both the import block and the registration block.

First, export the UUID and class from `packages/actions/src/index.ts`:

```typescript
export { {ACTION_NAME}_UUID, {ActionName} } from "./actions/{action-name}.js";
```

Then in `plugin.ts`, import from `@iracedeck/actions` and register via the adapter:

```typescript
import { {ACTION_NAME}_UUID, {ActionName} } from "@iracedeck/actions";
// ...
adapter.registerAction({ACTION_NAME}_UUID, new {ActionName}(adapter.createLogger("{ActionName}")));
```

#### 7b. Register in Mirabox plugin — `packages/mirabox-plugin/src/plugin.ts`

Same pattern as above — import from `@iracedeck/actions` and register via the VSD adapter. Maintain alphabetical order. The manifest at `packages/mirabox-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json` must also be updated (note: uses `"Knob"` instead of `"Encoder"` for dial actions).

#### 8. Declare in manifest — `com.iracedeck.sd.core.sdPlugin/manifest.json`

Add entry to the `Actions` array:

```json
{
  "Name": "Display Name",
  "UUID": "com.iracedeck.sd.core.{action-name}",
  "Icon": "imgs/actions/{action-name}/icon",
  "Tooltip": "Brief description of what the action does",
  "PropertyInspectorPath": "ui/{action-name}.html",
  "Controllers": ["Keypad", "Encoder"],
  "Encoder": {
    "layout": "$B1",
    "TriggerDescription": {
      "Rotate": "What rotation does",
      "Push": "What press does"
    }
  },
  "States": [
    {
      "Image": "imgs/actions/{action-name}/key",
      "TitleAlignment": "bottom",
      "FontSize": 14
    }
  ]
}
```

- Use `"Controllers": ["Keypad"]` if encoder is not supported
- Omit the `Encoder` block entirely if Keypad-only
- Only include `TriggerDescription` keys for handlers the action implements

#### 9. Add key bindings — `src/pi/data/key-bindings.json`

Add a new category with binding entries:

```json
"{camelCaseCategory}": [
  { "id": "activate", "label": "Activate", "default": "Ctrl+Shift+1", "setting": "{camelCaseCategory}Activate" }
]
```

- `id`: camelCase identifier within the category
- `label`: Human-readable name shown in PI
- `default`: Default key combination (use `""` if no default)
- `setting`: Flat global setting key — **must match** what the action reads via `getGlobalSettings()`

### Watch mode

Before running a manual build, ask the user if they have `pnpm watch:stream-deck` running. When watch mode is active it monitors file changes and automatically rebuilds and applies them to Stream Deck, so no manual build step is needed.

If the user is not running watch mode, suggest they start it in a separate terminal with `pnpm watch:stream-deck`.

### Verification checklist

After implementation, verify all pass before committing:

```bash
pnpm lint:fix    # Auto-fix lint issues
pnpm format:fix  # Auto-fix formatting
pnpm test        # All tests pass
pnpm build       # Build succeeds (skip if watch mode is running)
```

If icons were added or modified, also run:
```bash
node scripts/generate-icon-previews.mjs
node scripts/generate-color-defaults.mjs
```

**Also update the actions reference** when adding, removing, or modifying actions:
- `docs/reference/actions.json` — add/update the action entry with all modes
- `.claude/skills/iracedeck-actions/SKILL.md` — update category overview and per-category tables
- All plugin packages — registration in `plugin.ts` and manifest for both `stream-deck-plugin` and `mirabox-plugin`

## Telemetry-Aware Icons

Some actions update their icon based on live iRacing telemetry (4Hz updates via `sdkController`). Use this pattern when an action's visual state depends on telemetry data.

### Available telemetry

Telemetry fields are on the `TelemetryData` interface from `@iracedeck/iracing-sdk`. Key fields:

- `EngineWarnings` — bitfield: `PitSpeedLimiter`, `EngineStalled`, `RevLimiterActive`, etc.
- `PitSvFlags` — bitfield: tire change flags, fuel, windshield, etc.
- `PlayerTireCompound` — current tire compound (0=dry, 1=wet)
- `OnPitRoad`, `PitstopActive`, `PlayerCarInPitStall` — pit state booleans

Use `hasFlag(value, flag)` from `@iracedeck/iracing-sdk` for bitfield checks.

### Pattern

```typescript
import { EngineWarnings, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

// 1. Helper to extract state from telemetry
export function isSomeStateActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.EngineWarnings === undefined) return false;
  return hasFlag(telemetry.EngineWarnings, EngineWarnings.SomeFlag);
}

// 2. Icon generation accepts telemetry-derived state
export function generateSvg(settings: Settings, someState?: boolean): string { ... }

// 3. In the action class: Maps for tracking state per context
private activeContexts = new Map<string, Settings>();
private lastState = new Map<string, string>();

// 4. Subscribe with telemetry callback in onWillAppear
this.sdkController.subscribe(ev.action.id, (telemetry) => {
  this.updateConnectionState();
  const storedSettings = this.activeContexts.get(ev.action.id);
  if (storedSettings) {
    this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
  }
});

// 5. State caching — only re-render when state changes
private async updateDisplayFromTelemetry(contextId, telemetry, settings) {
  const stateKey = this.buildStateKey(settings, /* telemetry-derived values */);
  if (this.lastState.get(contextId) !== stateKey) {
    this.lastState.set(contextId, stateKey);
    await this.updateKeyImage(contextId, generateSvg(settings, /* state */));
  }
}

// 6. Clean up both Maps in onWillDisappear
this.activeContexts.delete(ev.action.id);
this.lastState.delete(ev.action.id);
```

Key points:
- `updateKeyImage(contextId, svg)` updates without needing the event object (for telemetry callbacks)
- `getCurrentTelemetry()` on `sdkController` for initial display in `updateDisplay`
- State caching prevents re-rendering every 250ms tick when nothing changed
- Update `activeContexts` in both `onWillAppear` and `onDidReceiveSettings`

### Reference implementations

All action source files are in `packages/actions/src/actions/`.

| Pattern | Example |
|---------|---------|
| Telemetry-aware icon (single control) | `car-control.ts` (pit-speed-limiter) |
| Telemetry-aware icon (full action) | `tire-service.ts` |

### Reference implementations

All action source files are in `packages/actions/src/actions/`.

| Pattern | Example |
|---------|---------|
| Simple action with global key bindings | `splits-delta-cycle.ts` |
| Action with per-action settings dropdown | `car-control.ts` |
| Action with many icon variants | `black-box-selector.ts` |
| Long-press (key hold) action | `look-direction.ts` |
| Complex action with SDK commands | `fuel-service.ts` |

### Naming conventions

| Item | Convention | Example |
|------|-----------|---------|
| File name | kebab-case | `my-action.ts` |
| Class name | PascalCase | `MyAction` |
| Action UUID | `com.iracedeck.sd.core.{kebab-case}` | `com.iracedeck.sd.core.my-action` |
| Global setting key | camelCase, category prefix | `myActionActivate` |
| Key bindings category | camelCase | `myAction` |
| Logger scope | PascalCase (matches class) | `MyAction` |
