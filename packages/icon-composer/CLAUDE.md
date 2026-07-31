# @iracedeck/icon-composer

Standalone SVG icon assembly and composition library for Stream Deck plugins. Contains all pure icon assembly functions with **zero runtime dependencies**.

## Package Contents

### SVG Utilities (`svg-utils.ts`)

- `svgToDataUri()` / `dataUriToSvg()` — SVG string to/from base64 data URI
- `isDataUri()` / `isRawSvg()` — Format detection helpers

Note: the base64 conversion uses Node's `Buffer`, so the package is Node-only despite having zero dependencies.

### Binding-Missing Warning Overlay (`binding-warning.ts`, issue #612)

- `BINDING_WARNING_GLYPH` / `bindingWarningSvg(canvas?)` — Centered warning-triangle snippet, authored for the 144×144 key canvas; pass `canvas` to recenter/rescale for other targets (e.g. the 200×100 dial touch strip)
- `dimForBindingWarning()` / `BINDING_WARNING_DIM_OPACITY` — Wraps existing artwork in a dim `<g opacity>` group beneath the triangle
- `applyBindingWarning()` — Composes the full overlay (dimmed content + triangle); shared by `assembleIcon()` and dynamic-template actions so both produce an identical overlay

Design constraint: the glyph uses only `polygon`, `rect` (with `rx`), and `circle` (plus the opacity group) so it renders on QT5 / SVG Tiny 1.2 (Mirabox) — no filters, masks, clipPath, or CSS. Keep it that way (see `.claude/rules/svg-platform-compatibility.md`).

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
- `parseIconBorderDefaults()` — Border defaults (`border` field), including a `locked` array for protecting border fields from global overrides (#755) — same semantics as the title `locked` array
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
- `computeGraphicArea()` — Computes available rectangle for graphic based on title placement. Uses `ResolvedTitleSettings.layoutText` (when set) instead of `titleText` to size the area — deck-core's template-resolving `resolveTitleSettings` wrapper (#899) sets it to the raw user template so live-resolved titles can't make the artwork jump size between empty and non-empty resolutions
- `applyGraphicTransform()` — Wraps content in a `<g transform>` to scale and center it within an available area. Static-icon callers pass `{x: 0, y: 0, width, height}` derived from the SVG's own viewBox; inline-assembled callers (car-control, pit-crew) pass bounds matching whatever coordinate space their content occupies.
- `assembleIcon()` — Full icon assembly: extracts artwork, applies colors, scales/positions the graphic into the title-aware available area using the SVG's viewBox dimensions, generates title, border, and wraps in base template. Accepts `bindingMissing?: boolean` — when true, applies the #612 warning overlay (dimmed artwork + centered triangle via `applyBindingWarning`) for static icons whose required binding is unset

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

None. This package has zero runtime dependencies. All functions are pure and self-contained. Border glow (`generateBorderParts()`, and the glow resolution in `resolveBorderSettings()`) is unconditional as of issue #642 — it no longer reads any platform feature-flag constant, so it renders the same on every platform. (The `borderGlow` feature flag and its `__FEATURE_BORDER_GLOW__` ambient global were retired when icon rendering moved to in-plugin PNG rasterization via `@iracedeck/rasterizer`; see `.claude/rules/svg-platform-compatibility.md` and `.claude/rules/platform-feature-flags.md`.)

## Relationship to deck-core

The `@iracedeck/deck-core` package re-exports all `icon-composer` symbols for backward compatibility and adds global settings readers (`getGlobalTitleSettings()`, `getGlobalBorderSettings()`, `getGlobalGraphicSettings()`) that depend on the global settings store.
