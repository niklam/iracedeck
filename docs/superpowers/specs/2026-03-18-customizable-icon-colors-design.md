# Customizable Icon Colors

## Context

All iRaceDeck icon colors are currently hardcoded hex values in SVG files. Users cannot personalize the look of their Stream Deck buttons. This design adds a color customization system that lets users change background, text, and graphic colors — globally and per-action — while preserving semantic colors (green/red/yellow for data) that carry meaning.

### Additional scope

- **Remove `rx` from background rects** — let Stream Deck buttons decide corner radius.
- **Standardize all icons to 144x144** — upgrade dynamic templates from 72x72.

## Color Slot Model

Each icon supports 2–4 named color slots:

| Slot | Controls | Availability |
|------|----------|-------------|
| `backgroundColor` | Full-canvas background rect | All icons (100%) |
| `textColor` | mainLabel + subLabel fill | All icons (100%) |
| `graphic1Color` | Primary single-color artwork (arrows, outlines, main shapes) | ~50% of icons |
| `graphic2Color` | Secondary artwork accent | ~10–20% of icons |

### What stays fixed (never customizable)

- Semantic data colors: green (`#2ecc71`), red (`#e74c3c`), yellow (`#f39c12`), blue (`#3498db`)
- Black box inner artwork (frame, data labels, data values)
- Text inside graphics (e.g., "START" on the starter button)
- Multi-color artwork (colored blocks in splits-delta icons)
- Complex illustrations with mixed colors

Each SVG only declares the slots it actually uses. A black box icon declares `backgroundColor` + `textColor`. A splits-delta icon adds `graphic1Color` for the arrow.

## SVG Template Format

### Placeholder approach

SVGs use Mustache `{{placeholder}}` syntax for customizable color slots (extending the existing pattern used for `{{mainLabel}}`/`{{subLabel}}`). Stream Deck's renderer does **not** support CSS custom properties, so Mustache replacement is the only viable approach.

### Metadata via `<desc>`

Each SVG embeds a JSON metadata block in `<desc>` declaring its supported slots and default values:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#412244","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>
    <!-- semantic artwork stays hardcoded -->
    <rect x="26" y="20" width="28" height="20" rx="4" fill="#9b59b6"/>
    <path d="M112 66 l-28 -18 v10 h-48 v16 h48 v10 z" fill="{{graphic1Color}}"/>
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

### Key structural changes

