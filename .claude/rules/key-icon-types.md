---
paths:
  - "**/icons/*.svg"
  - "**/imgs/actions/**/key.svg"
  - "**/src/icons/*.ts"
---
# Key Icon Types

This document defines standardized icon types for Stream Deck key icons (72x72). When creating key icons, specify which type to use.

## Default Key Icon Type

The standard layout for most action icons.

### Canvas Layout (72x72)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="{background-color}"/>

    <!-- Icon content area: y=8 to y=40 -->
    {icon content}

    <!-- Two-line label area: y=48 to y=68 -->
    <text x="36" y="52" ...>{line1}</text>
    <text x="36" y="63" ...>{line2}</text>
  </g>
</svg>
```

- **Background**: Rounded corners (rx=8), color varies by category
- **Icon area**: y=8 to y=40 (32px height)
- **Text area**: y=48 to y=68

### Two-Line Label System

Labels use two lines with primary (bold, prominent) and secondary (subdued) styling:

| Label Type | Font Size | Weight | Color |
|------------|-----------|--------|-------|
| Primary | 10px | bold | #ffffff |
| Secondary | 8px | normal | #aaaaaa |

Both lines are centered horizontally (text-anchor="middle", x=36).

There are two label layouts:

**Standard** (line1 = primary on top, line2 = secondary on bottom):
- Used when the category/name is the most important info (e.g., "STANDINGS" / "toggle")
- Template: `{{labelLine1}}` at y=52 (primary), `{{labelLine2}}` at y=63 (secondary)
- Reference: `packages/stream-deck-plugin-core/icons/black-box-selector.svg`

**Inverted** (line2 = secondary on top, line1 = primary on bottom):
- Used when the action/direction word is more important than the category (e.g., "splits delta" / "NEXT")
- Template: `{{labelLine2}}` at y=52 (secondary), `{{labelLine1}}` at y=63 (primary)
- Reference: `packages/stream-deck-plugin-core/icons/splits-delta-cycle.svg`

### Background Colors

Different actions can use different background colors to help distinguish them visually on the Stream Deck.

| Category | Color | Usage |
|----------|-------|-------|
| Default | #2a2a2a | General actions (e.g., black box selector) |
| Dark Purple | #412244 | Splits/delta timing actions |

Choose a background color that fits the action's theme. New colors can be added as needed — they should be dark enough for white text readability.

### Standard Color Palette

Use these colors consistently across all icons:

```typescript
const WHITE  = "#ffffff";           // Text, primary elements
const GRAY   = "#888888";           // Secondary elements, graphics
const YELLOW = "#f39c12";           // Gold - values, position indicators
const ORANGE = "#e67e22";           // Warnings, ahead indicators
const GREEN  = "#2ecc71";           // Positive states, good values
const BLUE   = "#3498db";           // Cold temperatures
const RED    = "#e74c3c";           // Hot temperatures, errors
```

### Standard Template

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="{background-color}"/>

    <!-- Icon content area: y=8 to y=40 -->
    {{iconContent}}

    <!-- Two-line label: line1 primary on top, line2 secondary on bottom -->
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{labelLine1}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="8">{{labelLine2}}</text>
  </g>
</svg>
```

### Inverted Template

Used when the action word (e.g., NEXT/PREVIOUS) should be more prominent than the category name.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="{background-color}"/>

    <!-- Icon content area: y=9 to y=43 -->
    {{iconContent}}

    <!-- Inverted label: line2 secondary on top, line1 primary on bottom -->
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="8">{{labelLine2}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{labelLine1}}</text>
  </g>
</svg>
```

## Icon Content Separation

When an action has multiple icon variants (like black box selector with 11+ icons), define icon content in separate files:

```
packages/stream-deck-plugin-{name}/
├── src/
│   ├── actions/
│   │   └── my-action.ts          # Action logic only
│   └── icons/
│       └── my-action-icons.ts    # Icon SVG content definitions
└── icons/
    └── my-action.svg             # Template file
```

**Icon definition file pattern:**
```typescript
// src/icons/my-action-icons.ts
export const MY_ACTION_ICONS: Record<string, string> = {
  "variant-a": `<rect ... />`,
  "variant-b": `<circle ... />`,
};

export const MY_ACTION_LABELS: Record<string, { primary: string; secondary: string }> = {
  "variant-a": { primary: "ACTION", secondary: "description" },
};
```

## Specialized Types

### Black Box Type

Extends Default Key Icon Type (Standard label layout) with an inner frame. See [black-box-icons.md](black-box-icons.md) for details.

- Adds inner black box frame (dark olive #2d2510, brown stroke #4a3728)
- Uses Standard label layout (primary name on top, secondary action on bottom)
- Background: #2a2a2a
- Reference: `packages/stream-deck-plugin-core/src/actions/black-box-selector.ts`

### Inverted Type

Uses the Inverted label layout where the action word is prominent (bottom, bold) and the category is subdued (top, small).

- Category/context label on top (secondary), action word on bottom (primary)
- Background color varies per action
- Reference: `packages/stream-deck-plugin-core/src/actions/splits-delta-cycle.ts`
