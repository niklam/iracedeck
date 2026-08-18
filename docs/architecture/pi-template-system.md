# PI Template System for Stream Deck Plugins

> **Current state (as of issue #340):** The template sources, partials, data files, Rollup EJS plugin, web components, and vendored `sdpi-components.js` listed in the original file structure below were extracted from the plugins in issue #329 (into `@iracedeck/pi-components`), and then in issue #340 the per-action templates and per-action static icons were co-located into `@iracedeck/iracing-actions` under `src/actions/<name>/`, with shared template data under `src/actions/data/`. `@iracedeck/pi-components` is now the PI framework package (partials, EJS compile plugin, web components). Consumer plugins import `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, and compute `actionTemplatesDir` locally. See `.claude/rules/pi-templates.md` for the current layout and integration snippet. The sections below describe the original design and remain accurate in intent, with one exception noted below.
>
> **Superseded (issue #1003):** design decision 1 no longer holds. The plugin-global settings moved to the dedicated settings window (#992, #993), and the action PIs stopped rendering their own copies of them. What remains in a PI is one `key-bindings-section` include — the action's OWN key bindings plus an "Open iRaceDeck Settings" button — so the convenience argument below now applies only to key bindings, which are contextual to the action being configured. The `global-common-settings.ejs` assembler was deleted; `settings-window-scripts.ejs` holds the JS for the global controls. Every other `global-*.ejs` partial in the structure below is settings-window-only.

## Goal

Create a build-time template system for Property Inspector HTML files that allows defining global key bindings once and including them across multiple PI files via an accordion UI.

## Design Decisions

1. **Global key bindings editable from each action's PI** - The accordion with key bindings appears in every action that uses them. This is more convenient for users since they can adjust bindings without leaving the action they're configuring.

2. **Global settings are plugin-scoped** - "Global" means shared across all actions *within the same plugin*. This is how Stream Deck's `globalSettings` API works - it's per-plugin.

## Approach: EJS Templates with Custom Rollup Plugin

**Why EJS:**

- Mature, battle-tested (since 2010), minimal dependencies
- Simple partial syntax: `<%- include('partials/head-common') %>`
- Full JavaScript support for passing data to partials
- Zero runtime overhead - compiles to static HTML
- Already using similar Mustache-style templates for icons

## File Structure

```text
packages/
  iracing-plugin-stream-deck/
    src/
      pi-templates/                    # Template partials
        partials/
          accordion.ejs                # Reusable accordion component
          border-overrides.ejs         # Per-action border settings
          color-overrides.ejs          # Per-action color overrides
          common-settings.ejs          # Common settings (flags overlay) in accordion
          docs-link.ejs                # Documentation link
          global-border-defaults.ejs   # Global border defaults accordion
          global-color-defaults.ejs    # Global icon color defaults accordion
          global-key-bindings.ejs      # Key binding controls in accordion
          global-common-*.ejs          # Global common settings groups (deleted assembler: global-common-settings.ejs, #1003)
          global-title-defaults.ejs    # Global title defaults accordion
          head-common.ejs              # Common <head> content + CSS + JS
          section-header.ejs           # Section divider (Action/Global Settings)
          title-overrides.ejs          # Per-action title overrides
          version.ejs                  # Version footer
      build/
        pi-template-plugin.mjs         # Rollup plugin for EJS
      pi/                              # Source templates (one per action)
        *.ejs                          # Action PI templates
        data/
          key-bindings.json            # Key binding definitions
          icon-defaults.json           # Icon color defaults (generated)
          docs-urls.json               # Documentation URL mapping
      shared/
        pi/
          key-binding-input.ts         # `global` attribute support
    com.iracedeck.sd.core.sdPlugin/
      ui/                              # Output (compiled HTML)
```

**Note:** The build tooling and reusable UI partials live alongside the plugin code in `iracing-plugin-stream-deck`.

## Implementation Steps

### 1. Add EJS dependency to iracing-plugin-stream-deck

- `pnpm add ejs` in iracing-plugin-stream-deck
- Add `@types/ejs` for TypeScript support

### 2. Create Rollup plugin (`pi-template-plugin.mjs`)

- Watch `.ejs` files in source directory
- Watch shared partials for rebuild
- Compile EJS → HTML at build time
- Emit to plugin's `ui/` folder

### 3. Create shared partials

**`accordion.ejs`** - Native `<details>/<summary>` for collapsible sections:

```html
<details class="ird-accordion" <%= locals.open ? 'open' : '' %>>
  <summary class="ird-accordion-header">
    <span class="ird-accordion-title"><%= title %></span>
    <span class="ird-accordion-icon">▼</span>
  </summary>
  <div class="ird-accordion-content">
    <%- content %>
  </div>
</details>
```

**`global-key-bindings.ejs`** - Key binding controls wrapped in accordion:

```html
<%- include('accordion', {
  title: 'Key Bindings',
  open: false,
  content: keyBindings.map(b => `
    <sdpi-item label="${b.label}">
      <ird-key-binding setting="${b.setting}" default="${b.default}" global></ird-key-binding>
    </sdpi-item>
  `).join('')
}) %>
```

**`key-bindings.json`** - Plugin-specific key binding definitions (lives in each plugin, not shared):

```json
// Example: iracing-plugin-stream-deck/src/pi/data/key-bindings.json
{
  "blackBox": [
    { "id": "lapTiming", "label": "Lap Timing", "default": "F1", "setting": "keys.blackBox.lapTiming" },
    { "id": "standings", "label": "Standings", "default": "F2", "setting": "keys.blackBox.standings" }
  ]
}
```

The key bindings, accordion partial, and build tooling all live within `iracing-plugin-stream-deck`.

### 4. Update `ird-key-binding` component

Add `global` attribute to use `SDPIComponents.useGlobalSettings()` instead of `useSettings()`.

> **Confirmed:** `sdpi-components.js` exports both `useGlobalSettings` and `useSettings` from `SDPIComponents`. The built-in SDPI components already support a `global` attribute that switches between the two APIs while using the same `setting` property for the key path. Our `ird-key-binding` component should follow the same pattern.

### 5. Update GlobalSettingsSchema

Add key binding fields for global storage.

### 6. Integrate into plugin build

Update `rollup.config.mjs` in each plugin:

```javascript
import { piTemplatePlugin } from "./src/build/pi-template-plugin.mjs";

plugins: [
  piTemplatePlugin({
    templatesDir: "src/pi",
    outputDir: `${sdPlugin}/ui`,
    partialsDir: "src/pi-templates/partials",
  }),
]
```

### 7. Convert existing PI files

- Copy `black-box-selector.html` → `src/pi/black-box-selector.ejs`
- Replace hardcoded key bindings with `<%- include('global-key-bindings', {...}) %>`
- Remove compiled `.html` from git (now build output)

## Example Usage

**Source (`src/pi/black-box-selector.ejs`):**

```html
<!doctype html>
<html lang="en">
<head>
  <%- include('head-common') %>
</head>
<body>
  <%- include('section-header', { title: 'Action Settings' }) %>

  <sdpi-item label="Mode">
    <sdpi-select setting="mode" default="direct">
      <option value="direct">Direct</option>
      <option value="next">Next</option>
    </sdpi-select>
  </sdpi-item>

  <%- include('title-overrides') %>
  <%- include('color-overrides', { slots: [...], defaults: ... }) %>
  <%- include('border-overrides', { defaults: ... }) %>
  <%- include('common-settings') %>

  <%# Superseded by #1003 — a PI now ends with one key-bindings-section include: %>
  <%- include('key-bindings-section', {
    keyBindings: require('./data/key-bindings.json').blackBox
  }) %>

  <%- include('docs-link') %>
  <%- include('version') %>
</body>
</html>
```

**Output (`ui/black-box-selector.html`):** Static HTML with accordion inlined.

## Verification

1. Run `pnpm build` in iracing-plugin-stream-deck
2. Check `ui/black-box-selector.html` contains compiled accordion
3. Open Stream Deck, verify PI renders with collapsible key bindings
4. Verify key binding changes persist to global settings

## Files to Modify

- `packages/iracing-plugin-stream-deck/package.json` - Add ejs dependency
- `packages/iracing-plugin-stream-deck/src/build/pi-template-plugin.mjs` - Rollup plugin for EJS
- `packages/iracing-plugin-stream-deck/src/pi-templates/` - Template partials directory
- `packages/iracing-plugin-stream-deck/src/shared/pi/key-binding-input.ts` - Global attribute support
- `packages/iracing-plugin-stream-deck/rollup.config.mjs` - Add plugin
- `packages/iracing-plugin-stream-deck/src/pi/` - EJS template sources
