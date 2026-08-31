---
# Icon Guidelines

## Icon Types

- **Category icons** (`icon.svg`, 20x20): Must be monochrome white (`#ffffff`) on transparent background. No colors. Keep designs simple—text is often too small to read at this size.
- **Key icons** (`key.svg`, 72x72): Can use full color palette. These appear on Stream Deck buttons. See [key-icon-types.md](key-icon-types.md) for standardized layouts.
- **Standalone icon SVGs** (`packages/icons/{action-name}/*.svg`): Graphic snippet SVGs whose `viewBox` is trimmed to the artwork's exact extent (variable per icon, no background rect, no label text). Color Mustache placeholders and `<desc>` metadata are kept. The background, title text, border, and dynamic scaling are added at render time by `assembleIcon()` using the SVG's own viewBox dimensions. Imported at build time via `@iracedeck/icons/{action-name}/{variant}.svg`.
  - **Exception**: `packages/icons/tire-service/toggle-tires.svg` is intentionally kept on the legacy 144×144 canvas. The tire-service action overlays four dynamic tire-status rects in 144-coord space at runtime, so the car body's coordinates must stay in that frame. The migration script (`scripts/migrate-icons-to-trimmed-viewbox.mjs`) explicitly skips this file via `SKIP_FILES`, and `tire-service.ts` uses a hardcoded `TOGGLE_TIRES_BOUNDS` instead of reading the viewBox. Don't trim it without also rewriting the dynamic tire layout in the action.
- **Dynamic templates** (e.g., `packages/iracing-actions/icons/*.svg`): 144x144 Mustache templates for actions with telemetry-driven content that can't be pre-rendered as standalone SVGs.

## Plain icon design system (#827)

The sets redesigned in #827 follow a shared **plain** language — apply it when adding icons to these sets or redesigning others (full spec: `docs/superpowers/specs/2026-07-12-icon-redesign-design.md`):

- **Plain style** (Media Capture, Camera Editor Adjustments, Cockpit Misc dash/in-lap, Setup Brakes/Engine/Fuel/Hybrid/Traction, Chat, Black Box Selector, Recenter VR, plus the flat-car sets below): solid `{{graphic1Color}}` (white) fills, interior details cut out in `{{backgroundColor}}`, and at most one accent per icon — `{{graphic2Color}}` (default `#4fc3f7` cyan; chat defaults `#2563ab`) or the icon's fixed semantic color (red record/stop `#e74c3c`, green play/OK `#2ecc71`, amber fuel/flag/auto `#f6d34c`). No gradients, no glow, no gloss overlays. An element that sits directly on the key background (a lens beside a camera body, the blimp cabin) must be white, not a cutout.
- **Rich-chipless exceptions**: Force Feedback, Look Direction, the View Adjustment ± modes, and Telemetry Control keep their previously approved treatments (`mtl`/`scl2` gradient shading where they had it); the same tight-viewBox/pair rules apply.
- **Tight viewBoxes**: each icon's viewBox is the rendered alpha bounding box of its artwork (+1 unit padding) — not a uniform canvas — so `assembleIcon` can scale the art to fill the key. When editing artwork, re-trim the viewBox to the new extent; big unused margins shrink the icon on the key (#827 review finding).
- **± marks**: no chips anywhere. When the drawing itself shows the direction (FOV cone, wave count, before→after), the pair carries no mark at all — a rotation arrow does **not** count (camera pitch/yaw share one arrow and carry the mark). Otherwise the mark is a bare `{{graphic1Color}}` `+`/`−` (stroke 6, 24-unit arms) placed to the right of the artwork and **vertically centered on it**. Dash pages use `>` (next, right side) / `<` (previous, LEFT side of the panel) chevrons instead. **Titles**: an icon with a giant ± mark has **no direction line at all** (the mark says it — the emitter strips it automatically); an icon whose drawing shows direction without a mark uses INCREASE/DECREASE words, never `+`/`−` signs.
- **Pair frames**: ± pairs share one viewBox frame (union of both variants' bounds) with each variant horizontally centered so both keys render at identical scale (the emitter's `pair:` key; `anchor: "frame"` pins shared artwork like the telemetry graph instead of centering).
- **"A" badge**: amber rounded square with a dark bold `A`, top-right, marks automatic/computed modes (auto-compute FFB force, auto-set mic gain). Use it for any future "magic" mode.
- **Flat car style**: car-bearing icons (Setup Aero, Setup Chassis, reload-car-textures) draw the shared flat top-view race car (the Tire Service car body verbatim) as `{{graphic1Color}}` on the background with one `{{graphic2Color}}` accent on the adjusted part.
- **Tri-state toggles**: telemetry-aware toggles (ABS Toggle, TC Toggle, like DRS/Fast Repair) render a dedicated 144×144 template + the shared `statusBarOn/Off/NA` bottom bar with `borderColorForState` — they are exempt from the plain conversion.
- **Cutouts** that expose the key background (wheel windows, gear hubs, glyphs inside the video-camera body) use `{{backgroundColor}}`.
- **Gradient pitfall** (rich sets only): never stroke an axis-aligned `<line>` with a gradient — the objectBoundingBox is zero-sized and the stroke vanishes. Use a `rect` or a literal metal tone (`#c9d4dc`).

