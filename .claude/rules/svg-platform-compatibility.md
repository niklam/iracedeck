---
# SVG Platform Compatibility

Icons are no longer rendered by each deck host's own SVG engine. Since issue #642, every plugin rasterizes its device-bound SVG icons to PNG **in-plugin** via `@iracedeck/rasterizer` (a thin wrapper over `@resvg/resvg-js`) before the pixels ever reach Elgato, Mirabox, or Ulanzi hardware — see `packages/deck-core/src/rasterizer-service.ts` and `.claude/rules/platform-feature-flags.md`. That means Elgato's QT6.7+ engine and Mirabox/Ulanzi's QT5 engine are no longer the rendering bottleneck: **resvg is the one SVG engine that matters for authoring**, and it renders the same PNG bytes for every platform.

**Authoring baseline: resvg's SVG 1.1-static support.** Filters, masks, patterns, and `clipPath` are now allowed — resvg renders all of them, and because the output is a plain PNG, there is no more per-host divergence to worry about. Still unsupported, on resvg as on every prior engine: `<style>` elements (embedded/external CSS), SVG animations (`animate*`, `set`), and ECMAScript/DOM scripting — resvg is a static renderer with no script or animation engine. Treat any SVG feature not already in use as untested until you've rendered it through the actual pipeline (`pnpm build` + inspect the emitted PNG), the same discipline as before.

## The kill-switch caveat — `pngRasterization`

PNG rasterization is gated behind the `pngRasterization` platform feature flag (temporary; true on all three platforms today, see `.claude/rules/platform-feature-flags.md`). With the flag off — e.g. forced off locally via `feature-flags.local.json` for debugging — `initializeRasterizer()` is never called, the rasterizer service stays uninitialized, and every adapter falls back to sending the raw SVG data URI, which puts each host back on its **own** SVG engine (QT6.7+ on Elgato, QT5 on Mirabox/Ulanzi). QT5 does not support filters, masks, patterns, or `clipPath` — they render as if absent.

**Until `pngRasterization` is deleted as a flag (i.e., made permanent), do not make a filter/mask/pattern/`clipPath` effect carry essential visual information** — a glow, a soft shadow, a gradient halo are fine as progressive enhancement, but the icon must still read correctly with that effect silently missing. This is the same discipline the old QT5-vs-QT6 split required, just keyed to a different (and hopefully shorter-lived) toggle. Once the flag is removed and rasterization is unconditional, this restriction can be lifted and revisited.

## Fonts

