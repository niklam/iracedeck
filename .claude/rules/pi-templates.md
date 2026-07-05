---
# Property Inspector Templates

## Overview

Property Inspector HTML files are built from EJS templates at compile time. This allows:
- Shared partials for common UI components
- Data-driven content from JSON files
- Consistent styling across plugins

## Directory Structure

Per-action PI templates and static icons live alongside each action inside `@iracedeck/iracing-actions`. Shared partials, the Rollup compile plugin, web components, and the vendored `sdpi-components.js` live in `@iracedeck/pi-components` (the PI framework). Consumer plugins only own their compiled HTML output.

```text
packages/iracing-actions/src/actions/
├── <action-name>/             # One folder per action
│   ├── <action-name>.ts       # Action class
│   ├── <action-name>.test.ts
│   ├── <action-name>.ejs      # Property Inspector template
│   ├── icon.svg               # 20×20 category icon
│   ├── key.svg                # 72×72 key icon
│   └── dial.svg               # Optional 72×72 dial default (Elgato manifest `Encoder.Icon`, dual-surface actions only)
├── data/                      # Shared template data
│   ├── icon-defaults.json
│   ├── key-bindings.json      # Key binding definitions
│   └── docs-urls.json
└── settings/
    └── settings.ejs           # Plugin-global PI (compiles to ui/settings.html)

packages/pi-components/
├── partials/                  # EJS partials (shared across all actions and plugins)
├── browser/                   # Vendored + built PI browser assets (plugins copy into ui/)
│   ├── sdpi-components.js     # Vendored (committed)
│   └── pi-components.js       # Built by packages/pi-components/rollup.config.mjs
└── src/
    ├── components/            # Web component sources (ird-key-binding, ird-color-picker, …)
    └── build/                 # Rollup EJS compile plugin and path exports

packages/{iracing-plugin-stream-deck,iracing-plugin-mirabox}/
└── com.iracedeck.sd.{name}.sdPlugin/
    ├── ui/                    # Compiled HTML output + copied browser assets
    │   ├── <action-name>.html # Generated (do not edit)
    │   ├── sdpi-components.js # Copied from @iracedeck/pi-components/browser
    │   └── pi-components.js   # Copied from @iracedeck/pi-components/browser
    └── imgs/actions/<name>/   # Per-action icons copied from @iracedeck/iracing-actions (gitignored)
        ├── icon.svg
        └── key.svg
```

Template `require('./data/...')` resolves relative to the shared data directory (`packages/iracing-actions/src/actions/data/`), regardless of how deeply the template is nested. The EJS compile plugin rewrites the base path so templates don't need to know their own depth.

## Creating a PI Template

### Basic Template Structure

```ejs
<!doctype html>
<html lang="en">
  <head>
    <%- include('head-common') %>
  </head>
  <body>
    <%- include('section-header', { title: 'Action Settings' }) %>

    <!-- Action-specific settings -->
    <sdpi-item label="Setting">
      <sdpi-select setting="mySetting" default="value">
        <option value="value">Label</option>
      </sdpi-select>
    </sdpi-item>

    <%- include('title-overrides') %>
    <%- include('color-overrides', { slots: [...], defaults: require('./data/icon-defaults.json')['action-name'] }) %>
    <%- include('border-overrides', { defaults: require('./data/icon-defaults.json')['action-name'] }) %>
    <%- include('graphic-overrides') %>
    <%- include('common-settings') %>

    <%- include('section-header', { title: 'Global Settings' }) %>

    <%- include('global-key-bindings', {
      keyBindings: require('./data/key-bindings.json').category
    }) %>
    <%- include('global-title-defaults') %>
    <%- include('global-color-defaults') %>
    <%- include('global-border-defaults') %>
    <%- include('global-graphic-defaults') %>
    <%- include('global-flag-flash') %>
    <%- include('global-common-settings') %>

    <script>
      // PI-specific JavaScript
    </script>

    <%- include('docs-link') %>
    <%- include('version') %>
  </body>
</html>
```

### Available Partials

Located in `packages/pi-components/partials/`:

