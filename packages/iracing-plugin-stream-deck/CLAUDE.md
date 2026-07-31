# @iracedeck/iracing-plugin-stream-deck

Core Stream Deck plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with the Elgato Stream Deck via `@iracedeck/deck-adapter-elgato`.

Action implementations live in `packages/iracing-actions/src/actions/<action-name>/`, with one folder per action. Shared utilities (base actions, keyboard service, global settings, icon templates, etc.) live in `packages/deck-core/src/`. Actions import from `@iracedeck/deck-core`. The `src/shared/index.ts` in this package re-exports from `@iracedeck/deck-core` and `@iracedeck/deck-adapter-elgato` for backward compatibility.

Each action folder is self-contained: `<name>.ts`, `<name>.test.ts`, `<name>.ejs` (PI template), and `icon.svg` / `key.svg` (static icons) all live side-by-side. Shared template data (`icon-defaults.json`, `key-bindings.json`, `docs-urls.json`, the generated `action-comms.json` and `profiles.json`) lives in `packages/iracing-actions/src/actions/data/`. The plugin-global Property Inspector template lives in `packages/iracing-actions/src/actions/settings/`.

The PI framework — browser web components (`pi-components.js`), EJS partials, the Rollup EJS compile plugin, and the vendored `sdpi-components.js` — lives in `@iracedeck/pi-components`. This plugin's `rollup.config.mjs` consumes it via `import { piTemplatePlugin, partialsDir, browserDir } from "@iracedeck/pi-components/build"`, passes `packages/iracing-actions/src/actions/` as the templates root, copies per-action `icon.svg` / `key.svg` into `com.iracedeck.sd.core.sdPlugin/imgs/actions/<name>/`, and copies the browser assets into `com.iracedeck.sd.core.sdPlugin/ui/` — all at build time.

Committed custom touch layouts for dial-capable actions live under `com.iracedeck.sd.core.sdPlugin/layouts/` (currently `audio-controls.json`, `fuel-service.json`, `setup-brakes.json`).

## Adding a New Action

Each action requires a set of new and modified files. Use `splits-delta-cycle` as the reference pattern for simple actions with global key bindings.

### Files to create

Replace `{action-name}` with the kebab-case name (e.g., `my-action`) and `{ActionName}` with the PascalCase name (e.g., `MyAction`).

#### 1. Action source — `packages/iracing-actions/src/actions/{action-name}/{action-name}.ts`

Mirror `splits-delta-cycle.ts` — the binding-dispatch pattern (never direct keyboard access):

```typescript
import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import defaultIconSvg from "@iracedeck/icons/{action-name}/default.svg";
import z from "zod";

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
export function generate{ActionName}Svg(settings: {ActionName}Settings, bindingMissing = false): string {
  const colors = resolveIconColors(defaultIconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(defaultIconSvg, getGlobalTitleSettings(), settings.titleOverrides);
  const border = resolveBorderSettings(defaultIconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  return assembleIcon({ graphicSvg: defaultIconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * {ActionName} Action
 * Description of what this action does.
 */
export const {ACTION_NAME}_UUID = "com.iracedeck.sd.core.{action-name}" as const;

export class {ActionName} extends ConnectionStateAwareAction<{ActionName}Settings> {
  // Logger is injected via constructor (from plugin.ts) — no logger field needed.
  //
  // Lifecycle (see splits-delta-cycle.ts for the full implementation):
  // - onWillAppear / onDidReceiveSettings: call super FIRST, parse settings with
  //   safeParse, declare the required binding via this.setActiveBinding(key),
  //   then update the display.
  // - onKeyDown: execute the binding via await this.tapBinding(key). Use
  //   holdBinding/releaseBinding for hold-style actions (see
  //   .claude/rules/keyboard-shortcuts.md). Never call getKeyboard() in actions.
  // - updateDisplay: compute the per-context missing-binding flag (#612) and
  //   register the regenerate callback:
  //     const svg = generate{ActionName}Svg(settings, this.isBindingMissing(key));
  //     await this.setKeyImage(ev, svg);
  //     this.setRegenerateCallback(ev.action.id, () =>
  //       generate{ActionName}Svg(settings, this.isBindingMissing(key)));
}
```

