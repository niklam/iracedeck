# PI Template System for Stream Deck Plugins

## Goal

Create a build-time template system for Property Inspector HTML files that allows defining global key bindings once and including them across multiple PI files via an accordion UI.

## Design Decisions

1. **Global key bindings editable from each action's PI** - The accordion with key bindings appears in every action that uses them. This is more convenient for users since they can adjust bindings without leaving the action they're configuring.

2. **Global settings are plugin-scoped** - "Global" means shared across all actions *within the same plugin*. This is how Stream Deck's `globalSettings` API works - it's per-plugin.

## Approach: EJS Templates with Custom Rollup Plugin

**Why EJS:**

- Mature, battle-tested (since 2010), minimal dependencies
- Simple partial syntax: `<%- include('partials/global-settings') %>`
- Full JavaScript support for passing data to partials
- Zero runtime overhead - compiles to static HTML
- Already using similar Mustache-style templates for icons

## File Structure

```
packages/
  stream-deck-plugin/
    src/
      pi-templates/                    # Template partials
        partials/
          global-key-bindings.ejs      # Key binding controls in accordion (reusable)
          accordion.ejs                # Reusable accordion component
          head-common.ejs              # Common <head> content
      build/
        pi-template-plugin.mjs         # Rollup plugin for EJS
      pi/                              # Source templates
        black-box-selector.ejs
        settings.ejs
        data/
          key-bindings.json            # Key binding definitions
      shared/
        pi/
          key-binding-input.ts         # `global` attribute support
    com.iracedeck.sd.core.sdPlugin/
      ui/                              # Output (compiled HTML)
```

**Note:** The build tooling and reusable UI partials live alongside the plugin code in `stream-deck-plugin`.

## Implementation Steps

### 1. Add EJS dependency to stream-deck-plugin

- `pnpm add ejs` in stream-deck-plugin
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
// Example: stream-deck-plugin/src/pi/data/key-bindings.json
{
  "blackBox": [
    { "id": "lapTiming", "label": "Lap Timing", "default": "F1", "setting": "keys.blackBox.lapTiming" },
    { "id": "standings", "label": "Standings", "default": "F2", "setting": "keys.blackBox.standings" }
  ]
}
```

The key bindings, accordion partial, and build tooling all live within `stream-deck-plugin`.

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
  <sdpi-item label="Mode">
    <sdpi-select setting="mode" default="direct">
      <option value="direct">Direct</option>
      <option value="next">Next</option>
    </sdpi-select>
  </sdpi-item>

  <%- include('global-key-bindings', {
    title: 'Black Box Key Bindings',
    keyBindings: require('./data/key-bindings.json').blackBox
  }) %>
</body>
</html>
```

**Output (`ui/black-box-selector.html`):** Static HTML with accordion inlined.

## Verification

1. Run `pnpm build` in stream-deck-plugin
3. Check `ui/black-box-selector.html` contains compiled accordion
4. Open Stream Deck, verify PI renders with collapsible key bindings
5. Verify key binding changes persist to global settings

## Files to Modify

- `packages/stream-deck-plugin/package.json` - Add ejs dependency
- `packages/stream-deck-plugin/src/build/pi-template-plugin.mjs` - Rollup plugin for EJS
- `packages/stream-deck-plugin/src/pi-templates/` - Template partials directory
- `packages/stream-deck-plugin/src/shared/pi/key-binding-input.ts` - Global attribute support
- `packages/stream-deck-plugin/rollup.config.mjs` - Add plugin
- `packages/stream-deck-plugin/src/pi/` - EJS template sources
