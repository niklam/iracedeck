---
paths:
  - packages/iracing-actions/src/actions/black-box-selector/*.ts
  - packages/iracing-actions/src/actions/black-box-selector/*.svg
  - packages/icons/black-box-selector/*
---
# Black Box Icon Design Guidelines

> **Extends**: [Default Key Icon Type](key-icon-types.md) with an inner black box frame.

Reference icons: `C:\Users\nikla\OneDrive\Tiedostot\Stream_Deck_Icons_THK_v2.1.5\Stream_Deck_Icons_v2.1.5\Function icons\color no-border flat\effects management\iracing blackbox\BB_*_Overlay.png`

## Graphic Snippet Icons (`packages/icons/black-box-selector/*.svg`)

These are the dynamic-render icons used by the black-box selector action. Each
icon's `viewBox` is trimmed to the artwork extent — typically `viewBox="0 0 114 58"`
for the standard list/data icons (frame width × frame height). The frame rect
sits flush against the viewBox edge (one stroke-width inset). `assembleIcon()`
scales each icon into the available area on the Stream Deck button at render
time using the SVG's own viewBox, so the design works at any final size.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 114 58">
  <desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff"},"title":{"text":"FUEL"},"border":{"color":"#5a5a5a"}}</desc>
  <!-- Frame fills the viewBox; coordinates start at (0, 0) -->
  <rect x="2" y="2" width="110" height="54" rx="6" fill="#2d2510" stroke="#4a3728" stroke-width="4"/>
  <!-- ... artwork inside the frame ... -->
</svg>
```

## Static Key Icon (`black-box-selector/key.svg`, 72x72)

```svg
<!-- Main background -->
<rect x="0" y="0" width="72" height="72" rx="8" fill="#2a2a2a"/>
```

- **Main background**: Dark gray (#2a2a2a), rounded corners (rx=8)
- **Icon area**: y=8 to y=36 (28px height)
- **Text area**: y=52 to y=65
- **Top margin**: 8px
- **Bottom margin**: 7px

## Inner Black Box Frame

All icons use a consistent inner frame:

```svg
<rect x="8" y="8" width="56" height="28" rx="3" fill="#2d2510" stroke="#4a3728" stroke-width="2"/>
```

- **Fill**: Dark olive (#2d2510)
- **Stroke**: Brown (#4a3728), 2px width
- **Dimensions**: 56x28, starts at (8,8)
- **Corner radius**: 3px

## Text Labels

Single-line labels at bottom:
- **Label** (name): bold, white (#ffffff), Arial
- Title text is rendered by `assembleIcon()` from the `<desc>` metadata

Label configurations:

| Black Box | Label |
|-----------|-------|
| Lap Timing | LAP TIMING |
| Standings | STANDINGS |
| Relative | RELATIVE |
| Fuel | FUEL |
| Tires | TIRES |
| Tire Info | TIRE INFO |
| Pit-stop | PIT-STOP |
| In-car | IN-CAR |
| Mirror (Graphics) | GRAPHICS |
| Radio | RADIO |
| Weather | WEATHER |
| Next | NEXT |
| Previous | PREVIOUS |

## Icon Layout Patterns

### Pattern 1: List Style (Standings, Relative)

Full-width rows inside the frame:
- Position dots on left (gold #f39c12, fading opacity)
- Data bars spanning most of width
- 1.5px height bars, 4px vertical spacing

### Pattern 2: Graphic + Data Display (Most icons)

Split layout inside the frame:
- **Left side**: Graphical element (tire, fuel pump, steering wheel, etc.) in gray (#888888)
- **Right side**: Text data display (values in yellow/green, labels in white/gray)
- Text starts around x=42-48

Example layout:
```
+----------------------------------+
| [GRAPHIC]    LABEL              |
|              VALUE (colored)     |
|              UNIT (gray)         |
+----------------------------------+
```

### Pattern 3: Full-Width Graphic (Mirror)

Graphic spans entire frame width (no data display).

## Colors

```typescript
const WHITE = "#ffffff";
const GRAY = "#888888";
const YELLOW = "#f39c12";  // Gold for position indicators, values
const ORANGE = "#e67e22";
const GREEN = "#2ecc71";   // Good values, positive states
const BLUE = "#3498db";    // Cold temperatures
const RED = "#e74c3c";     // Hot temperatures
```

## Icon-Specific Details

### Lap Timing
- Three rows: LAP, LAST, BEST
- Labels in gray, times in yellow/white/green
- Times at x=32

### Standings
- 6 rows with position dots and data bars
- Dots: gold with decreasing opacity (1.0, 0.85, 0.7, 0.55, 0.4, 0.25)
- Bars: varying widths for visual interest

### Relative
- 5 rows with colored position indicators
- Yellow/Orange = ahead, White = you, Green = behind
- Position boxes 4px wide, data bars follow

### Fuel
- Gray fuel pump on left (body + nozzle + gauge window)
- Fuel amount in yellow on right (e.g., "12.5 GAL")

### Tires
- Gray tire (concentric circles) on left
- Wear percentage in green on right (e.g., "FL 98% WEAR")

### Tire Info
- Tire with colored temperature arc (blue → green → yellow → red)
- Temperature in green on right (e.g., "TEMP 85°")

### Pit-stop
- Gray wrench + settings icon on left
- Pit service summary on right (FUEL amount, TIRES status)

### In-car
- Gray steering wheel on left
- Brake bias on right (e.g., "BIAS 52.0% FRONT")

### Graphics (Mirror)
- Full-width rearview mirror attached from top
- Glare lines for reflection effect
- No data display needed

### Radio
- Gray headset with microphone on left
- Channel info on right (e.g., "CH ALL")

### Weather
- Yellow sun and gray cloud on left
- Track temperature on right (e.g., "TRACK 24°C")
- Keep sun and cloud simple, must fit within frame

## SVG Template Structure

Do not wrap the `<g>` in `filter="url(#activity-state)"` — that filter id is never defined in emitted SVG (the inactive-overlay feature that would define it is disabled), and resvg does not render elements referencing an unresolvable filter, unlike the old QT renderers which silently ignored the dangling reference.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g>
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="#2a2a2a"/>

    <!-- Icon content area: y=8 to y=36 -->
    {{iconContent}}

    <!-- Two-line label -->
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{mainLabel}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="8">{{subLabel}}</text>
  </g>
</svg>
```

## Design Principles

1. **Fit within frame**: All icon content must stay within y=10 to y=34 (inside frame)
2. **Consistent frame**: Use the black box frame for all icons
3. **Gray graphics**: Main graphical elements use gray (#888888)
4. **Colored data**: Values use yellow (default), green (good/positive), blue (cold), red (hot)
5. **Thin elements**: Lines 1.5px, strokes 1-2px for graphics
6. **Simple shapes**: Icons must be recognizable at small sizes
7. **No clutter**: Keep designs clean and minimal