- **No `rx` on background rects** — removed from all icons, Stream Deck controls corner radius.
- **All icons 144x144** — dynamic templates upgraded from 72x72 viewBox. All coordinate-dependent utilities must be updated (see [Utility updates](#utility-updates-for-144x144)).
- Background rect: `fill="{{backgroundColor}}"` (no hardcoded hex).
- Label fills: `fill="{{textColor}}"`. Note: label order varies across icons (some have mainLabel at y=104, others at y=126). Both use `{{textColor}}` regardless of position.
- Eligible single-color artwork: `fill="{{graphic1Color}}"` or `fill="{{graphic2Color}}"`.

### Dual file structure

Since Mustache SVGs don't render in File Explorer, previews are generated in a separate directory:

```text
packages/icons/
├── splits-delta-cycle/
│   ├── next.svg              # Mustache template (source of truth)
│   └── previous.svg
├── car-control/
│   └── starter.svg
├── preview/                   # Auto-generated, committed to git
│   ├── splits-delta-cycle/
│   │   ├── next.svg           # Defaults baked in (for browsing)
│   │   └── previous.svg
│   └── car-control/
│       └── starter.svg
└── package.json
```

- Template `.svg` files are the source of truth (with placeholders).
- `preview/` mirrors the template directory structure with defaults baked in.
- Previews are **generated at build time** as part of the `@iracedeck/icons` package build.
- Previews are **committed to git** (so they're browseable without building) but added to `.sdignore` in each plugin's `.sdPlugin/` directory to exclude from Stream Deck packaging.
- Import paths stay unchanged: `import svg from "@iracedeck/icons/action/next.svg"`.
- Manifest icons (Stream Deck action picker) are separate static files and always use defaults.

### Preview freshness

A Vitest test in `packages/icons/` verifies that previews match their source templates. For each template SVG, the test:
1. Reads the template and extracts `<desc>` color defaults.
2. Renders the template with those defaults (using `renderIconTemplate()`).
3. Compares the result to the corresponding `preview/` file.
4. Fails if any preview is missing or out of date.

This catches cases where a template is modified but the preview build step wasn't run. The test runs as part of `pnpm test`.

## Color Resolution Chain

Colors resolve through a three-level priority chain:

```text
Per-action override  →  Global default  →  Icon default (from <desc>)
```

1. **Icon default**: parsed from `<desc>` JSON in the SVG. This is the author-defined default for this specific icon (e.g., `#412244` for splits-delta background).
2. **Global default**: user's preferred colors, stored in global settings. Applies to all icons that don't have a per-action override.
3. **Per-action override**: user's color choice for a specific button instance. Takes highest priority.

### Global color settings

Stored in the existing global settings infrastructure. Uses flat key names with a `color` prefix to match the existing pattern (global settings use `.passthrough()` with flat keys like `blackBoxLapTiming`):

```typescript
// Stored in global settings as flat keys:
// colorBackgroundColor, colorTextColor, colorGraphic1Color, colorGraphic2Color
```

The `<sdpi-color>` component with `global` attribute stores hex strings directly (e.g., `"#1a1a3e"`). The `getGlobalColors()` helper reads these flat keys and returns a `ColorSlots` object.

When a global color is not set, the icon's own default is used. This means out-of-the-box behavior is identical to today.

### Per-action color overrides

Stored in action settings, extending `CommonSettings`:

```typescript
// CommonSettings gains an optional colorOverrides field
colorOverrides: z.object({
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  graphic1Color: z.string().optional(),
  graphic2Color: z.string().optional(),
}).optional(),
```

Only set fields override; unset fields fall through to global → icon default.

## Rendering Pipeline

### New utility: `resolveIconColors()`

```typescript
interface ColorSlots {
  backgroundColor?: string;
  textColor?: string;
  graphic1Color?: string;
  graphic2Color?: string;
}

function parseIconDefaults(svgTemplate: string): ColorSlots {
  // Extract <desc> JSON, parse colors object
}

function resolveIconColors(
  svgTemplate: string,
  globalColors: ColorSlots,
  actionOverrides?: ColorSlots,
): Record<string, string> {
  const defaults = parseIconDefaults(svgTemplate);
  // Merge: actionOverrides → globalColors → defaults
  // Only include keys that exist in defaults (icon's declared slots)
  return mergedColors;
}
```

### Action usage

```typescript
import iconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";

// In action render method
const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
const svg = renderIconTemplate(iconSvg, {
  mainLabel: "NEXT",
  subLabel: "SPLITS DELTA",
  ...colors,
});
const dataUri = svgToDataUri(svg);
await ev.action.setImage(dataUri);
```

### Dynamic templates

Dynamic templates (session-info, car-control, tire-service, telemetry-display) already use `renderIconTemplate()`. They gain the same color placeholders and `<desc>` metadata. The resolution chain works identically.

**Note:** `session-info.svg` and `telemetry-display.svg` already use `{{backgroundColor}}` and `{{textColor}}` placeholders. These only need `<desc>` metadata added, `rx` removed, and 144x144 upgrade. The other dynamic templates (`car-control.svg`, `tire-service.svg`) need full placeholder migration.

### Utility updates for 144x144

The 72x72 → 144x144 migration affects several coordinate-dependent utilities:

| Utility | Current (72x72) | After (144x144) | File |
|---------|-----------------|-----------------|------|
| `validateIconTemplate()` | Asserts `viewBox="0 0 72 72"` | Accept both 72x72 and 144x144, or update to 144x144 only | `icon-template.ts` |
| `generateIconText()` | Centers text at `x="36"` | Center at `x="72"`, double font sizes and y-offsets | `icon-template.ts` |
| `applyInactiveOverlay()` | "N/A" text at `x="36" y="65"` | Update to `x="72" y="130"`, double font size | `overlay-utils.ts` |

These must be updated in the same change as the dynamic template migration to avoid broken rendering.

## Property Inspector

### Layout order

1. **Action-specific settings** (mode dropdown, direction, etc.)
2. **Color Overrides** (new section — per-action color customization)
3. **Global Settings** (key bindings, etc.)

### Per-action Color Overrides section

A collapsible section showing only the slots this icon supports. Uses the standard `<sdpi-color>` component (already used by chat and telemetry-display actions).

```html
<details>
  <summary>Color Overrides</summary>
  <sdpi-item label="Background">
    <sdpi-color setting="colorOverrides.backgroundColor" default="#412244"></sdpi-color>
  </sdpi-item>
  <sdpi-item label="Text">
    <sdpi-color setting="colorOverrides.textColor" default="#ffffff"></sdpi-color>
  </sdpi-item>
  <!-- Graphic slots: shown/hidden per action -->
  <sdpi-item label="Graphic" id="graphic1-override" class="hidden">
    <sdpi-color setting="colorOverrides.graphic1Color" default="#ffffff"></sdpi-color>
  </sdpi-item>
</details>
```

#### PI slot discovery

The PI cannot read the SVG `<desc>` metadata at runtime. Instead, each action's PI template statically declares which color slots to show. This is known at build time — the template author knows which icon variants the action uses. Actions with only BG + Text omit the Graphic slots from their PI template. A shared EJS partial accepts a `slots` parameter:

```ejs
<%- include('color-overrides', { slots: ['backgroundColor', 'textColor', 'graphic1Color'] }) %>
```

### Global Color Settings

Added to the existing Global Settings collapsible section (or a new "Global Colors" subsection). Uses the standard `<sdpi-color>` component with `global` attribute:

```html
<sdpi-item label="Background">
  <sdpi-color setting="colorBackgroundColor" global></sdpi-color>
</sdpi-item>
<sdpi-item label="Text">
  <sdpi-color setting="colorTextColor" global></sdpi-color>
</sdpi-item>
<sdpi-item label="Graphic 1">
  <sdpi-color setting="colorGraphic1Color" global></sdpi-color>
</sdpi-item>
<sdpi-item label="Graphic 2">
  <sdpi-color setting="colorGraphic2Color" global></sdpi-color>
</sdpi-item>
```

No custom PI component needed — `<sdpi-color>` provides a native color picker with hex input built in.

## Migration

### SVG updates (380+ standalone + 4 dynamic templates)

For each icon:
1. Add `<desc>` JSON with current hardcoded colors as defaults.
2. Replace background rect `fill="..."` → `fill="{{backgroundColor}}"`.
3. Replace label text `fill="..."` → `fill="{{textColor}}"`.
4. For eligible single-color artwork: replace `fill="..."` → `fill="{{graphic1Color}}"` / `fill="{{graphic2Color}}"`.
5. Remove `rx="16"` from background rects (or `rx="8"` from 72x72 templates).
6. Upgrade dynamic templates from `viewBox="0 0 72 72"` to `viewBox="0 0 144 144"` (double all coordinates).

This can be largely automated with a migration script that:
- Parses each SVG
- Identifies the background rect (first `<rect>` with full dimensions)
- Identifies label `<text>` elements by `{{mainLabel}}`/`{{subLabel}}` placeholder content (not by y-position, since label order varies between standard and inverted layouts)
- Extracts current fill values for the `<desc>` metadata
- Replaces fills with placeholders
- Flags icons where artwork needs manual classification (graphic vs. semantic)

### Action code updates

Each action's render path needs to call `resolveIconColors()` and pass the merged colors to `renderIconTemplate()`. This is a mechanical change across all actions.

### PI template updates

Each action's PI template gains the Color Overrides section. This can use a shared EJS partial.

## Verification

### Unit tests

- `parseIconDefaults()`: correctly extracts `<desc>` JSON from SVG templates.
- `resolveIconColors()`: correct three-level merge (action → global → default), handles missing fields, only returns slots declared by the icon.
- `renderIconTemplate()`: correctly replaces color placeholders alongside existing label placeholders.

### Preview freshness test

- For every template SVG, extract `<desc>` defaults, render with `renderIconTemplate()`, compare to `preview/` file.
- Fails if any preview is missing or doesn't match the rendered template.
- Runs as part of `pnpm test` in `packages/icons/`.

### Integration tests

- Icon uses default colors when no overrides exist.
- When global colors are set, the icon uses them.
- Per-action color overrides take precedence over global settings.
- Dynamic templates render correctly at 144x144.

### Manual testing

- Assign custom global colors → all icons reflect the change.
- Override one action instance → only that button changes.
- Reset overrides → falls back to global → icon default.
- Light background + dark text combination is readable.
- Verify semantic colors (green/red/yellow) are unaffected by customization.
- Verify icons without `rx` render correctly on Stream Deck buttons.
