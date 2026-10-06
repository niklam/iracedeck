---
paths:
  - "**/*.ejs"
  - "packages/pi-components/**"
  - "packages/iracing-actions/src/actions/data/**"
  - "packages/iracing-plugin-*/**"
  - "packages/plugin-build/**"
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

**The browser bundles import nothing from deck-core but one subpath (#1277).** `ird-key-binding`'s key map (`KEY_CODE_MAP`, the modifiers and their aliases, the `Map`-based lookups) and its default parser (`parseDefaultKeyBinding`, behind `parseSimpleDefault`) are not pi-components' own: they come from deck-core's dependency-free `key-binding-defaults.ts` through `@iracedeck/deck-core/key-binding-defaults`, the same code the plugin's startup binding seed stores with, so a seeded default is byte-identical to the one the field saves (`key-binding-input.default-save.test.ts` pins it). `packages/pi-components/rollup.config.mjs` resolves that one subpath with node-resolve and fails the build on any other deck-core import, and on any unresolved import or missing IIFE global — the deck-core barrel reaches Node built-ins and the native addons and must never land in a Property Inspector. Vitest reaches the subpath through an alias in the root `vitest.config.ts`, listed before the bare `@iracedeck/deck-core` entry.

Template `require('./data/...')` resolves relative to the shared data directory (`packages/iracing-actions/src/actions/data/`), regardless of how deeply the template is nested. The EJS compile plugin rewrites the base path so templates don't need to know their own depth.

Inside a partial, `locals.foo` reads an optional **include parameter** (`include('x', { foo: true })`) — EJS copies include data into nested includes, so a flag passed at a top-level include is visible all the way down. The one exception is an `include()` nested inside another include's option object (`include('accordion', { content: include('x') })`): that inner call runs in the page's own scope and must be given the flag itself. (The compile plugin used to pass a hand-built `locals: {…}` that shadowed EJS's own and hid every include parameter; fixed in #992 with a regression test.)

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

    <%# Closes the action's own settings with the way through to the settings
        window. Keep it OUTSIDE any wrapper the PI hides per surface (#1024). %>
    <%- include('action-settings-footer') %>

    <%- include('title-overrides') %>
    <%- include('color-overrides', { slots: [...], defaults: require('./data/icon-defaults.json')['action-name'] }) %>
    <%- include('border-overrides', { defaults: require('./data/icon-defaults.json')['action-name'] }) %>
    <%- include('graphic-overrides') %>
    <%- include('common-settings') %>

    <%# Omit `keyBindings` when the action has none — the section then says so. %>
    <%- include('key-bindings-section', {
      keyBindings: require('./data/key-bindings.json').category
    }) %>

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

- **head-common.ejs** - Required scripts, common styles, and the handlers BOTH surfaces need (per-action colour presets, per-action title position, accordion-state persistence, the warnings banner). Handlers for the plugin-global controls moved to `settings-window-scripts.ejs` in #1003. It emits `sdpi-components.js` / `pi-components.js`; each plugin's build then injects ONE bridge `<script>` immediately before `sdpi-components.js` in every generated action PI — `pi-settings-bridge.js` on Elgato/Mirabox, `ulanzi-pi-bridge.js` on Ulanzi — so global settings route to the plugin's loopback settings server (#993). Don't add a bridge tag to a template; the build owns it and asserts it (see `settings-window.md`).
- **accordion.ejs** - Collapsible section component. Accepts an optional `accordionId` parameter (defaults to `title`) used as the persistence key in global settings (`_accordionState`). The `accordionId` must be unique per PI page — use it when two accordions share the same display title (e.g., per-action vs global "Common Settings"). State is shared across action types since most actions use the same accordion IDs. When `settingsWindow` is truthy in scope (the settings window passes it at its top-level includes; nested includes inherit it) it renders a flat `.ird-sw-card` instead of a `<details>` — see `settings-window.md`.
- **section-header.ejs** - Section divider with title label and horizontal rule. Parameters: `title` (string); `openSettings` (boolean, optional) renders the "iRaceDeck Settings" button under the header — only `settings.ejs` uses that slot, and there the button IS the page. An action PI gets the button from `action-settings-footer.ejs` instead (#1024). Used to separate "Action Settings" from "Key Bindings".
- **common-settings.ejs** - Common settings shared by all actions (flags overlay), wrapped in accordion
- **color-overrides.ejs** - Per-action color override controls with Default/White/Black presets
- **border-overrides.ejs** - Per-action border settings (enable, width, color). Place after color-overrides.
- **graphic-overrides.ejs** - Per-action graphic scale settings (Inherit/Icon Default/Override). Place after border-overrides, before common-settings.
- **title-overrides.ejs** - Per-action title override controls (show/hide title and graphics, title text, bold, font size, position)
- **action-settings-footer.ejs** - Closes an action PI's OWN settings with the "iRaceDeck Settings" button (#1024). No parameters. **Placement rule:** include it after the action's own settings and before `title-overrides`, OUTSIDE every surface-conditional wrapper — on the 17 dial-capable PIs `title-overrides` sits inside `<div id="keypad-appearance">`, which is hidden on the dial surface, so anchoring the button to it (or rendering it from inside `title-overrides.ejs`) would strip every dial user of the route to the settings window. `action-settings-footer-partial.test.ts` checks the placement in all 36 templates.
- **key-bindings-section.ejs** - The whole bottom section of an action PI (#1003): the "Key Bindings" header, and either the `Related Key Bindings` accordion or a line saying the action has none. Takes an optional `keyBindings` array and an optional `hidden` flag (start the bindings wrapper hidden so the PI can reveal it per mode — Fuel Service does). This is the ONLY global surface left in an action PI; everything else lives in the settings window. It no longer carries the settings button — #1024 moved that to `action-settings-footer.ejs`.
- **global-key-bindings.ejs** - The `Related Key Bindings` accordion itself, rendered by `key-bindings-section`. Its title is load-bearing: `binding-status.ts` pins the literal `"Related Key Bindings"` to open and scroll it, and `accordion.ejs` derives `data-accordion-id` from the title.
- **global-color-defaults.ejs** - Global icon color defaults (presets, color pickers) in accordion. **Settings window only** since #1003.
- **global-title-defaults.ejs** - Global title defaults (show/hide, bold, font size, position) in accordion. **Settings window only** since #1003.
- **global-border-defaults.ejs** - Global border defaults (enable, width, color, glow) in accordion. **Settings window only** since #1003.
- **global-graphic-defaults.ejs** - Global graphic scale default (50-150%, default 100%) in accordion. **Settings window only** since #1003.
- **global-flag-flash.ejs** - Global flag-flash duration default (0-30 seconds, default 15, step 1; `0` = flash forever) in accordion. See issue #490. **Settings window only** since #1003.
- **global-common-{window-focus,mouse-pointer,simhub,dual-press,replay,chat,updates,diagnostics}.ejs** - The common-settings groups (items only, no heading), placed on separate tabs by the settings window (#992). Add a new common setting to the right group partial. The `global-common-settings.ejs` assembler that gathered them into one PI accordion was deleted in #1003 along with the PI section it served.
- **global-stream-deck-profiles.ejs** - Bundled-profile install buttons, self-gated to Elgato by the `profiles` feature flag. **Settings window only** since #1003 (in device-picker mode).
- **race-engineer-settings.ejs / race-engineer-callouts.ejs / setup-warning-patterns.ejs / voice-packs.ejs** - The Race Engineer plugin-wide settings (items only). **Settings window only** since #1003, which moved them out of `pit-crew.ejs`; the window renders them as cards. `race-engineer-callouts.ejs` owns the callout-list computation. `voice-packs.ejs` is the voice-pack block (#1145, formerly the tail of `race-engineer-settings.ejs`) and renders only when `locals.settingsWindow` is passed to its own include, because a nested include inherits nothing from the accordion around it.
- **settings-window-scripts.ejs** - Behaviour for the plugin-global controls: colour presets, the global title position / font-size gates, the title-defaults and setup-warning Reset buttons, border-defaults visibility. Split out of `head-common.ejs` in #1003 and included by `settings-window.ejs` only — a PI would ship ~200 lines of script whose elements are not on the page. Anything BOTH surfaces need belongs in `head-common.ejs` instead.
- **settings-window-getting-started.ejs** - The Getting Started page (#1061), rendered from the generated `data/getting-started.json`. Settings window only. Maps each `<!-- ird:action <id> -->` marker in the source page to its control and **throws at build time** on an id it does not know; the Profiles jump is gated on `locals.platform?.features?.profiles`. Editing the source page in a Claude Code session regenerates the artifact through the post-edit hook; run `pnpm generate:getting-started-data` by hand otherwise — a freshness test enforces it either way.
- **settings-window-changelog.ejs** - The What's New tab's built-in release notes (#1011): one card per release, newest first, read from `require('./data/changelog.json')` (generated by `pnpm generate:changelog-data` — see `@.claude/rules/changelog.md`). **Settings window only**; bullet `items` are pre-escaped HTML emitted raw, and its `.sw-cl-*` styling lives with the rest of the window's CSS in `settings-window.ejs`.
- **open-settings.ejs** - The *iRaceDeck Settings* button plus the settings-window warning banner that explains a press that does nothing (#1005). The single definition of that button; included by `action-settings-footer.ejs` (action PIs) and `section-header.ejs` (`settings.ejs`). Optional `extraClass` parameter for the wrapper. Don't include it directly from an action template — go through `action-settings-footer.ejs` so the placement rule and its divider stay in one place.
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

- **`ird-open-settings`** — the centred block that wraps the `<ird-open-settings>` button (rendered by `key-bindings-section.ejs` at the end of the section, #992/#1003; `settings.ejs` uses `section-header.ejs`'s `openSettings: true` slot instead) — a block like `.ird-docs-link`, never an `sdpi-item`.
- **`ird-section-footer`** — composed with `.ird-open-settings` on a block that CLOSES a section: the same divider rule `.ird-docs-link` carries, so the settings button and the docs link read as siblings (#1003). Declared after `.ird-open-settings` so its `margin-top` wins.
- **`ird-sw-card` / `ird-sw-card-title` / `ird-sw-card-body`** — the flat card `accordion.ejs` emits in `settingsWindow` mode (#992). Styled by the settings-window page itself (`settings-window.ejs`), which is the only page that renders that mode; a second consumer of `settingsWindow: true` would have to move those rules into `head-common.ejs`.

When a new shared style is needed, add the class to `head-common.ejs` and document it here — do not introduce inline styles in partials or per-action templates.

## External Links — default browser (issue #243)

External links in a PI otherwise open in the deck app's small built-in browser, which no PI link ever wants. A single delegated click handler — `installExternalLinkHandler()` in `packages/pi-components/src/components/external-links.ts`, run on load from the `pi-components.js` bundle entry (`src/components/index.ts`) — reroutes **every** external `http(s)` anchor click through sdpi-components' built-in `openUrl` event. So just author a normal link; it opens in the user's **default browser** automatically, no marker class or per-link wiring:

```html
<a href="https://iracedeck.com/downloads/" target="_blank" rel="noopener noreferrer">Downloads</a>
```

That event reaches the OS default browser on every host: Elgato handles it natively, the VSD (Mirabox) host receives it directly, and the Ulanzi PI bridge relays it as a `sendToPlugin` openUrl marker (`src/ulanzi-bridge/translate.ts`) that the Ulanzi adapter re-sends as `openurl` from the **plugin** socket — UlanziStudio ignores `openurl` sent on the PI socket (#845). No per-action plugin code is needed on any host. The handler resolves the anchor's normalized `.href` and only reroutes `http(s)` (the SDK can't open other schemes, e.g. `mailto:`/`app://`, and in-PI/relative targets are left alone). It only intercepts when sdpi-components is loaded, so a load failure falls back to the link's default behavior; the `openUrl` send is fire-and-forget (rejections swallowed) and the listener installs once per document.

## Title Overrides Partial

Adds per-action title customization controls. Settings are stored under the `titleOverrides` key in action settings.

```ejs
<%- include('title-overrides') %>
```

No parameters needed. The partial provides controls for:
- **Show Title** / **Show Graphics** — three-state select (Inherit / Yes / No)
- **Title Text** — multiline textarea to override default title (`titleText`, newline-separated); resolves `{{…}}` template variables against live telemetry (#899), noted by a supporting-text line under the field
- **Bold** — three-state select (Inherit / Yes / No)
- **Font Size** — gated by "Override font size" checkbox; when enabled, shows range slider (5–100, doubled for SVG)
- **Position** — select (Inherit / Top / Middle / Bottom / Custom); Custom reveals offset slider (−100 to +100)

Place before `color-overrides`, after `action-settings-footer`.

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

For toggle actions (DRS, Push-to-Pass, Ignition, Starter, Pit Speed Limiter, Fuel Toggle, Windshield Tearoff, Fast Repair), the color picker is ignored — border color is driven by on/off/n/a state automatically.

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

Place after `global-border-defaults`. Settings window only since #1003.

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

Generated by `node scripts/generate-icon-defaults.mjs` from icon `<desc>` metadata. Maps action names to their default colors and border color. Adding or editing an icon SVG in a Claude Code session regenerates it through the post-edit hook; run the script by hand otherwise.

## Rollup Configuration

A plugin does not wire the PI build by hand: its `rollup.config.mjs` calls `createPluginRollupConfig` from `@iracedeck/plugin-build` (#1349), and the factory (`packages/plugin-build/src/plugin-rollup.mjs`) imports the EJS compile plugin, `partialsDir`, `browserDir` and the bridge constants from `@iracedeck/pi-components/build` and anchors the templates root on the repo root (`packages/iracing-actions/src/actions/`, one template source per action folder). Its options and full step order are in `packages/plugin-build/CLAUDE.md`; `settings-window.md` has the bridge architecture. The PI steps it runs, in order:

1. `piTemplatePlugin` compiles every action template and the shared partials into `{sdPlugin}/ui/`, with the merged platform feature flags as the EJS `platform` variable.
2. Two `injectBridgeScriptPlugin` steps: `SETTINGS_WINDOW_BRIDGE` into `settings-window.html` only (it must load before `sdpi-components.js` to redirect the socket to the plugin's loopback fake host, #992), and the plugin's `piBridge` into every other page — two bridges never share a page (#993 phase 2).
3. `copy-action-icons` copies the files named in the config's `assetCopy.actionIcons` from each action folder into `{sdPlugin}/imgs/actions/<name>/` (gitignored in the plugin).
4. `copy-pi-browser-assets` copies `sdpi-components.js`, `pi-components.js`, the `piBridge`, `SETTINGS_WINDOW_BRIDGE` and the settings window's two brand assets (`SETTINGS_WINDOW_LOGO`, and `SETTINGS_WINDOW_ICON` since #1156 — the favicon only that page links) from `browserDir` into `{sdPlugin}/ui/`, and fails the build naming `pnpm --filter @iracedeck/pi-components build` when one is missing.
5. `strip-html-lang`, only with `stripHtmlLang: true` (Mirabox: VSD Craft requires `<html>` without `lang`).
6. `assertBridgeInjectionPlugin`, the build-time guard (#993 phase 2): every generated page carries exactly its one bridge, immediately before `sdpi-components.js`, and no other. It stays the LAST plugin so it runs in `closeBundle` after every other `generateBundle`/`writeBundle` step (the two injections included) has written its output.

`piBridge` defaults to `PI_SETTINGS_BRIDGE` (Elgato, Mirabox); the Ulanzi config's `piBridge: "ulanzi-pi-bridge.js"` puts the Ulanzi bridge in its place for the action PIs (still `SETTINGS_WINDOW_BRIDGE` for `settings-window.html`), and the factory copies, injects and asserts it.

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
