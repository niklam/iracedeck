---
# Icon Guidelines

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