- **head-common.ejs** - Required scripts, common styles, and color preset/reset handlers
- **accordion.ejs** - Collapsible section component. Accepts an optional `accordionId` parameter (defaults to `title`) used as the persistence key in global settings (`_accordionState`). The `accordionId` must be unique per PI page — use it when two accordions share the same display title (e.g., per-action vs global "Common Settings"). State is shared across action types since most actions use the same accordion IDs.
- **section-header.ejs** - Section divider with title label and horizontal rule. Parameters: `title` (string). Used to separate "Action Settings" from "Global Settings".
- **common-settings.ejs** - Common settings shared by all actions (flags overlay), wrapped in accordion
- **color-overrides.ejs** - Per-action color override controls with Default/White/Black presets
- **border-overrides.ejs** - Per-action border settings (enable, width, color). Place after color-overrides.
- **graphic-overrides.ejs** - Per-action graphic scale settings (Inherit/Icon Default/Override). Place after border-overrides, before common-settings.
- **title-overrides.ejs** - Per-action title override controls (show/hide title and graphics, title text, bold, font size, position)
- **global-key-bindings.ejs** - Key bindings in collapsible section
- **global-color-defaults.ejs** - Global icon color defaults (presets, color pickers) in accordion
- **global-title-defaults.ejs** - Global title defaults (show/hide, bold, font size, position) in accordion
- **global-border-defaults.ejs** - Global border defaults (enable, width, color, glow) in accordion
- **global-graphic-defaults.ejs** - Global graphic scale default (50-150%, default 100%) in accordion
- **global-flag-flash.ejs** - Global flag-flash duration default (0-30 seconds, default 15, step 1; `0` = flash forever) in accordion. See issue #490.
- **global-common-settings.ejs** - Global common settings (window focus, SimHub server, dual-press, replay/chat delays, What's New page preference, diagnostics) in accordion
- **docs-link.ejs** - Documentation link to the action's page on iracedeck.com (conditional, hidden when no URL mapped). Opens in the default browser (see _External Links_ below).
- **version.ejs** - Version footer with downloads link. Opens in the default browser (see _External Links_ below).

## Shared CSS Classes

Common style classes are defined in `head-common.ejs` (loaded by every PI page). Use these classes — never inline `style="..."` attributes — so styling stays consistent and changes apply everywhere at once.

- **`ird-section-subtitle`** — uppercase group label inside an accordion (e.g. "Window Focus", "SimHub Server").
- **`ird-supporting-text`** — help/explanatory text shown directly beneath an `sdpi-item`. The class includes a 95px left padding so the text aligns under the control column (not the label), matching the `sdpi-item` layout. Always use this class for help blurbs:

  ```html
  <sdpi-item label="Directions">
    <sdpi-select setting="dualPressDirections" default="tap-increases" global>...</sdpi-select>
  </sdpi-item>
  <div class="ird-supporting-text">
    Which direction a short press fires; the long-press always fires the opposite.
  </div>
  ```

When a new shared style is needed, add the class to `head-common.ejs` and document it here — do not introduce inline styles in partials or per-action templates.

## External Links — default browser (issue #243)

External links in a PI otherwise open in the deck app's small built-in browser, which no PI link ever wants. A single delegated click handler — `installExternalLinkHandler()` in `packages/pi-components/src/components/external-links.ts`, run on load from the `pi-components.js` bundle entry (`src/components/index.ts`) — reroutes **every** external `http(s)` anchor click through sdpi-components' built-in `openUrl` event. So just author a normal link; it opens in the user's **default browser** automatically, no marker class or per-link wiring:

```html
<a href="https://iracedeck.com/downloads/" target="_blank" rel="noopener noreferrer">Downloads</a>
```

That event reaches the OS default browser on every host: Elgato handles it natively, the VSD (Mirabox) host receives it directly, and the Ulanzi PI bridge translates it to its `openurl` cmd (`src/ulanzi-bridge/translate.ts`). No plugin-side code is needed. The handler resolves the anchor's normalized `.href` and only reroutes `http(s)` (the SDK can't open other schemes, e.g. `mailto:`/`app://`, and in-PI/relative targets are left alone). It only intercepts when sdpi-components is loaded, so a load failure falls back to the link's default behavior; the `openUrl` send is fire-and-forget (rejections swallowed) and the listener installs once per document.

## Title Overrides Partial

Adds per-action title customization controls. Settings are stored under the `titleOverrides` key in action settings.

```ejs
<%- include('title-overrides') %>
```

