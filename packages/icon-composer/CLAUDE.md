# @iracedeck/icon-composer

Standalone SVG icon assembly and composition library for Stream Deck plugins. Contains all pure icon assembly functions with **zero runtime dependencies**.

## Package Contents

### SVG Utilities (`svg-utils.ts`)

- `svgToDataUri()` / `dataUriToSvg()` — SVG string to/from base64 data URI
- `isDataUri()` / `isRawSvg()` — Format detection helpers

### Icon Base Template (`icon-base.ts`)

- `ICON_BASE_TEMPLATE` — Base 144x144 SVG template with background, border, graphic, and title slots
- `extractGraphicContent()` — Strips outer SVG wrapper, `<desc>`, background rect, and label text from a graphic snippet SVG, leaving only artwork
- `generateBorderParts()` — Generates border SVG `defs` and `rects` from resolved border settings

### Icon Template Rendering (`icon-template.ts`)

- `renderIconTemplate()` — Replaces `{{placeholder}}` Mustache-style markers in SVG strings
- `escapeXml()` — Escapes special XML characters for safe SVG text insertion
- `generateIconText()` — Generates SVG `<text>` elements for multi-line icon labels
- `validateIconTemplate()` — Validates SVG template structure (viewBox, namespace, filter group)

**Metadata Parsers** (all read from `<desc>` JSON in SVG):
- `parseDescMetadata()` — Raw JSON parser for `<desc>` element
- `parseIconDefaults()` — Color slot defaults (`colors` field)
- `parseIconTitleDefaults()` — Title defaults (`title` field), including `showTitle` and `locked` array for protecting fields from global overrides
- `parseIconBorderDefaults()` — Border defaults (`border` field)
- `parseIconLocked()` — Locked color slot names (`locked` field)
- `resolveIconColors()` — Merges per-action overrides, global defaults, and icon defaults

**SVG Root Parser:**
- `parseSvgViewBox()` — Reads the root `<svg viewBox>` attribute. For trimmed icons the viewBox dimensions ARE the artwork extent, so this replaces the older `artworkBounds` `<desc>` field that used to declare the bounding box separately.

### Title, Border, Graphic Settings & Assembly (`title-settings.ts`)

- `resolveTitleSettings()` — Merges per-action, global, icon default, and hardcoded title settings; respects `locked` title fields from `<desc>` metadata (skips global for locked fields)
- `resolveBorderSettings()` — Merges per-action, global, icon default, and hardcoded border settings
- `resolveGraphicSettings()` — Merges per-action graphic overrides and global graphic settings
- `generateTitleText()` — Generates positioned SVG title text elements
- `calculateYPositions()` — Computes Y positions for title text lines by placement mode
- `computeGraphicArea()` — Computes available rectangle for graphic based on title placement
- `applyGraphicTransform()` — Wraps content in a `<g transform>` to scale and center it within an available area. Static-icon callers pass `{x: 0, y: 0, width, height}` derived from the SVG's own viewBox; inline-assembled callers (car-control, pit-crew) pass bounds matching whatever coordinate space their content occupies.
- `assembleIcon()` — Full icon assembly: extracts artwork, applies colors, scales/positions the graphic into the title-aware available area using the SVG's viewBox dimensions, generates title, border, and wraps in base template

**Defaults:**
- `TITLE_DEFAULTS` — Hardcoded title fallbacks (showTitle, bold, fontSize, position)
- `BORDER_DEFAULTS` — Hardcoded border fallbacks (enabled, width, color, glow)
- `GRAPHIC_DEFAULTS` — Hardcoded graphic fallbacks (scale: 100)

## Build

```bash
pnpm build  # tsc → dist/
```

Pure TypeScript library, no Rollup needed. Outputs ESM with declarations.

## Dependencies

None. This package has zero runtime dependencies. All functions are pure and self-contained.

## Relationship to deck-core

The `@iracedeck/deck-core` package re-exports all `icon-composer` symbols for backward compatibility and adds global settings readers (`getGlobalTitleSettings()`, `getGlobalBorderSettings()`, `getGlobalGraphicSettings()`) that depend on the global settings store.
