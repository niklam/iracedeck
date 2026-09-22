---
paths:
  - packages/iracing-actions/src/actions/black-box-selector/*.ts
  - packages/iracing-actions/src/actions/black-box-selector/*.svg
  - packages/icons/black-box-selector/*
---
# Black Box Icon Design Guidelines

> **Extends**: [Default Key Icon Type](key-icon-types.md) with an inner black box frame. Redesigned in #827, which drew the set in a rich (gradient) language first and then shipped it in the flat style every file now uses — the "Plain vocabulary" addendum of `docs/superpowers/specs/2026-07-12-icon-redesign-design.md` records that switch. #1158 replaced the Mirror Adjustments icon with Quick Access.

## Graphic Snippet Icons (`packages/icons/black-box-selector/*.svg`)

These are the dynamic-render icons used by the black-box selector action. Each icon uses `viewBox="0 0 81.3 49.3"` — the frame's outer stroke edge plus about one unit of anti-clip margin — and wraps its artwork in `<g transform="translate(-7.2 -9.2)">`, so every file authors the frame and its content in the same coordinates. `assembleIcon()` scales each icon into the available area on the key at render time.

## Inner Black Box Frame (the family identity)

All 13 icons share one flat frame, filled with the key background and outlined in the primary graphic colour:

```svg
<rect x="10" y="12" width="76" height="44" rx="6" fill="{{backgroundColor}}" stroke="{{graphic1Color}}" stroke-width="3.5"/>
```

- **Fill**: `{{backgroundColor}}`, so the frame reads as an outline on the key rather than a panel
- **Stroke**: `{{graphic1Color}}`, 3.5px
- **No gradients, filters or glow** (each file keeps an empty `<defs>`), and **no top highlight bar**
- Content must stay fully inside the frame border (nothing may cross the stroke) — the stroke's inner edge is at x 11.75–84.25, y 13.75–54.25
- Every file declares the same `<desc>` colour slots (`backgroundColor` `#2a2a2a`, `textColor` `#ffffff`, `graphic1Color` `#ffffff`, `graphic2Color` `#4fc3f7`) and border colour `#5a5a5a`

## Per-icon content

Content is flat: linework and silhouettes in `{{graphic1Color}}`, interior details as `{{backgroundColor}}` cut-outs, and fixed data colours where the colour carries the information — amber `#f6d34c` (data text `#f7d94c`), green `#2ecc71`, red `#e74c3c`, and dark ink `#241c0a` for anything drawn on amber. Only weather uses `{{graphic2Color}}`.

| Icon | Content |
|------|---------|
| fuel | amber droplet + amber `12.5` + level bar |
| tires | 4 corner tire blocks colored by state (green/green/amber/red) + front and rear axles joined by a spine |
| tire-info | tire tread cross-section + inner/middle/outer temp bars (green/amber/red) |
| pit-stop | crossed wrench + screwdriver (X) — Pit Stop Adjustments is wings/setup, not fuel/tires |
| lap-timing | small stopwatch (r≈10.5) + amber `1:23.4` |
| in-car | momo steering wheel + two slider tracks |
| quick-access | a settings menu of three rows, each a short `{{graphic1Color}}` label bar on the left: rows 1 and 3 end in a right-pointing chevron (a sub-page), row 2 in an amber toggle switch in its on position (`#241c0a` knob to the right). The action's id for this box is still `mirror` |
| radio | microphone + amber level bars |
| relative | three full-width rows, middle row amber (you), the other two muted (`#4a3f22`) |
| standings | podium bars, amber winner with `1` |
| weather | small cloud + cyan rain, clear of the border |
| next / previous | double chevrons pointing the cycle direction: the rear chevron solid, the one ahead of it at 55% opacity |

Quick Access deliberately avoids Relative's language: no row is filled edge to edge and no row is highlighted as a whole, because three full-width rows with one picked out in amber is what identifies Relative. The chevrons and the switch carry Quick Access's identity instead.

## Text Labels

Single-line labels (FUEL, TIRES, QUICK ACCESS, …) render via the title system — no text elements in the artwork except in-frame data values (`12.5`, `1:23.4`) and glyph text (Standings' `1`). The label a key shows comes from `BLACK_BOX_TITLE_TEXT` in `black-box-selector.ts`, which overrides the `<desc>` title, so change both together: editing only the `<desc>` changes nothing on the key.

## Static Key Icon (`black-box-selector/key.svg`, 72×72)

Full-color static derived from the fuel box composition on the `#2a2a2a` background (regenerated in #827).
