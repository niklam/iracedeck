---
paths:
  - packages/stream-deck-plugin-core/src/actions/black-box-selector.ts
  - packages/stream-deck-plugin-core/icons/black-box-selector.svg
  - packages/stream-deck-plugin-core/com.iracedeck.sd.core.sdPlugin/imgs/actions/black-box-selector/*
---
# Black Box Icon Design Guidelines

> **Extends**: [Default Key Icon Type](key-icon-types.md) with an inner black box frame.

Reference icons: `C:\Users\nikla\OneDrive\Tiedostot\Stream_Deck_Icons_THK_v2.1.5\Stream_Deck_Icons_v2.1.5\Function icons\color no-border flat\effects management\iracing blackbox\BB_*_Overlay.png`

## Canvas Layout (72x72)

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

Two-line labels at bottom:
- **Line 1** (name): y=52, font-size 10px, white (#ffffff), bold, Arial
- **Line 2** (action): y=63, font-size 8px, light gray (#aaaaaa), Arial

Label configurations:
| Black Box | Line 1 | Line 2 |
|-----------|--------|--------|
| Lap Timing | LAP TIMING | TOGGLE |
| Standings | STANDINGS | TOGGLE |
| Relative | RELATIVE | TOGGLE |
| Fuel | FUEL | ADJUSTMENTS |
| Tires | TIRES | ADJUSTMENTS |
| Tire Info | TIRE INFO | TOGGLE |
| Pit-stop | PIT-STOP | ADJUSTMENTS |
| In-car | IN-CAR | ADJUSTMENTS |
| Mirror (Graphics) | GRAPHICS | ADJUSTMENTS |
| Radio | RADIO | CHANNELS |
| Weather | WEATHER | FORECAST |

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

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <!-- Main background -->
    <rect x="0" y="0" width="72" height="72" rx="8" fill="#2a2a2a"/>

    <!-- Icon content area: y=8 to y=36 -->
    {{iconContent}}

    <!-- Two-line label -->
    <text x="36" y="52" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="10" font-weight="bold">{{labelLine1}}</text>
    <text x="36" y="63" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="8">{{labelLine2}}</text>
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