Full requirements (base class, UUID export, event types, Zod usage, super calls, logging) are in `.claude/rules/stream-deck-actions.md`; binding execution rules are in `.claude/rules/keyboard-shortcuts.md`.

#### 2. Unit tests — `packages/iracing-actions/src/actions/{action-name}/{action-name}.test.ts`

Must mock `@iracedeck/deck-core` before importing — the canonical mock block (including the binding-dispatch stubs `setActiveBinding` / `tapBinding` / `holdBinding` / `releaseBinding`) is in `.claude/rules/testing.md`. Actions that pass `bindingMissing` into icon generation must additionally stub `isBindingMissing` on the mock `ConnectionStateAwareAction`. See `packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts` for the full pattern.

#### 3. Icon SVGs — `packages/icons/{action-name}/*.svg`

Standalone icons are **graphic snippets**: the `viewBox` is trimmed to the artwork's exact extent (variable per icon), and the file contains **only artwork** plus `<desc>` metadata — no background rect, no fixed canvas, no label/text placeholders. Background, title text, border, centering, and scaling are composed at render time by `assembleIcon()`. One file per variant (e.g., `next.svg`, `previous.svg`, `default.svg`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <desc>{"colors":{"backgroundColor":"#412244","textColor":"#ffffff","graphic1Color":"#ffffff"},"locked":["graphic1Color"],"title":{"text":"TO START\nRESET"},"border":{"color":"#714474"}}</desc>
  <!-- Artwork only, coordinates spanning the viewBox,
       using {{graphic1Color}} for colorizable strokes/fills -->
</svg>
```

- The `<desc>` JSON declares the default colors per slot, plus optional `locked` slots and `title` / `border` defaults — read by `resolveIconColors()` / `resolveTitleSettings()` / `resolveBorderSettings()` and by `scripts/generate-icon-defaults.mjs`.
- Author at 144x144-reference stroke weight (4–5px main, 2–3px details) regardless of the trimmed viewBox size — the render-time scaler keeps proportions.
- Background color should be distinct per action; the default title lives in `<desc>` (never with a leading `\n`).
- Full format, color palette, and design rules: `.claude/rules/icons.md` and `.claude/rules/key-icon-types.md`. Real example: `packages/icons/splits-delta-cycle/active-reset-run.svg`.

#### 4. Category icon — `packages/iracing-actions/src/actions/{action-name}/icon.svg`

20x20, monochrome white on transparent. Shown in Stream Deck category browser:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#ffffff">
  <!-- Simple monochrome icon -->
</svg>
```

#### 5. Key icon — `packages/iracing-actions/src/actions/{action-name}/key.svg`

72x72, full color, static content (no Mustache placeholders). Default button appearance shown in the Stream Deck app before the action renders its own image:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <rect x="0" y="0" width="72" height="72" rx="8" fill="#BACKGROUND"/>
  <!-- Static icon content -->
  <text x="36" y="52" ...>LABEL LINE 1</text>
  <text x="36" y="63" ...>LABEL LINE 2</text>
</svg>
```

#### 6. PI template — `packages/iracing-actions/src/actions/{action-name}/{action-name}.ejs`

Match the include set of the reference `splits-delta-cycle/splits-delta-cycle.ejs`:

```ejs
<!doctype html>
<html lang="en">
  <head>
    <%- include('head-common') %>
  </head>
  <body>
    <%- include('section-header', { title: 'Action Settings' }) %>

    <sdpi-item label="Mode">
      <sdpi-select id="mode-select" setting="mode" default="...">
        <option value="...">...</option>
      </sdpi-select>
    </sdpi-item>

    <% var __comms = require('./data/action-comms.json')['{action-name}']; %>
    <ird-binding-status mode-setting="<%= __comms._meta.modeSetting %>" comms='<%= JSON.stringify(__comms) %>'></ird-binding-status>

    <!-- other action-specific sdpi-items here -->

    <%- include('title-overrides') %>
    <%- include('color-overrides', { slots: ['backgroundColor', 'textColor', 'graphic1Color'], defaults: require('./data/icon-defaults.json')['{action-name}'] }) %>
    <%- include('border-overrides', { defaults: require('./data/icon-defaults.json')['{action-name}'] }) %>
    <%- include('graphic-overrides') %>
    <%- include('common-settings') %>

    <%- include('section-header', { title: 'Global Settings' }) %>

    <%- include('global-key-bindings', {
      keyBindings: require('./data/key-bindings.json').{camelCaseCategory}
    }) %>
    <%- include('global-title-defaults') %>
    <%- include('global-color-defaults') %>
    <%- include('global-border-defaults') %>
    <%- include('global-graphic-defaults') %>
    <%- include('global-flag-flash') %>
    <%- include('global-common-settings') %>

    <%- include('docs-link') %>
    <%- include('version') %>
  </body>
