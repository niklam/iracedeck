---
paths:
  - "**/icons/**/*.svg"
  - "**/imgs/actions/**/key.svg"
---
# Key Icon Types

This document defines standardized icon types for Stream Deck key icons. Most icons are now standalone 144x144 SVGs in `packages/icons/`. A few dynamic templates remain at 72x72 in `packages/stream-deck-plugin/icons/`.

## Default Key Icon Type

The standard layout for most action icons.

### Canvas Layout (144x144 standalone)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="144" height="144" rx="16" fill="{background-color}"/>

    <!-- Icon content area: y=18 to y=86 -->
    {icon content}

    <!-- Two-line label area -->
    <text x="72" y="104" ...>{subLabel}</text>
    <text x="72" y="126" ...>{mainLabel}</text>
  </g>
</svg>
```

- **Background**: Rounded corners (rx=16), color varies by category
- **Icon area**: y=18 to y=86 (68px height)
- **Text area**: y=100 to y=136

### Two-Line Label System

Labels use two lines with primary (bold, prominent) and secondary (subdued) styling:

| Label Type | Font Size (144) | Font Size (72) | Weight | Color |
|------------|-----------------|-----------------|--------|-------|
| Primary (`{{mainLabel}}`) | 20px | 10px | bold | #ffffff |
| Secondary (`{{subLabel}}`) | 16px | 8px | normal | #ffffff |

Both lines are centered horizontally (text-anchor="middle").

There are two label layouts:

**Standard** (mainLabel on top, subLabel on bottom):
- Used when the category/name is the most important info (e.g., "STARTER" / "car control")
- `{{mainLabel}}` at y=104 (primary), `{{subLabel}}` at y=126 (secondary)
- Reference: `packages/icons/car-control/starter.svg`

**Inverted** (subLabel on top, mainLabel on bottom):
- Used when the action/direction word is more important than the category (e.g., "splits delta" / "NEXT")
- `{{subLabel}}` at y=104 (secondary), `{{mainLabel}}` at y=126 (primary)
- Reference: `packages/icons/splits-delta-cycle/next.svg`

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

### Standard Template (144x144)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="144" height="144" rx="16" fill="{background-color}"/>

    <!-- Icon content area: y=18 to y=86 -->
    <!-- ... artwork ... -->

    <!-- Two-line label: mainLabel primary on top, subLabel secondary on bottom -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
  </g>
</svg>
```

### Inverted Template (144x144)

Used when the action word (e.g., NEXT/PREVIOUS) should be more prominent than the category name.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="144" height="144" rx="16" fill="{background-color}"/>

    <!-- Icon content area: y=18 to y=86 -->
    <!-- ... artwork ... -->

    <!-- Inverted label: subLabel secondary on top, mainLabel primary on bottom -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

## Specialized Types

### Black Box Type

Extends Default Key Icon Type (Standard label layout) with an inner black box frame. See [black-box-icons.md](black-box-icons.md) for details.

- Adds inner black box frame (dark olive #2d2510, brown stroke #4a3728)
- Uses Standard label layout (primary name on top, secondary action on bottom)
- Background: #2a2a2a
- Reference: `packages/icons/black-box-selector/`

### Inverted Type

Uses the Inverted label layout where the action word is prominent (bottom, bold) and the category is subdued (top, small).

- Category/context label on top (secondary), action word on bottom (primary)
- Background color varies per action
- Reference: `packages/icons/splits-delta-cycle/`

### Data Display Type

Optimized for showing live telemetry values. Small title at top, large centered value. No icon content area — the value IS the content. Uses dynamic 72x72 template.

- **Title**: Small white label at y=16 (#ffffff, 9px)
- **Value**: Large bold centered text at y=50 (#ffffff, dynamic font size)
- **Background**: Dynamic — can change color for alert effects (e.g., flash red on incident)
- **Placeholders**: `{{backgroundColor}}`, `{{titleLabel}}`, `{{value}}`, `{{valueFontSize}}`
- Reference: `packages/stream-deck-plugin/icons/session-info.svg`
