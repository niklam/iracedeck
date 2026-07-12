---
paths:
  - packages/iracing-actions/src/actions/black-box-selector/*.ts
  - packages/iracing-actions/src/actions/black-box-selector/*.svg
  - packages/icons/black-box-selector/*
---
# Black Box Icon Design Guidelines

> **Extends**: [Default Key Icon Type](key-icon-types.md) with an inner black box frame. Redesigned in #827 to the rich (gradient) icon language; approved reference compositions are recorded in `docs/superpowers/specs/2026-07-12-icon-redesign-design.md`.

## Graphic Snippet Icons (`packages/icons/black-box-selector/*.svg`)

These are the dynamic-render icons used by the black-box selector action. Each icon uses `viewBox="0 0 96 68"` with the shared frame filling most of the canvas. `assembleIcon()` scales each icon into the available area on the key at render time.

## Inner Black Box Frame (the family identity)

All 13 icons share one frame — an olive glass panel that separates clearly from the `#2a2a2a` key background:

```svg
<rect x="10" y="12" width="76" height="44" rx="6" fill="url(#bbG2)" stroke="#6a5138" stroke-width="3.5"/>
```

- **Fill**: vertical gradient `#453a1c → #221a0a` (`bbG2` in each file's `<defs>`)
- **Stroke**: `#6a5138`, 3.5px
- **No top highlight bar** (removed during review — read as a mistake)
- Content must stay fully inside the frame border (nothing may cross the stroke)

## Per-icon content

Content uses natural data colors (amber/green/red gradients, metal `mtl` gradient driven by `{{graphic1Color}}`):

| Icon | Content |
|------|---------|
| fuel | amber droplet + amber `12.5` + level bar |
| tires | 4 corner tire blocks colored by state (green/green/amber/red) + axle cross |
| tire-info | tire tread cross-section + inner/middle/outer temp bars (green/amber/red) |
| pit-stop | crossed wrench + screwdriver (X), 0.8 scale — Pit Stop Adjustments is wings/setup, not fuel/tires |
| lap-timing | small stopwatch (r≈10.5) + amber `1:23.4` |
| in-car | momo steering wheel + two slider tracks |
| mirror | wide glass mirror filling the frame, top mount tab, reflection streaks (note: shipped `<desc>` title is "GRAPHICS") |
| radio | microphone + amber level bars |
| relative | three rows, middle row amber (you) |
| standings | podium bars, amber winner with `1` |
| weather | small cloud + cyan rain, clear of the border |
| next / previous | double chevrons (leading bright, trailing 55% opacity) |

## Text Labels

Single-line labels (FUEL, TIRES, …) come from `<desc>` title metadata and render via the title system — no text elements in the artwork except in-frame data values (`12.5`, `1:23.4`) and glyph text.

## Static Key Icon (`black-box-selector/key.svg`, 72×72)

Full-color static derived from the fuel box composition on the `#2a2a2a` background (regenerated in #827).