Icon title text keeps `font-family="Arial, sans-serif"` unchanged — no icon SVG needed to change. `@iracedeck/rasterizer` bundles Arimo Regular/Bold (metric-compatible with Arial, OFL-licensed; `packages/rasterizer/fonts/`, copied into each sdPlugin's `assets/fonts/` at build time) and serves it through resvg's `sans-serif` generic-family fallback with `loadSystemFonts: false` + `fontDirs: [fontsDir]`. This makes title-text metrics identical on every machine and every platform — no more per-OS font-substitution variance.

`dominant-baseline` / `alignment-baseline` guidance is **unchanged**: resvg, like QT5 and QT6 before it, does not honor `dominant-baseline` on `<text>` — it still anchors at the baseline. Keep centering text by computing the baseline `y` yourself (`+0.36em` for Arial/Arimo-bold digits) rather than relying on the CSS property.

## What's safe regardless of rendering path

These are safe under **both** the rasterized (resvg) path and the kill-switch SVG-passthrough path, so they need no caveat at all:

| Feature | Notes |
|---------|-------|
| Basic shapes (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`) | Full support everywhere |
| `text`, `tspan` | Full support; `textPath` remains unverified — don't rely on it |
| `linearGradient`, `radialGradient` | Full support everywhere |
| `defs`, `use`, `g` | Full support for structure and reuse |
| Transforms (`translate`, `rotate`, `scale`, `skew`, `matrix`) | Full support everywhere |
| `opacity`, `fill-opacity`, `stroke-opacity` | Full support everywhere |
| Stroke properties (`stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, etc.) | Full support everywhere |
| Inline `style` attribute | Limited to SVG presentation properties |
| `image` element (embedded raster, data URIs) | Full support everywhere |
| `viewBox`, `preserveAspectRatio` | Full support everywhere |

## Allowed under the rasterized path, kill-switch caveat applies

These render correctly through resvg on every platform, but silently lose their effect if `pngRasterization` is ever forced off (see the kill-switch caveat above) — don't make them carry essential information:

| Feature | Notes |
|---------|-------|
| `filter`, `feGaussianBlur`, `feColorMatrix`, `feComposite`, `feFlood`, `feMerge`/`feMergeNode`, `feOffset` | Rendered by resvg; falls back to QT5 (no filters) if the flag is off |
| `mask` | Rendered by resvg; falls back to QT5 (no masks) if the flag is off |
| `pattern` | Rendered by resvg; falls back to QT5 (no patterns) if the flag is off |
| `clipPath` | Rendered by resvg — this was broken on **both** prior QT engines, so it's a genuinely new capability |
| `symbol`, `marker` | Rendered by resvg; treat as QT6-only (untested on QT5) if the flag is off |

## Not supported, ever

| Feature | Why |
|---------|-----|
| `<style>` element (embedded CSS) | Not in resvg's static rendering model |
| CSS class-based styling | No `<style>` element support |
| `textPath` | Unverified on resvg; not supported by either legacy QT engine |
| SVG animations (`animate`, `animateTransform`, `animateMotion`, `set`) | Static renderer only |
| External CSS stylesheets | No support |
| ECMA scripts / DOM manipulation | No support |
| `dominant-baseline` / `alignment-baseline` on `<text>` | Ignored by resvg (and both legacy QT engines) — text anchors at the baseline. Center text by computing the baseline y (+0.36em for Arial/Arimo-bold digits) instead. |

## Current Icon Feature Usage

The project's 700+ icon SVGs still deliberately use a minimal feature set, now for simplicity rather than necessity:

- **Widely used**: basic shapes, text/tspan, fill/stroke, opacity, stroke-dasharray, transforms, viewBox, rx (rounded corners)
- **Moderately used**: defs/use (favicon files), Mustache template placeholders for runtime color/text
- **Rarely used**: filters (border glow)
- **Not used**: gradients, masks, patterns, clipPath, markers, animations, and embedded images (except favicons)

## Guidelines for New Icons

1. **Stick to the safe feature set first.** Basic shapes, text, fill/stroke, opacity, and transforms cover almost all current needs, and never need the kill-switch caveat.
2. **A filter/mask/pattern/`clipPath` effect must be progressive enhancement, not essential information**, until `pngRasterization` is a permanent, flag-free behavior (see the kill-switch caveat above).
3. **Do not use `<style>` elements** — use inline `style` attributes or direct SVG presentation attributes instead.
4. **Test the actual pipeline** when introducing any SVG feature not already in use — build and inspect the rasterized PNG, don't assume resvg support from the spec alone.

## Binding-missing warning glyph (#612)

The centered ⚠️ overlay drawn on a key when a required binding is unset (`assembleIcon({ bindingMissing })` / `bindingWarningSvg()` in `@iracedeck/icon-composer`) is built **only** from `polygon`, `rect` (with `rx`), `circle`, and a `<g opacity="…">` dim wrapper — all in the safe, no-caveat feature set — so it renders identically whether or not `pngRasterization` is enabled. It uses no filters, masks, `clipPath`, or `<style>`/class-based styling. Keep it that way: the overlay must render correctly on the kill-switch fallback path too, since a missing binding is essential information.

## Reference Documentation

- resvg (the rasterizer): https://github.com/linebender/resvg
- QT5 SVG rendering (kill-switch fallback on Mirabox/Ulanzi): https://doc.qt.io/qt-5/svgrendering.html
- QT6 SVG rendering (kill-switch fallback on Elgato): https://doc.qt.io/qt-6/svgrendering.html
- SVG 1.1 spec: https://www.w3.org/TR/SVG11/