</html>
```

- The `ird-binding-status` line under the Mode selector is **mandatory** for any action with a comms-catalog entry (#612, see step 10). Always `<%=` (HTML-escaped) for the `comms` attribute, never `<%-`.
- `require('./data/...')` resolves relative to `packages/iracing-actions/src/actions/data/` regardless of nesting depth.
- Partial reference, shared CSS classes, and the conditional show/hide pattern for mode-dependent settings: `.claude/rules/pi-templates.md` and `.claude/rules/stream-deck-actions.md` (the reference `.ejs` has a working conditional-visibility script).

### Files to modify

#### 7. Register in Stream Deck plugin — `packages/iracing-plugin-stream-deck/src/plugin.ts`

Add import and registration. **Maintain alphabetical order** in both the import block and the registration block.

First, export the UUID and class from `packages/iracing-actions/src/index.ts`:

```typescript
export { {ACTION_NAME}_UUID, {ActionName} } from "./actions/{action-name}/{action-name}.js";
```

Then in `plugin.ts`, import from `@iracedeck/iracing-actions` and register via the adapter:

```typescript
import { {ACTION_NAME}_UUID, {ActionName} } from "@iracedeck/iracing-actions";
// ...
adapter.registerAction({ACTION_NAME}_UUID, new {ActionName}(adapter.createLogger("{ActionName}")));
```

#### 7b. Register in the Mirabox and Ulanzi plugins

Same pattern as above in **both** `packages/iracing-plugin-mirabox/src/plugin.ts` and `packages/iracing-plugin-ulanzi/src/plugin.ts` — import from `@iracedeck/iracing-actions` and register via each platform adapter. Maintain alphabetical order. Their manifests must also be updated: `packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json` and `packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/manifest.json`.

#### 8. Declare in manifest — `com.iracedeck.sd.core.sdPlugin/manifest.json`

Add entry to the `Actions` array:

```json
{
  "Name": "Display Name",
  "UUID": "com.iracedeck.sd.core.{action-name}",
  "Icon": "imgs/actions/{action-name}/icon",
  "Tooltip": "Brief description of what the action does",
  "PropertyInspectorPath": "ui/{action-name}.html",
  "Controllers": ["Keypad"],
  "States": [
    {
      "Image": "imgs/actions/{action-name}/key",
      "TitleAlignment": "bottom",
      "FontSize": 14
    }
  ]
}
```

- Most actions are Keypad-only — use `"Controllers": ["Keypad"]` with no `Encoder` block. A **dial-capable** action may instead declare `"Controllers": ["Keypad", "Encoder"]` with an `Encoder` block (a `layout` pointing at a committed custom touch layout under `<sdPlugin>/layouts/` — currently audio-controls, fuel-service, and setup-brakes — plus a `TriggerDescription`). `fuel-service` is the reference (#759). The Mirabox and Ulanzi manifests stay `["Keypad"]` for dial-capable actions (#786). See `.claude/rules/encoders-and-touchscreen.md` for the action-side mechanics and gating rules.

#### 9. Add key bindings — `packages/iracing-actions/src/actions/data/key-bindings.json`

Add a new category with binding entries — field reference in `.claude/rules/pi-templates.md` §"Key Bindings JSON Format". The `setting` value is the flat global setting key and **must match** what the action passes to `setActiveBinding` / `tapBinding`.

#### 10. Add comms catalog entry — `packages/iracing-actions/src/actions/comms-catalog.ts` (#612)

Add one `CommDescriptor` per mode (api / chat / keybind — use the `keybind` / `keybindBy` / `keybindKeys` / `keybindFixed` helpers), then regenerate the JSON the PI reads:

```bash
pnpm generate:action-comms
```

A freshness test (`comms-catalog.test.ts`) fails if the committed `data/action-comms.json` drifts from the catalog, and a cross-check requires every keybind key to exist in `key-bindings.json`. Together with the `ird-binding-status` line (step 6) and the `bindingMissing` icon flag (step 1), this is the mandatory #612 wiring — details in `.claude/rules/stream-deck-actions.md` §"Per-Mode Communication Method & Binding Status". Display-only actions that issue no iRacing command get no entry and no status line.

#### 11. Add documentation URL — `packages/iracing-actions/src/actions/data/docs-urls.json`

Add an entry mapping the template name to its documentation page:

```json
"{action-name}": "https://iracedeck.com/docs/actions/{category}/{action-name}/"
```

The `{category}` must match the website docs directory — check the existing entries in `docs-urls.json` for the current category names.

### Watch mode

Before running a manual build, ask the user if they have `pnpm watch:stream-deck` running. It runs `rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"`, so every rebuild is applied and the plugin is restarted in the Stream Deck app automatically — no manual build or restart step. Beyond source files, the `watch-externals` rollup plugin watches `manifest.json`, `platform-features.json` (and `feature-flags.local.json` if present), and the icon SVG trees — but flag *values* are captured at watcher startup, so restart the watcher after changing a flag file (see `.claude/rules/platform-feature-flags.md`).