## Standalone Icon SVGs (preferred)

Most action icons are standalone SVG files in the `@iracedeck/icons` package:

```text
packages/icons/{action-name}/
├── next.svg
├── previous.svg
└── default.svg
```

### Structure (trimmed-viewBox graphic snippet)

Icons are graphic snippets — they contain only the artwork and metadata. Each icon's `viewBox` is the artwork's rendered bounding box plus a 1-unit anti-clip margin on every side — no larger surrounding canvas. The background rect, title text, border, and centering/scaling are added at render time by `assembleIcon()` based on the SVG's own viewBox dimensions.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 68">
  <desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"CATEGORY\nACTION"}}</desc>

  <!-- Graphic artwork only — no background rect, no label text elements -->
  <!-- Coordinates start at (0, 0) and span the viewBox width/height -->
  <!-- Eligible single-color artwork uses {{graphic1Color}} -->
  <!-- ... artwork ... -->

</svg>
```

The `viewBox` width and height are the artwork's own dimensions plus the 1-unit margin — no larger canvas around them. `assembleIcon()` reads them via `parseSvgViewBox()` and uses `applyGraphicTransform()` to scale the artwork into the available area (which shrinks when a title is shown at top or bottom) and centers it. Users can further adjust scale via Graphic Overrides (per-action) or Graphic Defaults (global).

The `title.text` field in `<desc>` provides the default title. Prefer short, single-line titles (e.g., `"1x"`, `"DRS"`) — only use two lines (`"CATEGORY\nACTION"`) when a single line cannot convey the action clearly. Title position, font, and visibility are controlled via `resolveTitleSettings()` at render time.

### Base template

At render time, `assembleIcon()` assembles the final icon using `ICON_BASE_TEMPLATE`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect x="0" y="0" width="144" height="144" fill="{backgroundColor}"/>
  {graphicContent}
  {titleContent}
</svg>
```

### Import pattern

```typescript
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
```

The Rollup `svgPlugin` resolves `@iracedeck/icons/` to `packages/icons/`.

## Color Slots

Icons support up to 4 customizable color slots via Mustache placeholders. Each SVG declares its supported slots, defaults, and default title text in a `<desc>` element:

```svg
<desc>{"colors":{"backgroundColor":"#412244","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"CATEGORY\nACTION"}}</desc>
```

The `title.text` field is the default title text. Prefer short, single-line titles — only use two-line `"subLabel\nmainLabel"` format when needed for clarity. Actions may override this at render time via `resolveTitleSettings()`.

