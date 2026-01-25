---
# Icon Guidelines

## Icon Types

- **Category icons** (`icon.svg`, 20x20): Must be monochrome white (`#ffffff`) on transparent background. No colors. Keep designs simple—text is often too small to read at this size.
- **Key icons** (`key.svg`, 72x72): Can use full color palette. These appear on Stream Deck buttons.
- **Template icons** (`{package}/icons/*.svg`): Mustache templates compiled into data URIs at build time.

SVG structure

- Use a 72x72 canvas with a required wrapper group controlling the activity-state filter:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    {icon content}
  </g>
</svg>
```

Design specs

- Canvas size: 72x72; safe area: 56x56 centered (8px margin).
- Stroke width: 2–2.5px main, 1–1.5px details.
- Colors: white `#ffffff`, green `#2ecc71`, red `#e74c3c`, yellow `#f1c40f`, gray `#888888`.

Templates

- Icon templates use Mustache placeholders and are stored in `{package}/icons/` and compiled into data URIs at build time.

Text and variants

- Use `generateIconText()` helper to insert user text safely (escape XML).
- For directional actions provide icon variants that reflect the chosen direction.

Distinctiveness

- Icons must be visually distinguishable from similar icons used by other actions.
- Use labels/badges (e.g., "BB" for black box actions) to differentiate action categories.
- When an icon concept is shared across actions (e.g., fuel), vary the icon style or add a category label.