If the user is not running watch mode, suggest they start it in a separate terminal with `pnpm watch:stream-deck`.

### Verification checklist

After implementation, verify all pass before committing:

```bash
pnpm lint:fix    # Auto-fix lint issues
pnpm format:fix  # Auto-fix formatting
pnpm test        # All tests pass (includes the comms-catalog freshness test)
pnpm build       # Build succeeds (skip if watch mode is running)
```

If icons were added or modified, also run:

```bash
node scripts/generate-icon-previews.mjs
node scripts/generate-icon-defaults.mjs
```

**Also update the actions reference** when adding, removing, or modifying actions:
- `docs/reference/actions.json` — add/update the action entry with all modes
- `.claude/skills/iracedeck-actions/SKILL.md` — update category overview and per-category tables
- All plugin packages — registration in `plugin.ts` and manifest for `iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, **and** `iracing-plugin-ulanzi`

## Telemetry-Aware Icons

Some actions update their icon based on live iRacing telemetry via an `sdkController` subscription. The controller polls every 10 ms and dedupes on iRacing's `SessionTick`, so subscriber callbacks fire once per iRacing telemetry frame (~60 Hz; see `packages/iracing-sdk/src/SDKController.ts`, #493). Use this pattern when an action's visual state depends on telemetry data.

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
- State caching prevents re-rendering on every ~60 Hz frame when nothing changed; for values that legitimately change every frame (RPM, speed), throttle renders with `IconUpdateThrottle` from `@iracedeck/deck-core` (#493, moved from `iracing-actions/src/shared/` in #899)
- Update `activeContexts` in both `onWillAppear` and `onDidReceiveSettings`

### Telemetry-aware reference implementations

All action source files are in `packages/iracing-actions/src/actions/<action-name>/<action-name>.ts`.

| Pattern | Example |
|---------|---------|
| Telemetry-aware icon (single control) | `car-control/car-control.ts` (pit-speed-limiter) |
| Telemetry-aware icon (full action) | `tire-service/tire-service.ts` |

### General reference implementations

All action source files are in `packages/iracing-actions/src/actions/<action-name>/<action-name>.ts`.

| Pattern | Example |
|---------|---------|
| Simple action with global key bindings | `splits-delta-cycle/splits-delta-cycle.ts` |
| Action with per-action settings dropdown | `car-control/car-control.ts` |
| Action with many icon variants | `black-box-selector/black-box-selector.ts` |
| Long-press (key hold) action | `look-direction/look-direction.ts` |
| Complex action with SDK commands | `fuel-service/fuel-service.ts` |

### Naming conventions

| Item | Convention | Example |
|------|-----------|---------|
| File name | kebab-case | `my-action.ts` |
| Class name | PascalCase | `MyAction` |
| Action UUID | `com.iracedeck.sd.core.{kebab-case}` | `com.iracedeck.sd.core.my-action` |
| Global setting key | camelCase, category prefix | `myActionActivate` |
| Key bindings category | camelCase | `myAction` |
| Logger scope | PascalCase (matches class) | `MyAction` |