No parameters needed. The partial provides controls for:
- **Show Title** / **Show Graphics** — three-state select (Inherit / Yes / No)
- **Title Text** — multiline textarea to override default title (`titleText`, newline-separated)
- **Bold** — three-state select (Inherit / Yes / No)
- **Font Size** — gated by "Override font size" checkbox; when enabled, shows range slider (5–100, doubled for SVG)
- **Position** — select (Inherit / Top / Middle / Bottom / Custom); Custom reveals offset slider (−100 to +100)

Place before `color-overrides`, after action-specific settings.

## Border Overrides Partial

Adds per-action border settings. Settings are stored under the `borderOverrides` key in action settings.

```ejs
<%- include('border-overrides') %>
```

No parameters needed. The partial provides controls for:
- **Enable Border** — checkbox to toggle the border on/off (disabled by default)
- **Width** — range slider (1–20, step 1, default 7), hidden when disabled
- **Color** — color picker (default `#00aaff`), hidden when disabled
- **Show Glow** — three-state select (Inherit / Yes / No), hidden when border disabled
- **Glow Width** — range slider (1–30, step 1, default 18), hidden when border or glow disabled

For toggle actions (DRS, Push-to-Pass, Fuel Toggle, Windshield Tearoff, Fast Repair), the color picker is ignored — border color is driven by on/off/n/a state automatically.

Place after `color-overrides` include, before `graphic-overrides`.

## Graphic Overrides Partial

Adds per-action graphic scale settings. Settings are stored under the `graphicOverrides` key in action settings. Effective for any icon with a parseable `viewBox` — the viewBox dimensions drive the dynamic scaling pipeline.

```ejs
<%- include('graphic-overrides') %>
```

No parameters needed. The partial provides controls for:
- **Scale Mode** — dropdown (Inherit / Icon Default / Override). "Inherit" uses global graphic scale. "Icon Default" uses 100%. "Override" shows the scale slider.
- **Scale %** — range slider (50-150, step 5, default 100), hidden unless Scale Mode is "Override"

Place after `border-overrides`, before `common-settings`.

## Global Graphic Defaults Partial

Adds a plugin-wide graphic scale default in a collapsible "Graphic Defaults" accordion. The setting is stored in global settings (`graphicScale` key).

```ejs
<%- include('global-graphic-defaults') %>
```

No parameters needed. The partial provides:
- **Graphic Scale %** — range slider (50-150, step 5, default 100, stored globally)

Place after `global-border-defaults`, before `global-common-settings`.

## Color Overrides Partial

Adds per-action color customization with `<ird-color-picker>` components and preset buttons.

```ejs
<%- include('color-overrides', {
  slots: ['backgroundColor', 'textColor', 'graphic1Color'],
  defaults: require('./data/icon-defaults.json')['action-name']
}) %>
```

Parameters:
- `slots` — Array of slot names to show: `backgroundColor`, `textColor`, `graphic1Color`, `graphic2Color`
- `defaults` — Object from `icon-defaults.json` with default hex colors per slot

Place after `title-overrides`, before `border-overrides`.

### icon-defaults.json

Generated by `node scripts/generate-icon-defaults.mjs` from icon `<desc>` metadata. Maps action names to their default colors and border color. Run this script after adding new icons.

## Rollup Configuration

