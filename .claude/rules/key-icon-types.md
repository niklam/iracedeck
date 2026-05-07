---
paths:
  - "**/icons/**/*.svg"
  - "packages/iracing-actions/src/actions/**/key.svg"
---
# Key Icon Types

This document defines standardized key icon type layouts. Standalone icon SVGs (`packages/icons/**/*.svg`) are graphic snippets whose `viewBox` is trimmed to the artwork's exact extent — they contain only artwork, Mustache color placeholders, and `<desc>` metadata. No background rect and no label text elements. Background, title text, and base layout are composed at render time by `assembleIcon()` using the SVG's own viewBox dimensions for centering and scaling. Key icons (`packages/iracing-actions/src/actions/<name>/key.svg`) are 72x72 static full-color SVGs with no Mustache placeholders.

## Default Key Icon Type

The standard layout for most action icons.

### Canvas Layout (trimmed-viewBox graphic snippet)

Icon SVGs contain only artwork — the viewBox IS the artwork bounding box, and the background/title/centering are assembled at render time:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 68">
  <desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"subLabel\nmainLabel"}}</desc>

  <!-- Coordinates start at (0, 0) and span the viewBox width/height -->
  {icon content using {{graphic1Color}} for eligible artwork}

</svg>
```

- **Background**: Added by `assembleIcon()` via `ICON_BASE_TEMPLATE` — no background rect in the source SVG
- **viewBox**: Variable per icon — trimmed to the exact artwork extent. Coordinates start at (0, 0).
- **Centering & scaling**: `assembleIcon()` reads the viewBox dimensions and fits the artwork into the available area (which shrinks when a title is shown), centered.
- **Title text**: Generated from `<desc>` title metadata and placed at the bottom by default

### Title Text System

Title text replaces the old `{{mainLabel}}`/`{{subLabel}}` placeholders. Each icon declares its default title in `<desc>`:

```json
{"colors": {...}, "title": {"text": "subLabel\nmainLabel"}}
```

- Prefer short, single-line titles (e.g., `"1x"`, `"DRS"`, `"STOP"`) — they are easier to read on small buttons
- Only use two-line `"subLabel\nmainLabel"` format when a single line cannot convey the action clearly
- Title is rendered at the bottom of the icon by `generateTitleText()` at render time
- Users can override title text, font size, position, and visibility via the Title Overrides section in the Property Inspector
- Actions can also supply a dynamic `actionDefaultText` string when calling `resolveTitleSettings()`

### Background Colors

Different actions can use different background colors to help distinguish them visually on the Stream Deck.

| Category | Color | Usage |
|----------|-------|-------|
| Default | #2a2a2a | General actions (e.g., black box selector) |
| Dark Purple | #412244 | Splits/delta timing actions |
| Dark Blue-Gray | #2a3444 | Data display actions (e.g., session info) |

Choose a background color that fits the action's theme. New colors can be added as needed — they should be dark enough for white text readability.

### Standard Color Palette

Use these colors consistently across all icons (literal hex values in SVG, no constants):

| Color | Hex | Usage |
|-------|-----|-------|
| White | #ffffff | Text, primary elements |
| Gray | #888888 | Secondary elements, graphics |
| Yellow | #f39c12 | Gold - values, position indicators |
| Orange | #e67e22 | Warnings, ahead indicators |
| Green | #2ecc71 | Positive states, good values |
| Blue | #3498db | Cold temperatures |
| Red | #e74c3c | Hot temperatures, errors |

### Graphic Snippet Template (trimmed viewBox)

All icon SVGs use this graphic snippet format with the viewBox trimmed to the artwork extent:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 68">
  <desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"CATEGORY\nACTION"}}</desc>

  <!-- Coordinates start at (0, 0) and span the viewBox width/height -->
  <!-- ... artwork using {{graphic1Color}} ... -->

</svg>
```

Prefer short, single-line titles — only use the two-line `"subLabel\nmainLabel"` format when a single line cannot convey the action clearly. When two lines are used, the first line is the secondary (smaller) label and the second line is the primary (bold) label. Titles are rendered at the bottom of the icon by `generateTitleText()` after `assembleIcon()` has scaled the artwork into the title-aware available area.

## Specialized Types

### Black Box Type

Extends Default Key Icon Type (Standard label layout) with an inner black box frame. See [black-box-icons.md](black-box-icons.md) for details.

- Adds inner black box frame (dark olive #2d2510, brown stroke #4a3728)
- Uses Standard label layout (primary name on top, secondary action on bottom)
- Background: #2a2a2a
- Reference: `packages/icons/black-box-selector/`

### Inverted Type

A convention for how the `title.text` is written in `<desc>`: the action word (e.g., NEXT) is on the second line (rendered bold), and the category is on the first line (rendered normally).

- Convention: `"title":{"text":"CATEGORY\nACTION"}` in `<desc>` — category first, action second
- Background color varies per action
- Reference: `packages/icons/splits-delta-cycle/`

### Data Display Type

Optimized for showing live telemetry values. Small title at top, large centered value. No icon content area — the value IS the content. Uses dynamic 144x144 template.

- **Title**: Small label at y=32 (18px, uses `{{textColor}}`)
- **Value**: Large bold centered text at dynamic y (~100, uses `{{textColor}}`, dynamic font size)
- **Background**: Dynamic — can change color for alert effects (e.g., flash red on incident), defaults to `{{backgroundColor}}`
- **Placeholders**: `{{backgroundColor}}`, `{{textColor}}`, `{{titleLabel}}`, `{{value}}`, `{{valueFontSize}}`
- Reference: `packages/iracing-plugin-stream-deck/icons/session-info.svg`