| Slot | Placeholder | Controls | Availability |
|------|-------------|----------|-------------|
| `backgroundColor` | `{{backgroundColor}}` | Background rect fill | All icons |
| `textColor` | `{{textColor}}` | Label text fills | All icons |
| `graphic1Color` | `{{graphic1Color}}` | Primary artwork (arrows, outlines) | ~80% of icons |
| `graphic2Color` | `{{graphic2Color}}` | Secondary accent (e.g., chat bubble fill) | Rare |

### Resolution chain

Colors resolve at render time via `resolveIconColors()`:

1. **Per-action override** — user sets in Color Overrides PI section
2. **Global default** — user sets in the settings window's Appearance tab (skipped for locked slots)
3. **Icon `<desc>` default** — fallback from SVG metadata

### Locked slots

Icons can declare slots as `"locked"` in their `<desc>` metadata to protect them from global color overrides:

```json
{"colors":{"backgroundColor":"#3a4a5a","graphic1Color":"#ffffff"},"locked":["graphic1Color"]}
```

- Locked slots skip the global default step — they use the icon default unless the user sets a per-action override
- Use `"locked"` when an icon mixes a colorizable slot (e.g., white outlines via `{{graphic1Color}}`) with hardcoded semantic colors (green arrows, red indicators) that would visually clash under global presets
- Omitting `"locked"` or using `[]` means all slots are globally overridable (backward compatible)

### Locked title fields

Icons can declare title fields as `"locked"` in their `<desc>` title metadata to protect them from global title overrides:

```json
{"colors":{...},"title":{"text":"DRS","fontSize":30,"showTitle":true,"locked":["showTitle","fontSize"]}}
```

