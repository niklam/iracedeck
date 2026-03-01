# @iracedeck/stream-deck-plugin

Core Stream Deck plugin for iRaceDeck. Contains all iRacing-related actions and shared utilities.

Shared utilities (base actions, keyboard service, global settings, icon templates, etc.) live in `src/shared/` with a barrel export at `src/shared/index.ts`. Actions import from `../shared/index.js` and `plugin.ts` imports from `./shared/index.js`.

PI components (browser-side web components for Property Inspector) live in `src/pi-components/` and are built separately via `rollup.pi.config.mjs`. PI template partials (EJS) live in `src/pi-templates/`. The build plugin for EJS templates is at `src/build/pi-template-plugin.mjs`.

## Adding a New Action

Every action requires **6 new files** and **3 modified files**. Use `splits-delta-cycle` as the reference pattern for simple actions with global key bindings.

### Files to create

Replace `{action-name}` with the kebab-case name (e.g., `my-action`) and `{ActionName}` with the PascalCase name (e.g., `MyAction`).

#### 1. Action source — `src/actions/{action-name}.ts`

```typescript
import streamDeck, {
  action,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";
import z from "zod";

import actionTemplate from "../../icons/{action-name}.svg";

// Settings schema (use z.object({}) if no action-specific settings)
const {ActionName}Settings = z.object({
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
  const svg = renderIconTemplate(actionTemplate, {
    iconContent: "...",
    labelLine1: "LABEL",
    labelLine2: "SUBLABEL",
  });
  return svgToDataUri(svg);
}

@action({ UUID: "com.iracedeck.sd.core.{action-name}" })
export class {ActionName} extends ConnectionStateAwareAction<{ActionName}Settings> {
  protected override logger = createSDLogger(
    streamDeck.logger.createScope("{ActionName}"),
    LogLevel.Info,
  );

  // Required lifecycle handlers: onWillAppear, onWillDisappear,
  // onDidReceiveSettings, onKeyDown, onDialRotate
  // See splits-delta-cycle.ts for the full pattern.
}
```

Key requirements:
- Extend `ConnectionStateAwareAction`
- Use `@action({ UUID: "com.iracedeck.sd.core.{action-name}" })` decorator
- Parse settings with Zod's `safeParse` (never throw on invalid settings)
- Export constants and icon generation functions with `@internal` JSDoc for testing
- Use `parseKeyBinding()` / `formatKeyBinding()` from shared utilities
- Subscribe to SDK controller in `onWillAppear`, unsubscribe in `onWillDisappear`
- Implement `onDidReceiveSettings` to respond to PI changes
- Logging: `info` for events (no params), `debug` for details (with params)

#### 2. Unit tests — `src/actions/{action-name}.test.ts`

Must mock both SDK and shared modules before importing. Test exported constants and SVG generation:

```typescript
vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class { /* mock fields */ },
  createSDLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() })),
  formatKeyBinding: vi.fn((b) => b.modifiers?.length ? `${b.modifiers.join("+")}+${b.key}` : b.key),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({ sendKeyCombination: vi.fn().mockResolvedValue(true) })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((_t, data) => `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`),
  svgToDataUri: vi.fn((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));
```

See `splits-delta-cycle.test.ts` for the full pattern.

#### 3. Icon template — `icons/{action-name}.svg`

Mustache template, 72x72 canvas. Must include `activity-state` filter wrapper:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="72" height="72" rx="8" fill="#BACKGROUND"/>
    {{iconContent}}
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="8">{{labelLine2}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{labelLine1}}</text>
  </g>
</svg>
```

- Background color must be unique per action (check existing actions to avoid duplicates)
- Icon content area: y=9 to y=43
- Label area: line2 at y=52 (subdued `#aaaaaa`), line1 at y=63 (bright `#ffffff`)
- Placeholders: `{{iconContent}}`, `{{labelLine1}}`, `{{labelLine2}}`

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

### Files to modify

#### 7. Register in plugin — `src/plugin.ts`

Add import and registration. **Maintain alphabetical order** in both the import block and the registration block:

```typescript
import { {ActionName} } from "./actions/{action-name}.js";
// ...
streamDeck.actions.registerAction(new {ActionName}());
```

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

**Also update the actions reference** when adding, removing, or modifying actions:
- `docs/reference/actions.json` — add/update the action entry with all modes
- `.claude/skills/iracedeck-actions/SKILL.md` — update category overview and per-category tables

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

| Pattern | Example |
|---------|---------|
| Telemetry-aware icon (single control) | `car-control.ts` (pit-speed-limiter) |
| Telemetry-aware icon (full action) | `tire-service.ts` |

### Reference implementations

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
