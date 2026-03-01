---
# Property Inspector Templates

## Overview

Property Inspector HTML files are built from EJS templates at compile time. This allows:
- Shared partials for common UI components
- Data-driven content from JSON files
- Consistent styling across plugins

## Directory Structure

```
packages/stream-deck-plugin-{name}/
├── src/pi/                    # EJS template sources
│   ├── action-name.ejs        # Action PI template
│   └── data/                  # JSON data files
│       └── key-bindings.json  # Key binding definitions
├── com.iracedeck.sd.{name}.sdPlugin/
│   └── ui/                    # Compiled HTML output
│       └── action-name.html   # Generated (do not edit)
```

## Creating a PI Template

### Basic Template Structure

```ejs
<!doctype html>
<html lang="en">
  <head>
    <%- include('head-common') %>
  </head>
  <body>
    <!-- Action-specific settings -->
    <sdpi-item label="Setting">
      <sdpi-select setting="mySetting" default="value">
        <option value="value">Label</option>
      </sdpi-select>
    </sdpi-item>

    <!-- Global settings section (if needed) -->
    <%- include('global-key-bindings', {
      subtitle: 'Category Name',
      keyBindings: require('./data/key-bindings.json').category
    }) %>

    <script>
      // PI-specific JavaScript
    </script>
  </body>
</html>
```

### Available Partials

Located in `packages/stream-deck-plugin/src/pi-templates/partials/`:

- **head-common.ejs** - Required scripts and common styles
- **accordion.ejs** - Collapsible section component
- **global-key-bindings.ejs** - Key bindings in collapsible "Global Settings" section

## Rollup Configuration

Add `piTemplatePlugin` to your plugin's rollup.config.mjs:

```javascript
import { piTemplatePlugin } from "./src/build/pi-template-plugin.mjs";

const sdPlugin = "com.iracedeck.sd.{name}.sdPlugin";

export default {
  plugins: [
    piTemplatePlugin({
      templatesDir: "src/pi",
      outputDir: `${sdPlugin}/ui`,
      partialsDir: "src/pi-templates/partials",
    }),
    // ... other plugins
  ],
};
```

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

## Build Output

- Templates in `src/pi/*.ejs` compile to `ui/*.html`
- The `data/` subdirectory is excluded from compilation
- Changes to templates or partials trigger rebuilds in watch mode
