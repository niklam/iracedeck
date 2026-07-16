# Icon Gallery Page & Icon Designer Requirements — Design

Date: 2026-07-16
Status: Approved (design), pending implementation plan

## Background

A community designer (Reven Ger, Discord) offered to design a full alternative set of icons for iRaceDeck and asked for (a) a full list of every Key and Dial icon and (b) the format and file-structure requirements. Niklas promised both. Separately, Niklas wants to eventually offer such a package as a selectable **alternative icon set** (global-settings dropdown, per-icon fallback to the default set).

This spec covers two deliverables to build now, plus one recorded direction decision:

1. **Icon gallery page** on iracedeck.com — the "list of every icon".
2. **Designer requirements page** on iracedeck.com — the "technical requirements".
3. **Icon-set feature direction** (recorded only; its own spec comes later, after the designer conversation).

## Current inventory (as of this spec)

| Class | Count | Location | Nature |
|-------|-------|----------|--------|
| Key icon templates | 388 | `packages/icons/<family>/*.svg` (~35 families) | Mustache graphic snippets: trimmed viewBox, `<desc>` metadata (default colors, locked slots, title, border color), optional color-slot placeholders (356 use `{{graphic1Color}}`, 111 reference `{{backgroundColor}}`) |
| Dynamic templates | 16 | `packages/iracing-actions/icons/*.svg` | Full 144×144 canvases with runtime telemetry placeholders |
| Static per-action key icons | 36 | `packages/iracing-actions/src/actions/<name>/key.svg` | Finished default key images (manifest) |
| Dial icons | 9 | `packages/iracing-actions/src/actions/<name>/dial.svg` | Elgato encoder icons; the touch-strip dash box is rendered at runtime by `renderDialBox` (`shared/dial-box.ts`) |
| Category icons | 36 | `packages/iracing-actions/src/actions/<name>/icon.svg` | 20×20 action-list icons |

Icons are statically imported as strings at build time (385 imports across 32 action files) and composed at runtime via the icon-composer pipeline (`resolveIconColors → resolveTitleSettings → resolveBorderSettings → resolveGraphicSettings → assembleIcon`). Runtime default titles come from per-action `*_TITLES` maps in the action source, which override `<desc>` title metadata. The `preview/` mirror bakes colors into raw snippets but does **not** represent the composed on-device key.

## Deliverable 1 — Icon gallery page

**URL:** `/docs/development/icon-gallery/` (Starlight docs, development section, next to the architecture page).

**Audience:** both-in-one — a showcase grid by default, with an expandable technical panel per card for designers/contributors.

### Data pipeline (build-time codegen, never committed)

A generator script in `packages/website` runs before `astro dev` and `astro build` (invoked explicitly from the package's `dev`/`build` scripts — pnpm does not run npm `pre` scripts by default; turbo guarantees `@iracedeck/icon-composer` is built first). It emits two **gitignored** outputs:

- **Per-icon SVG assets:** `packages/website/public/icon-gallery/<class>/<family>/<name>.svg` — the composed as-on-device rendering. Serving individual files (instead of inlining ~485 SVGs) keeps the page HTML small and lets the browser lazy-load and cache.
- **Metadata JSON:** `packages/website/src/data/icon-gallery.json` — per icon: class, family, name, repo path, viewBox, color slots used, locked slots, default title (with `*_TITLES` override applied), and consuming action(s).

Per-class rendering rules:

- **Templates (388):** full composition via the icon-composer pipeline with icon-default colors, resolved titles (`*_TITLES` maps parsed statically from action sources, `<desc>` fallback — the proven #827 gallery recipe), default border/graphic settings.
- **Dynamic templates (16):** rendered once with a small hand-maintained sample-data map of representative telemetry values (kept in the generator's data).
- **Static key.svg / dial.svg / category icon.svg:** copied/shown as-is.
- **Dial dash surface:** one representative `renderDialBox` sample so the "Dial" half of the inventory is visible.

### Page design

- MDX page with a client-side island component (Astro), working in both site themes.
- Grouping: class → family; a client-side search/filter box.
- Card: icon on a device-black tile + name. Expanding a card reveals the technical panel: repo path, viewBox, color slots, locked slots, default title, consuming actions.

### Maintenance

Nothing generated is committed, so nothing goes stale — every build regenerates from the current icon sources. Docs sidebar gains the page entry. Changelog gets one line under the in-development version.

## Deliverable 2 — Designer requirements page

**URL:** `/docs/development/designing-icons/` — a public sibling page so one link sent to a designer covers the inventory (gallery) and the rules (this page).

Content outline:

1. **Icon anatomy** — icons are artwork snippets, not finished keys: trimmed viewBox plus the 1-unit anti-clip margin, no background rect, no baked-in title text (titles are composed at runtime and user-configurable), stroke weights authored at 144×144 visual scale (4–5px main, 2–3px detail).
2. **Color system** — the Mustache slots (`{{backgroundColor}}`, `{{textColor}}`, `{{graphic1Color}}`, `{{graphic2Color}}`), the `<desc>` metadata JSON (default colors, `locked` slots, title, border color), and when fixed semantic colors (green/red/yellow/blue data colors) must stay fixed.
3. **Renderer constraints** — the safe SVG feature set and what to avoid (`<style>` elements, CSS class styling, animations), distilled from `.claude/rules/svg-platform-compatibility.md`.
4. **File structure & naming** — a set must mirror the default set exactly: `<family>/<variant>.svg`, same names — the filename is the fallback key. Links to the gallery page as the authoritative inventory.
5. **Scope for a v1 set** — the 388 key templates are the target. Dynamic templates and static `key.svg`/`icon.svg`/`dial.svg` remain default in v1 (explicitly out of scope, not forgotten).
6. **How it will ship** — bundled as a selectable icon set in global settings with per-icon fallback to the default set, so a partial set is fine and can be delivered incrementally.
7. **Delivery & licensing** — hand-over format (zip or PR) and a note that contributed artwork ships inside the plugin and needs a compatible license / attribution agreement.

## Recorded direction — Alternative icon set feature (B1: bundled overlay pack)

Not built in this round; recorded so the requirements page makes promises we will keep:

- An icon set is a **directory tree mirroring the default set's `family/variant.svg` paths**, in the same graphic-snippet format.
- Build-time codegen produces a `path → svg` registry per bundled set; a runtime resolver checks the selected set first and **falls back per icon** to the default registry.
- Selection is a plain global setting (e.g. `iconSet`, default `"default"`) with a PI dropdown; the existing regenerate-callback mechanism re-renders all keys live on change.
- The 385 static icon imports migrate to registry lookups keyed by their current paths (mechanical, codemod-able) when the feature is built.
- Rejected alternatives: user-loadable packs from disk (runtime IO/failure modes; possible v2 on top of the registry seam) and colors/skin-only (doesn't match the designer's offer).

This feature gets its own spec once the designer commits and the direction has been discussed with him.

## Testing & verification

- Generator pure functions (slot extraction, `<desc>` parsing, `*_TITLES` parsing, path mapping, sample-data application) get Vitest coverage.
- `pnpm --filter @iracedeck/website build` passes; both pages render; spot-check a handful of gallery icons against real plugin rendering.
- Changelog entry under the in-development version; docs sidebar updated; `website` skill and any affected rules updated per the docs-in-sync rule.

## Out of scope

- Implementing the icon-set feature (registry, resolver, dropdown, import migration).
- Restyling or auditing any existing icons.
- PNG rasterization of gallery assets (SVG is fine on the web).
