# Setup Dial Dash-Box Appearance — Design

_2026-07-09 · Status: approved in brainstorming · Issue: #811_

> **Update (2026-07-09, post-implementation):** The border glow was **dropped** — the `feGaussianBlur` glow did not render on the Elgato touch strip. Only the four colors (border, label, value, background) ship. Glow references below are kept for design history.

## Summary

Make the Stream Deck+ dial touch-strip "dash box" appearance user-adjustable across **all seven Setup dial surfaces** — Setup Brakes, Traction, Fuel, Engine, Aero, Chassis, and Hybrid (dial surfaces added in #817). Today every dash box hardcodes its colors: the panel is fixed near-black (`BOX_BACKGROUND = "#0d0d0d"`) and the border, title label, and value all share one per-setting accent (`MODE_COLOR`). Users should be able to independently set the **border**, **title**, **value text**, and **background** colors, and optionally give the border a **glow**, with the current accents + black background preserved as defaults so nothing changes until a user overrides.

Fuel Service and Audio Controls dial surfaces are **out of scope** — their renderings differ (segmented / level bars, many semantic colors) and are candidate follow-ups once this pattern is proven.

## Current behavior

After #817 each Setup action owns a **duplicated** dash-box renderer (`renderBrakeDialBoxSvg`, `renderTractionDialBoxSvg`, `renderFuelDialBoxSvg`, `renderEngineDialBoxSvg`, `renderAeroDialBoxSvg`, `renderChassisDialBoxSvg`, `renderHybridDialBoxSvg`), each carrying its own copy of:

- `const BOX_BACKGROUND = "#0d0d0d"` (near-black), and
- a per-setting `MODE_COLOR` map used as a **single** accent for the border stroke, the abbreviation label, and the value text — with a comment stating the colors are "intentionally not exposed as user color overrides".

The SVG is two rects: a full-cell rounded rect filled with `BOX_BACKGROUND`, then an inset rounded rect with `fill="none"` and the accent stroke. So the area **inside** the border and the outer margin are the same near-black — the box reads as a colored outline on black. Each action also defines its own `DialSettings` Zod schema (stored under the action's `dial` settings root); there is no shared dial-settings or dial-renderer module.

## Model

Four independently adjustable colors plus an optional border glow, resolved per dial instance:

| Slot | Default | Applies to |
|------|---------|-----------|
| Border | per-setting `MODE_COLOR[setting]` | border stroke (and glow) |
| Title | per-setting `MODE_COLOR[setting]` | abbreviation label (e.g. "BB", "TC1") |
| Value | per-setting `MODE_COLOR[setting]` | live value text |
| Background | `#0d0d0d` | the panel **inside** the border |
| Border glow | off | blurred border-colored halo behind the border |

Overrides apply regardless of which setting the dial is bound to. With every slot unset the box renders byte-for-byte as it does today.

### Background = the bordered panel, not the whole cell

The **background color fills the area enclosed by the border** (inside the frame), not the margin outside it. The outer margin between the border and the cell edge stays black (the device screen), so the box reads as a filled, framed panel floating on the strip — instead of today's black-on-black with only a colored outline. This is a real change to the inner fill geometry: today's full-cell background rect becomes the inner (bordered) panel fill, and the outer margin is left transparent/black.

### Border glow

The border gains the **same optional glow as key-icon borders**: an enable toggle plus a glow width, rendering a blurred stroke in the border color behind the crisp border. Reuse or mirror `generateBorderParts` / `icon-base.ts` (`feGaussianBlur`, ~0.4 opacity, glow color follows the border color), gated on `__FEATURE_BORDER_GLOW__`.

This is naturally Elgato-only: the touch strip only renders under `__FEATURE_DIAL_FEEDBACK__` (Elgato), whose QT6.7+ engine supports the glow filter; Mirabox/Ulanzi ship no dial declarations (#786) and no strip.

## Settings

A **shared dial-appearance settings fragment** (colors + border/glow) is spread into each action's `DialSettings` schema under the `dial` root — e.g. `dial.colors.{border,title,value,background}` and `dial.border.{glowEnabled,glowWidth}` (exact key layout an implementation detail). Every field defaults, and each color/glow field uses `.catch(<default>)` so an unknown or malformed persisted value degrades to its default rather than failing the whole settings parse (the 2.0-settings-contamination failure mode). Resolution fallbacks: `MODE_COLOR[setting]` for the three accent slots, `#0d0d0d` for background, glow off.

No new **global** settings — this is per-dial-instance styling, matching the earlier "Dial-specific color section" decision rather than reusing the plugin-wide key-icon color/border defaults.

## Rendering

Because all seven renderers are near-identical, consolidate rather than fork the change seven ways:

- Extract a **shared dial dash-box renderer** into `packages/iracing-actions/src/shared/` (sibling of `dial-name-icon.ts` / `setup-view.ts`). It takes resolved `borderColor` / `titleColor` / `valueColor` / `backgroundColor` plus glow settings, draws the background as the inner (bordered) panel, and renders the border + optional glow. Per-action renderers become thin wrappers that still own their action-specific extras (identity-only label layout, aero qualifying tape, etc.).
- The 144-specific `generateBorderParts` hardcodes the canvas (144, rx 24); either generalize it to accept dimensions or mirror its glow snippet in the shared dial renderer for the 200×100 strip.
- **#612** — missing binding still dims the content under the standard centered warning triangle (`applyBindingWarning`), unchanged.
- **Platform** — only QT5-safe SVG for the base box (text, rect, rounded corners); the glow filter is the sole QT6-only element and is gated on `__FEATURE_BORDER_GLOW__` (and only reachable on the Elgato-only strip anyway).

## Property Inspector

- A **dial-only** appearance section, shown only in the encoder view via the existing per-controller gating on `actionInfo.payload.controller` (the same toggle the setup `.ejs` files already use to swap keypad vs dial settings), added to all seven `setup-*.ejs` templates.
- Four `ird-color-picker` inputs (Border, Title, Value, Background), each resettable to its default, plus glow enable + width controls (mirroring the Border Overrides partial's glow controls, themselves gated so they don't render where glow can't apply).
- Because the seven templates share this block, factor it into a shared partial rather than copy-pasting.
- A settings change re-renders the strip immediately via the existing `didReceiveSettings` memo-bust path.

## Rollout

Single change covering all seven Setup dial surfaces (they share the renderer and settings fragment after consolidation). Ships with its artifacts: the seven website action pages' dial sections, one changelog entry, the `encoders-and-touchscreen.md` rule update where it describes the dash box / dual-surface dial settings, and the `iracing-actions` package `CLAUDE.md` `src/shared/` listing for the new module.

## Testing

- **Shared renderer** — resolved-color pass-through (each slot colors the right element); background fills the inner bordered panel and the outer margin is not filled; glow present only when enabled and only under `__FEATURE_BORDER_GLOW__` (`vi.stubGlobal` both paths); #612 overlay still applied; defaults reproduce today's output (snapshot/assertion parity).
- **Settings fragment** — defaults resolve to `MODE_COLOR` / `#0d0d0d` / glow-off; `.catch` degradation for unknown/malformed persisted values.
- **Per action** — the dial-only PI gating exposes the section on the encoder surface only; a color/glow change triggers a re-render.
- No `packages/icons` preview-script changes (dynamic dial rendering isn't in that pipeline).

## Out of scope

- Fuel Service and Audio Controls dial surfaces (different renderings; candidate follow-ups).
- Keypad key-icon colors — already covered by the standard Color Overrides + Border Overrides systems.
- The deck-app dial name icon (`renderDialNameIcon`) — not part of the touch strip.
- New global (plugin-wide) dial-color defaults — per-instance only for now.

## Decision log

- **Scope**: all seven `Setup *` dial surfaces, excluding Fuel Service / Audio Controls (2026-07-09).
- **Background semantics**: the background color fills the area **inside** the border; the outer margin stays black (2026-07-09).
- **Glow**: border gains the same optional glow as key-icon borders, glow color = border color, gated on `__FEATURE_BORDER_GLOW__` (2026-07-09).
- **Storage/PI**: per-dial-instance settings under the `dial` root, dial-only PI section — not the plugin-wide key-icon color/border defaults (2026-07-07, carried forward).
- **Consolidation**: extract a shared dial dash-box renderer + shared dial-appearance settings fragment rather than editing seven duplicated renderers in place (2026-07-09).
- **Defaults preserved**: with no overrides the box renders exactly as today, so existing dial users see no change on upgrade.
