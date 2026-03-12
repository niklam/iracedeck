---
# Icon Guidelines

## Icon Types

- **Category icons** (`icon.svg`, 20x20): Must be monochrome white (`#ffffff`) on transparent background. No colors. Keep designs simple—text is often too small to read at this size.
- **Key icons** (`key.svg`, 72x72): Can use full color palette. These appear on Stream Deck buttons. See [key-icon-types.md](key-icon-types.md) for standardized layouts.
- **Standalone icon SVGs** (`packages/icons/{action-name}/*.svg`): Complete, self-contained 144x144 SVG files with Mustache placeholders for labels. Imported at build time via `@iracedeck/icons/{action-name}/{variant}.svg`.
- **Dynamic templates** (`packages/stream-deck-plugin/icons/*.svg`): 72x72 Mustache templates for actions with telemetry-driven content that can't be pre-rendered as standalone SVGs.

## Standalone Icon SVGs (preferred)

Most action icons are standalone SVG files in the `@iracedeck/icons` package:

```
packages/icons/{action-name}/
├── next.svg
├── previous.svg
└── default.svg
```

### Structure (144x144)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" rx="16" fill="#BACKGROUND"/>

    <!-- Icon content area (y=18 to y=86) -->
    <!-- ... artwork ... -->

    <!-- Labels -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

### Import pattern

```typescript
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
```

The Rollup `svgPlugin` resolves `@iracedeck/icons/` to `packages/icons/`.

### Label placeholders

- **`{{mainLabel}}`** — prominent label (larger, bold, white `#ffffff`)
- **`{{subLabel}}`** — secondary label (smaller, white `#ffffff`)

## Dynamic Templates (for telemetry-driven content)

Actions where icon content changes at runtime based on telemetry (e.g., tire colors, speed values) keep their templates in `packages/stream-deck-plugin/icons/`. These use 72x72 viewBox and can have arbitrary placeholders.

Current dynamic templates: `car-control.svg`, `session-info.svg`, `tire-service.svg`.

## Design Specs

- Standalone icons: 144x144 canvas, rx=16 corners, all coordinates doubled from 72x72.
- Dynamic templates: 72x72 canvas, rx=8 corners.
- Stroke width: 2–2.5px main, 1–1.5px details (double for 144x144).
- Colors: white `#ffffff`, green `#2ecc71`, red `#e74c3c`, yellow `#f1c40f`, purple `#9b59b6`, gray `#888888`.

## Text and Variants

- Use `generateIconText()` helper for dynamic text in template-based icons.
- For directional actions provide icon variants that reflect the chosen direction.

## Distinctiveness

- Icons must be visually distinguishable from similar icons used by other actions.
- Use labels/badges (e.g., "BB" for black box actions) to differentiate action categories.
- When an icon concept is shared across actions (e.g., fuel), vary the icon style or add a category label.