Import the EJS compile plugin, partials directory, and browser-assets directory from `@iracedeck/pi-components/build`. Compute the templates root locally from `@iracedeck/iracing-actions` (each action's folder becomes a template source, so the templates root is `packages/iracing-actions/src/actions/`). Add a copy step to emit per-action static icons into the plugin's `imgs/actions/<name>/` (those files are gitignored in the plugin).

```javascript
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { browserDir, partialsDir, piTemplatePlugin } from "@iracedeck/pi-components/build";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const actionsPackagePath = path.resolve(__dirname, "../iracing-actions/src");
const actionTemplatesDir = path.join(actionsPackagePath, "actions");

const sdPlugin = "com.iracedeck.sd.{name}.sdPlugin";

export default {
  plugins: [
    piTemplatePlugin({
      templatesDir: actionTemplatesDir,
      outputDir: `${sdPlugin}/ui`,
      partialsDir,
      version: rootPackageJson.version,
    }),
    // Copy per-action static icons from @iracedeck/iracing-actions into {sdPlugin}/imgs/actions/<name>/
    {
      name: "copy-action-icons",
      generateBundle() {
        const destRoot = `${sdPlugin}/imgs/actions`;
        for (const entry of readdirSync(actionTemplatesDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === "data") continue;
          const actionDir = path.join(actionTemplatesDir, entry.name);
          for (const file of ["icon.svg", "key.svg", "dial.svg"]) {
            const src = path.join(actionDir, file);
            if (!existsSync(src)) continue;
            const destDir = path.join(destRoot, entry.name);
            mkdirSync(destDir, { recursive: true });
            copyFileSync(src, path.join(destDir, file));
          }
        }
      },
    },
    // Copy the PI browser assets next to the generated HTML
    {
      name: "copy-pi-browser-assets",
      generateBundle() {
        const uiDir = `${sdPlugin}/ui`;
        if (!existsSync(uiDir)) mkdirSync(uiDir, { recursive: true });
        for (const file of ["sdpi-components.js", "pi-components.js"]) {
          const src = path.join(browserDir, file);
          if (!existsSync(src)) {
            this.error(`Missing ${file} in @iracedeck/pi-components. Build it first: pnpm --filter @iracedeck/pi-components build`);
          }
          copyFileSync(src, path.join(uiDir, file));
        }
      },
    },
    // ... other plugins
  ],
};
```

The plugin's `package.json` must declare both `"@iracedeck/pi-components": "workspace:*"` and `"@iracedeck/iracing-actions": "workspace:*"` so pnpm topologically builds them before the plugin.

## Key Bindings JSON Format

```json
{
  "categoryName": [
    {
      "id": "uniqueId",
      "label": "Display Label",
      "default": "F1",
      "setting": "keys.category.settingName"
    }
  ]
}
```

## Documentation URLs JSON Format

`packages/iracing-actions/src/actions/data/docs-urls.json` maps PI template names (without `.ejs`) to their documentation page URLs:

```json
{
  "action-name": "https://iracedeck.com/docs/actions/{category}/{action-name}/"
}
```

Templates not in the map (e.g., `settings`, hidden sub-actions) will not show a documentation link.

**Maintenance:** When adding a new action, add its entry to `docs-urls.json` with the correct category and action name.

## Binding-status line — `ird-binding-status` (#612)

Each action's PI shows a per-mode communication/binding status line directly under the Mode selector, via the shared `ird-binding-status` web component (in `@iracedeck/pi-components`). Place it immediately after the mode `<sdpi-item>`:

```ejs
<% var __comms = require('./data/action-comms.json')['<action-name>']; %>
<ird-binding-status mode-setting="<%= __comms._meta.modeSetting %>" comms='<%= JSON.stringify(__comms) %>'></ird-binding-status>
```

- `comms` — the action's entry from the generated `data/action-comms.json` (mode → `{ method, binding? }`). **Always `<%=` (HTML-escaped), never `<%-`** — the browser decodes the escaped attribute back to valid JSON on read, and `<%-` would break the attribute or allow injection.
- `mode-setting` — the action setting whose value is the current mode (read from `_meta.modeSetting`).
- The component reads the live mode, any `keyBy` secondary setting, and the binding values **directly from the PI DOM** (the `sdpi-select`s and the `ird-key-binding` inputs in the *Related Key Bindings* accordion) with change/input events + a polling fallback — the same approach as the conditional-visibility pattern, because the sdpi settings-subscription hooks only deliver the initial value to a read-only observer. It falls back to a control's `default` attribute when its value is empty (untouched controls report `""`).
- For keybind modes it shows the keyboard/SimHub/none state, polls SimHub reachability for a live "SimHub not connected" line, and the "set it here" link opens + scrolls the *Related Key Bindings* accordion (located by `data-accordion-id="Related Key Bindings"`).
- Source of the per-mode catalog: `comms-catalog.ts` → `pnpm generate:action-comms` → `data/action-comms.json` (guarded by a freshness test + a key cross-check against `key-bindings.json`). See `.claude/rules/stream-deck-actions.md` for the full per-action wiring (catalog + status line + icon overlay).

## Build Output

- Templates in `packages/iracing-actions/src/actions/<name>/<name>.ejs` compile to each plugin's `com.iracedeck.sd.{name}.sdPlugin/ui/<name>.html` (output paths are flat — nesting in the source tree doesn't affect the output filename)
- The `data/` subdirectory under `actions/` is excluded from compilation
- Changes to templates, partials, data files, or per-action static icons trigger rebuilds in watch mode in whichever plugin is currently running `rollup -w`
