---
# SVG Platform Compatibility

This project renders SVG icons across platforms with different SVG engines:

| Platform | SVG Engine | SVG Support |
|----------|-----------|-------------|
| **Elgato Stream Deck** | QT6 (6.7+) | SVG Tiny 1.2 + extended features (filters, masks, patterns, etc.) |
| **Mirabox VSD Craft** | QT5 | SVG Tiny 1.2 static only (via QtSVG module) |
| **Ulanzi Deck (UlanziStudio)** | renders SVG data-URIs (validated in UlanziDeck) | basic SVG confirmed; kept at the QT5 lower bound for filters/masks/patterns until those are exercised |

**Rule: All icons must render correctly on the lowest common denominator (QT5 / SVG Tiny 1.2 static).** Features unsupported by QT5 are silently ignored — the icon renders but without the effect.

For code paths that generate QT6-only SVG (e.g., filters), gate them behind platform feature flags so the Mirabox bundle doesn't ship unused code and the Mirabox PI doesn't show controls that have no effect. See `@.claude/rules/platform-feature-flags.md`.

**Ulanzi note (issue #508).** iRaceDeck passes its `data:image/svg+xml,...` icons through unchanged (`UlanziClient.setImage`), and this was **validated live in UlanziDeck** — the SVG data-URI icons render, so no rasterization fallback is needed. The Ulanzi `platform-features.json` still mirrors Mirabox's conservative QT5 baseline (filters/masks/patterns off) because only *basic* SVG has been exercised so far; widen a flag only once that specific feature is confirmed to render on Ulanzi.

## Safe to Use (both platforms)

These features are part of SVG Tiny 1.2 static and work on both Elgato and Mirabox:

| Feature | Notes |
|---------|-------|
| Basic shapes (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`) | Full support |
| `text`, `tspan` | Full support; `textPath` is NOT supported |
| `linearGradient`, `radialGradient` | Full support |
| `defs`, `use`, `g` | Full support for structure and reuse |
| Transforms (`translate`, `rotate`, `scale`, `skew`, `matrix`) | Full support |
| `opacity`, `fill-opacity`, `stroke-opacity` | Full support |
| Stroke properties (`stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, etc.) | Full support |
| Inline `style` attribute | Limited to SVG presentation properties |
| `image` element (embedded raster, data URIs) | Full support |
| `solidColor` | Full support |
| `foreignObject` | Partial (structural only, limited content rendering) |
| `viewBox`, `preserveAspectRatio` | Full support |

## Elgato Only (QT6.7+, NOT supported on Mirabox)

These features work on Elgato but are **silently ignored** on Mirabox. Do not rely on them for essential visual information:

| Feature | QT6.7+ Support Details |
|---------|----------------------|
| `filter` element | Supported. Attrs: x, y, width, height, filterUnits, primitiveUnits. No filterRes or xlink:href. |
| `feGaussianBlur` | Supported. stdDeviation only; edgeMode always `none`. |
| `feColorMatrix` | Supported. type and values attrs. |
| `feComposite` | Supported. operator, k1-k4 attrs. |
| `feFlood` | Supported. flood-color, flood-opacity. |
| `feMerge` / `feMergeNode` | Supported. |
| `feOffset` | Supported. dx, dy attrs. |
| `mask` | Supported. x, y, width, height, maskUnits, maskContentUnits. |
| `symbol` | Supported (SVG 2 with x, y, width, height). |
| `marker` | Supported. marker-start/mid/end on path, line, polyline, polygon. |
| `pattern` | Supported. No preserveAspectRatio or xlink:href. |

### Filter limitations (even on QT6.7+)

- Filters apply to **whole elements only** — `in` does not support FillPaint, StrokePaint, BackgroundImage, BackgroundAlpha
- No filter or mask chaining via xlink:href

## Not Supported on Either Platform

These features do not work on any target platform:

| Feature | Why |
|---------|-----|
| `<style>` element (embedded CSS) | Not in SVG Tiny 1.2; QT6 doesn't add it |
| CSS class-based styling | No `<style>` element support |
| `clipPath` | Explicitly not supported in QT6; limited/buggy in QT5 |
| `textPath` | Not in SVG Tiny 1.2; not in QT6 extensions |
| `feBlend` | Not in QT6 extensions |
| `feDropShadow` | SVG2/CSS shorthand, not supported |
| `feImage`, `feTurbulence`, `feDisplacementMap`, `feMorphology` | Not in QT6 extensions |
| `feConvolveMatrix`, `feDiffuseLighting`, `feSpecularLighting` | Not in QT6 extensions |
| `feComponentTransfer`, `feTile` | Not in QT6 extensions |
| SVG animations (`animate`, `animateTransform`, `animateMotion`, `set`) | Static profile only |
| External CSS stylesheets | No support |
| ECMA scripts / DOM manipulation | No support |

## Current Icon Feature Usage

The project's 700+ icon SVGs deliberately use a minimal feature set for maximum compatibility:

- **Widely used**: basic shapes, text/tspan, fill/stroke, opacity, stroke-dasharray, transforms, viewBox, rx (rounded corners)
- **Moderately used**: defs/use (favicon files), Mustache template placeholders for runtime color/text
- **Not used**: filters, masks, gradients, patterns, clipPath, markers, animations, embedded images (except favicons)

This minimal approach is correct — it ensures cross-platform consistency.

## Guidelines for New Icons

1. **Stick to the safe feature set.** Basic shapes, text, fill/stroke, opacity, and transforms cover all current needs.
2. **Do not use filters for essential visual information.** If a glow or shadow is purely decorative and the icon reads fine without it, a filter is acceptable as progressive enhancement on Elgato — but document that it degrades on Mirabox.
3. **Do not use `clipPath`** — it's broken on both platforms.
4. **Do not use `<style>` elements** — use inline `style` attributes or direct SVG presentation attributes instead.
5. **Test cross-platform** when introducing any SVG feature not already in use. If in doubt, check this table.

## Binding-missing warning glyph (#612)

The centered ⚠️ overlay drawn on a key when a required binding is unset (`assembleIcon({ bindingMissing })` / `bindingWarningSvg()` in `@iracedeck/icon-composer`) is built **only** from `polygon`, `rect` (with `rx`), `circle`, and a `<g opacity="…">` dim wrapper — all in the safe SVG Tiny 1.2 set — so it renders identically on Mirabox's QT5 engine. It uses no filters, masks, `clipPath`, or `<style>`/class-based styling. Keep it that way: the overlay must render on the lowest common denominator since a missing binding is essential information.

## Reference Documentation

- QT5 SVG rendering: https://doc.qt.io/qt-5/svgrendering.html
- QT6 SVG rendering: https://doc.qt.io/qt-6/svgrendering.html
- QT6 SVG extensions: https://doc.qt.io/qt-6/svgextensions.html
- QT 6.7 changelog (SVG filter additions): https://doc.qt.io/qt-6/whatsnew67.html
- SVG Tiny 1.2 spec: https://www.w3.org/TR/SVGTiny12/