- Locked title fields skip the global title settings step — they use the icon default unless the user sets a per-action override
- Use `"locked"` when the title is an integral part of the icon design (e.g., DRS, Push-to-Pass) and hiding it or changing the font size would make the button unidentifiable
- Supported lockable fields: `showTitle`, `showGraphics`, `bold`, `fontSize`, `position`, `customPosition`
- Omitting `"locked"` or using `[]` means all title fields are globally overridable (backward compatible)
- Icon `<desc>` title text is never template-resolved — `{{…}}` placeholders only resolve in **user-entered** Title Text (deck-core's `resolveTitleSettings` wrapper, issue #899), so a literal `{{` in `<desc>` text renders as-is. Don't put template syntax in icon metadata.

### Locked border fields (#755)

Icons can likewise declare border fields as `"locked"` in their `<desc>` border metadata to protect them from the global border defaults:

```json
{"colors":{...},"border":{"enabled":false,"glowEnabled":false,"locked":["enabled","glowEnabled"]}}
```

- Locked border fields skip the global border defaults step — they use the icon default unless the user sets a per-action override (the Border Overrides PI section still wins)
- Use it for keys whose design must stay border-less even when the user enables plugin-wide borders — e.g. the Switch Profile icons and the Race Admin car-selector template, where a border+glow around a page of big car numbers defeats the clean look
- Supported lockable fields: `enabled`, `borderWidth`, `color`, `glowEnabled`, `glowWidth`; icon `<desc>` defaults exist for `enabled`, `glowEnabled`, and `color`
- Omitting `"locked"` or using `[]` means all border fields are globally overridable (backward compatible)

### Never use a leading newline in title text

Do not prefix `title.text` with `\n` to "push" the artwork upward — the empty leading line still counts as a full line in `calculateYPositions` / `computeGraphicArea`, which shrinks the available graphic area from the bottom and pushes the art up by ~11 px (the center of the available area moves from y=60.5 to y=49.7).

```json
{"title":{"text":"\nFUEL"}}     // wrong: phantom first line steals graphic height
{"title":{"text":"FUEL"}}        // right: single-line title
```

Two-line titles are only appropriate when both lines carry visible text (e.g., `"VOL UP\nSPOTTER"`). If the artwork looks too high without the phantom line, adjust the artwork's y coordinates — don't compensate via the title.

### What stays fixed (never colorizable)

- Semantic data colors: green (`#2ecc71`), red (`#e74c3c`), yellow (`#f39c12`), blue (`#3498db`)
- Black box inner artwork (frame, data labels, data values)
- Text inside graphics (e.g., "START" on the starter button)
- Multi-color artwork (colored blocks in splits-delta icons)

## Preview Files

Since Mustache SVGs don't render in File Explorer, previews with defaults baked in are maintained:

```text
packages/icons/preview/   # Mirrors source structure with colors resolved
```

- Generated by `node scripts/generate-icon-previews.mjs`
- A Vitest freshness test verifies previews match templates
- **Run after modifying any icon SVG:** `node scripts/generate-icon-previews.mjs`
- **Run after adding new icons:** also run `node scripts/generate-icon-defaults.mjs` to update PI defaults. New icons should be authored with their `viewBox` already trimmed to the artwork extent — no separate bounds-generation step.

## Dynamic Templates (for telemetry-driven content)

Actions where icon content changes at runtime based on telemetry (e.g., tire colors, speed values) keep their templates in `packages/iracing-actions/icons/`. These use 144x144 viewBox, `<desc>` color metadata, and can have arbitrary placeholders.

All dynamic templates include `{{borderDefs}}` (inside `<defs>`) and `{{borderContent}}` (after the background rect) placeholders. Actions must call `resolveBorderSettings(...)` then `generateBorderParts(...)` to obtain `borderDefs` and `borderContent` strings, and pass them when calling `renderIconTemplate()`. Pass `borderDefs: ""` and `borderContent: ""` if border is not used.

Current dynamic templates: `car-control-pit-limiter.svg`, `session-info.svg`, `tire-service.svg`, `telemetry-display.svg`, `race-admin-car-selector.svg` (the #732 selector's big-number key).

## Design Specs

- Standalone icons: variable-sized viewBox trimmed to the artwork extent plus the 1-unit anti-clip margin (no surrounding canvas, no background rect).
- Dynamic templates: 144x144 canvas, no rounded corners.
- Stroke width: 4–5px main, 2–3px details (in 144x144 reference scale — author at the same visual weight regardless of trimmed viewBox size, the render-time scaler keeps proportions correct).
- Colors: white `#ffffff`, green `#2ecc71`, red `#e74c3c`, yellow `#f39c12`, purple `#9b59b6`, gray `#888888`.

## Text and Variants

- Use `generateIconText()` helper for dynamic text in template-based icons. Pass `centerX: 36` for legacy 72x72 templates (default is 72 for 144x144).
- For directional actions provide icon variants that reflect the chosen direction.

## Distinctiveness

- Icons must be visually distinguishable from similar icons used by other actions.
- Use labels/badges (e.g., "BB" for black box actions) to differentiate action categories.
- When an icon concept is shared across actions (e.g., fuel), vary the icon style or add a category label.

### Shared markers: the deliberate exception (#960)

The rules above exist so a user can tell two **different** operations apart. They do not require the **same** operation to look different in two places, and where two actions do the same thing, deliberately identical artwork is the clearer choice — a shared visual vocabulary, not a collision.

The one case today is the **double chevron**, which marks a key that steps the camera from one car to another. Camera Controls' *Cycle by Track Order* keys and Replay Control's *Next Car* / *Previous Car* keys all carry it in place of the single triangle: `packages/icons/camera-cycle/track-position-{ahead,behind}.svg` and `packages/icons/replay-control/{next,prev}-car.svg` are byte-identical apart from their `<desc>` metadata. That is intended.

**Do not "fix" it** by varying one side's style or adding a category badge — that would destroy the vocabulary the marker exists to establish. When adding a key to either action, reuse the double chevron if it steps the camera between cars, and pick different artwork if it does not. What separates the four keys for the user is their title text, which each action's own `*_TITLES` map sets at runtime and which overrides the `<desc>` title (see **Text and Variants** above) — so the icons are free to be identical.
