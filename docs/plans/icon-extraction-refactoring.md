# Icon Extraction Refactoring Plan

**Goal:** Move all key icons from being embedded in TypeScript source code to standalone SVG files in the shared `@iracedeck/icons` package, making icons easier to edit visually and reusable across platforms.

**Branch:** `refactor/extract-icons-to-shared-package`

**Reference implementation:** `splits-delta-cycle` (already migrated)

---

## Design Decisions

These decisions are final and must be followed for all remaining migrations.

### 1. Complete standalone SVG files

Each SVG file is a **complete, self-contained icon** — background, content, labels, `activity-state` filter wrapper. No separate template + fragment composition.

### 2. 144x144 viewBox

All icon SVGs use `viewBox="0 0 144 144"` with all coordinates doubled from the original 72x72. Stream Deck downscales as needed.

### 3. Mustache placeholders for labels

Labels use `{{mainLabel}}` and `{{subLabel}}` placeholders (not hardcoded text). Actions call `renderIconTemplate()` to replace placeholders before converting to data URI. This enables future translation/localization.

- **`{{mainLabel}}`** — the prominent label (larger, bold, white `#ffffff`)
- **`{{subLabel}}`** — the secondary label (smaller, subdued `#aaaaaa`)

### 4. File naming

- Files live in `packages/icons/{action-name}/`
- Named by variant: `next.svg`, `previous.svg`, `lap-timing.svg`, etc.
- No state suffix (e.g., `.main`) unless there are actual visual states (e.g., `active.svg`, `inactive.svg`)
- Single-variant actions: use `default.svg` or a descriptive name

### 5. Color constants become literal hex values

Inline color constants like `${WHITE}`, `${GRAY}` must be replaced with their literal hex values in SVG files:

| Constant | Hex |
|----------|-----|
| WHITE | `#ffffff` |
| GRAY | `#888888` |
| YELLOW | `#f39c12` or `#f1c40f` |
| ORANGE | `#e67e22` |
| GREEN | `#2ecc71` |
| BLUE | `#3498db` |
| RED | `#e74c3c` |
| PURPLE | `#9b59b6` |

### 6. Import pattern

```typescript
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
```

The Rollup `svgPlugin` resolves `@iracedeck/icons/` to `packages/icons/`.

### 7. Action code pattern

```typescript
import nextIconSvg from "@iracedeck/icons/{action}/next.svg";
import previousIconSvg from "@iracedeck/icons/{action}/previous.svg";

const ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

function generateSvg(settings): string {
  const iconSvg = ICONS[settings.direction] || ICONS.next;
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: "NEXT",
    subLabel: "SPLITS DELTA",
  });
  return svgToDataUri(svg);
}
```

### 8. SVG file structure

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <!-- Background: 144x144 rounded rect -->
    <rect x="0" y="0" width="144" height="144" rx="16" fill="#BACKGROUND"/>

    <!-- Icon content area (y=18 to y=86, doubled from 9-43) -->
    <!-- ... artwork ... -->

    <!-- Labels -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="#aaaaaa" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="#ffffff" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

### 9. Dynamic/telemetry-driven icons

Actions that generate SVG content from live telemetry data (runtime values like speed, temperature, wear %) keep their dynamic generation in TypeScript. Only static icon variants are extracted.

### 10. Old files cleanup

When an action is fully migrated:
- Delete the old template from `packages/stream-deck-plugin/icons/{action}.svg`
- The static `icon.svg` and `key.svg` in `com.iracedeck.sd.core.sdPlugin/imgs/actions/{action}/` remain unchanged (manifest references)

---

## Foundation (done)

- [x] Create `@iracedeck/icons` package (`packages/icons/package.json`)
- [x] Add `extractSvgContent()` utility (available but not needed for standalone approach)
- [x] Enhance Rollup `svgPlugin` to resolve `@iracedeck/icons/` imports
- [x] Update watch plugin for recursive SVG directory watching
- [x] Add `svg.d.ts` type declarations for `@iracedeck/icons`

## Pilot (done)

- [x] `splits-delta-cycle` — 2 variants: `next.svg`, `previous.svg`

---

## Remaining Actions

### Simple actions (few static variants)

- [ ] `replay-speed` — 2 variants (increase, decrease)
- [ ] `look-direction` — directional variants
- [ ] `media-capture` — variants per capture mode
- [ ] `pit-quick-actions` — variants per pit action
- [ ] `telemetry-control` — variants per control mode
- [ ] `toggle-ui-elements` — variants per UI element
- [ ] `camera-focus` — variants per focus mode
- [ ] `camera-editor-controls` — variants per control
- [ ] `cockpit-misc` — variants per cockpit action
- [ ] `replay-navigation` — variants per nav action
- [ ] `replay-transport` — variants per transport action

### Actions with many variants

- [ ] `black-box-selector` — 11 direct icons + 2 cycle icons = 13 variants
- [ ] `audio-controls` — variants per category × action
- [ ] `camera-cycle` — variants per camera × direction
- [ ] `camera-editor-adjustments` — variants per adjustment × direction
- [ ] `view-adjustment` — variants per view × direction
- [ ] `setup-aero` — variants per setting × direction
- [ ] `setup-brakes` — variants per setting × direction
- [ ] `setup-chassis` — variants per setting × direction
- [ ] `setup-engine` — variants per setting × direction
- [ ] `setup-fuel` — variants per setting × direction
- [ ] `setup-hybrid` — variants per setting × direction
- [ ] `setup-traction` — variants per setting × direction

### Actions with dynamic content (partial extraction)

- [ ] `fuel-service` — static variants extractable; dynamic fuel amounts stay inline
- [ ] `car-control` — static variants extractable; pit-limiter speed display stays inline
- [ ] `chat` — template with dynamic text (`generateIconText()`) stays inline
- [ ] `tire-service` — telemetry-driven compound/wear display stays inline
- [ ] `session-info` — different template structure; telemetry-driven content stays inline

---

## Cleanup (after all actions migrated)

- [ ] Delete `packages/stream-deck-plugin/icons/` directory (all templates moved)
- [ ] Remove unused `labelLine1`/`labelLine2` references from rules and docs
- [ ] Update `.claude/rules/icons.md` and `.claude/rules/key-icon-types.md` with new conventions
- [ ] Update `packages/stream-deck-plugin/CLAUDE.md` action creation instructions
- [ ] Consider removing `extractSvgContent()` if no action uses it
- [ ] Consider removing `loadIconTemplate()` / `renderIcon()` if no action uses filesystem loading

---

## Verification

After each action migration:

1. `pnpm test` — all tests pass
2. `pnpm build` — build succeeds with no TS warnings
3. `pnpm watch:stream-deck` — watch mode picks up SVG changes
4. Manual test: verify the action's icon renders correctly on Stream Deck
5. SVG files open correctly in an SVG editor (valid standalone documents)
