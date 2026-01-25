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

Labels use flexible positioning—the **primary** (important) word can be on line 1 OR line 2 based on readability:

| Label Type | Font Size | Weight | Color | Y Position |
|------------|-----------|--------|-------|------------|
| Primary | 10px | bold | #ffffff | 52 or 63 |
| Secondary | 8px | normal | #aaaaaa | 52 or 63 |

**Examples:**
- "STANDINGS" (primary) / "toggle" (secondary) → primary on line 1
- "Seat" (secondary) / "FORWARD" (primary) → primary on line 2 (action word emphasized)

Both lines are centered horizontally (text-anchor="middle", x=36).

### Background Colors

| Category | Color | Usage |
|----------|-------|-------|
| Default | #2a2a2a | General actions |
| *(more to be added)* | | |

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

### Template Structure

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="#2a2a2a"/>

    <!-- Icon content area: y=8 to y=40 -->
    {{iconContent}}

    <!-- Two-line label -->
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{labelLine1}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="8">{{labelLine2}}</text>
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

Extends Default Key Icon Type with an inner frame. See [black-box-icons.md](black-box-icons.md) for details.

- Adds inner black box frame (dark olive #2d2510, brown stroke #4a3728)
- Used for iRacing black box screen actions

*(More types will be added as needed)*
