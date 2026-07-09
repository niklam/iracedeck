# Setup Dial Dash-Box Appearance — Implementation Plan

_2026-07-09 · Issue #811 · Spec: docs/superpowers/specs/2026-07-09-setup-dial-colors-design.md_

> **Update (2026-07-09):** The border glow was dropped after implementation (it didn't render on the Elgato touch strip); only the four dash-box colors shipped.

Consolidate the seven duplicated Setup dial dash-box renderers into one shared renderer + settings fragment, then make four colors (border, label, value, background) user-adjustable, add an optional border glow, and change the background to fill **inside** the border (outer margin stays black).

## Phase 1 — Shared module (TDD)

New `packages/iracing-actions/src/shared/dial-box.ts` + `dial-box.test.ts`:

- Constants: `DIAL_BOX_BACKGROUND = "#0d0d0d"`, glow tunables (`DIAL_GLOW_STD_DEV = 6`, `DIAL_GLOW_OPACITY = 0.4`, `DIAL_GLOW_WIDTH_DEFAULT = 12`, `DIAL_GLOW_WIDTH_MAX = 30`).
- Types: `DialBoxColorOverrides` (all optional), `DialBoxColors` (all required), `DialBoxGlow { enabled; width }`.
- `resolveDialBoxColors(overrides, accent)` — border/label/value fall back to `accent`; background to `DIAL_BOX_BACKGROUND`; empty string counts as unset.
- `renderDialBox({ width, height, abbr, value, colors, glow, identityLabelScale?, bindingMissing? })` — same geometry/fonts as today, but:
  - the panel rect (inset) is drawn `fill=background stroke=border` (background now fills **inside** the border; the outer margin is left transparent → device black);
  - optional glow: a blurred, wider, semi-transparent border-colored rect behind the panel, gated on `__FEATURE_BORDER_GLOW__`;
  - label uses `colors.label`, value uses `colors.value`; identity-only (`value === ""`) draws just the centered label at `identityLabelScale` (default 0.24).
- Zod `dialAppearanceFields` (spreadable into each `DialSettings`): `colors` object of four `.catch("").default("")` color fields (prefaulted), `glow` boolean (union+transform, `.catch(false)`), `glowWidth` (`z.coerce.number().catch(DEFAULT).default(DEFAULT)`).

Tests: color pass-through per element; background fills inner panel & margin stays unfilled; glow present only when enabled AND flag true (`vi.stubGlobal` both); identity-only label-only + scale; binding-warning wrap; default colors reproduce today's `#0d0d0d`+accent look; `resolveDialBoxColors` fallbacks; `dialAppearanceFields` parse defaults + `.catch` degradation.

## Phase 2 — Wire the seven actions

For each of brakes, traction, fuel, engine, aero, chassis, hybrid:

1. Spread `...dialAppearanceFields` into the `DialSettings` object (brakes: `setup-brakes-settings.ts`; others: `*-dial-surface.ts`).
2. In `renderFeedback`, replace the local `render<Name>DialBoxSvg(...)` call with `renderDialBox({ …, colors: resolveDialBoxColors(dial.colors, MODE_COLOR[setting]), glow: { enabled: dial.glow, width: dial.glowWidth }, identityLabelScale: <0.24|0.22> })`.
3. Delete the local `render<Name>DialBoxSvg`, `BOX_BACKGROUND`, `fitValueFontSize`, and now-unused imports (`applyBindingWarning`).
4. Tests: drop the `render<Name>DialBoxSvg` import + `describe` block; add a compact appearance-flow assertion to the surface feedback block (a `dial.colors.background` override shows in the box; `dial.glow:true` adds the glow filter).

Chassis passes `identityLabelScale: 0.22`; the rest 0.24; brakes has no identity path (scale unused).

## Phase 3 — Property Inspector

New shared partial `packages/pi-components/partials/dial-appearance.ejs` — an accordion ("Dash Box Appearance") with four `ird-color-picker`s (`dial.colors.{border,label,value,background}`), a `sdpi-checkbox` `dial.glow`, and an `ird-range-input` `dial.glowWidth` (1–30) hidden unless glow is checked. Include it inside each action's `#dial-settings` div, gated on `dialFeedback` (strip is Elgato-only).

## Phase 4 — Docs & rules

- `.claude/rules/encoders-and-touchscreen.md` — dash-box description: colors now user-adjustable + optional glow; background fills inside the border.
- `packages/iracing-actions/CLAUDE.md` — add `dial-box.ts` to the `src/shared/` list.
- Website: the seven `car-setup/setup-*.md` dial sections — add a short "Dash box appearance" note.
- `packages/website/src/content/docs/changelog.mdx` — one entry under the in-development version.

## Phase 5 — Verify

`pnpm build`, `pnpm lint:fix`, `pnpm format:fix`, `pnpm test` (all from the worktree; no watcher running). Then `pnpm --filter @iracedeck/website build` for the changelog/page render.

## Notes / decisions

- Setting key `label` (not `title`) for the abbreviation color — matches the code (`MODE_ABBR`, `labelText`) and avoids collision with the key-icon title system. (Issue wording said "title"; it meant the abbreviation label.)
- Background semantics change is intentional and the reason default `#0d0d0d` ≈ device black keeps the default look unchanged.
- No manifest / comms-catalog changes (presentational only). Glow filter is naturally Elgato-only (strip + `__FEATURE_BORDER_GLOW__`).
