---
title: Designing Icons
description: Format, file structure, and technical requirements for designing icons or a full alternative icon set for iRaceDeck.
---

Want to design icons for iRaceDeck — a few replacements or a whole alternative set? This page is the contract: what an icon file must look like, how files are named and organized, and what happens to your artwork at runtime. The [icon gallery](/docs/development/icon-gallery/) is the authoritative inventory of everything a set can cover.

## Icons are artwork snippets, not finished keys

An iRaceDeck icon is **only the artwork**. The plugin composes the final key at runtime: it places your artwork on a background, adds the title text, and draws an optional border — all user-configurable. That means:

- **No background rectangle.** The plugin draws the background; your SVG contains just the graphic.
- **No title text baked into the artwork.** Titles are rendered by the plugin (users can restyle, move, or hide them). Text that is an integral part of the *graphic* (like the word "START" on a starter button) is fine.
- **Trimmed viewBox.** The `viewBox` hugs the artwork extent plus a 1-unit margin on every side so strokes don't clip. Don't leave a full-canvas viewBox around small artwork — the composer scales artwork by its viewBox.
- **Stroke weights at reference scale.** Author strokes as if the canvas were 144×144: 4–5px for main shapes, 2–3px for details. The composer keeps proportions correct at any trimmed size.

## Color slots

Icons can expose up to four recolorable slots as literal `{{placeholder}}` strings in fill/stroke attributes. Users can then recolor your set globally or per key:

| Slot | Placeholder | Typical use |
|------|-------------|-------------|
| Background | `{{backgroundColor}}` | Background rect fill (rare inside artwork) |
| Text | `{{textColor}}` | Label text fills |
| Primary graphic | `{{graphic1Color}}` | Main artwork strokes/fills |
| Secondary graphic | `{{graphic2Color}}` | Accent shapes (rare) |

Fixed colors are equally valid — semantic data colors must stay fixed: green `#2ecc71`, red `#e74c3c`, yellow `#f39c12`, blue `#3498db`, purple `#9b59b6`, white `#ffffff`, gray `#888888`.

## The `<desc>` metadata block

Every icon carries a first-child `<desc>` element with a JSON object declaring its defaults:

```json
{
  "colors": { "backgroundColor": "#3a2a2a", "textColor": "#ffffff", "graphic1Color": "#ffffff" },
  "locked": ["graphic1Color"],
  "title": { "text": "ADD FUEL\n+1 L" },
  "border": { "color": "#6a5a5a" }
}
```

- `colors` — the default value for each slot the icon uses.
- `locked` — slots that global color presets must not override (use when your artwork mixes a recolorable slot with hardcoded semantic colors that would clash under user presets).
- `title.text` — the icon's default title (`\n` for a second line; never start with `\n`).
- `border.color` — the default border color when the user enables borders.

## Renderer constraints

Icons are rasterized by [resvg](https://github.com/linebender/resvg). Safe, always-supported features: basic shapes, paths, `text`/`tspan`, gradients, `defs`/`use`/`g`, transforms, opacity, stroke properties, `viewBox`. **Never use:** `<style>` elements or CSS classes, `textPath`, animations, scripts, or external references. Keep effects like filters and masks to progressive enhancement — they must not carry essential information.

## File structure and naming — mirror the default set exactly

The default set lives in family folders, one SVG per icon variant:

```text
<family>/<variant>.svg        e.g. fuel-service/add-fuel.svg
```

An alternative icon set must **mirror these paths and names exactly** — the path is the key the plugin uses to match your icon to its slot, and any icon your set doesn't provide falls back to the default artwork. Browse every family, name, and current design in the [icon gallery](/docs/development/icon-gallery/).

## Scope of a v1 icon set

- **In scope:** the key icon templates (the "Key icon templates" section of the gallery — the vast majority of what users see).
- **Out of scope for now (stays default):** dynamic telemetry-driven templates, static default key images, dial icons, and category icons. These are documented in the gallery for completeness and may open up to sets later.

## How a set ships

Alternative icon sets are bundled with the plugin and selected via a dropdown in the plugin's global settings. Matching is per icon with automatic fallback to the default set — so a partial set works fine, and a set can grow release by release.

## Delivering a set

Hand over a zip (or a pull request) preserving the `family/variant.svg` structure. Artwork you contribute ships inside the plugin, so it needs a license compatible with redistribution — talk to us on [Discord](https://discord.gg/c6nRYywpah) and we'll sort out attribution and terms together.
