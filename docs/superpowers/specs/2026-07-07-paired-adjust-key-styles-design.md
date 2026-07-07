# Paired Adjust Key Styles — Design

_2026-07-07 · Status: approved in brainstorming, pending final spec review_

## Summary

A family of key styles that lets two (or three) Stream Deck keys form one increase/decrease control where the live value is visible on the keys themselves. The driver is space on small decks: today an adjustable value needs three keys (View + increase + decrease) or a timing-sensitive dual-press View key. With these styles, a two-key pair shows the value on both keys and adjusts it with plain taps; a three-key group adds a dedicated value key in the middle. Layouts work horizontally and vertically, and the user chooses which side increases.

Applies to everything adjustable, rolled out in phases (setup values first, then Fuel Service fuel-to-add and Replay Speed). Modes with no readable value keep the existing icons.

## Model

There is **no group or linking setting**. A "pair" or "triple" is emergent from what the user places:

- **2-key pair** — two directional keys (same setting, opposite directions) in a value-showing style.
- **3-key group** — two directional keys in a no-value style around a **View key** (the existing View sub-mode) as the value display.
- Asymmetric setups (a value key plus a single `+` key) are legal for free.

### Style catalog

**Directional keys — value-showing styles** (each key renders the live value):

| Style | Look | Needs position? |
|-------|------|-----------------|
| `legacy` | Current static arrow icons (default for existing keys) | no |
| `corner-badge` | Full-size value + small +/− badge top-right | no |
| `edge-chevrons` | Value + double chevrons on the outer edge, pointing in the true direction of change | yes |
| `split` | Label top, value middle, big +/− bottom (**default for freshly placed keys**) | no |
| `ghost` | Full-size value over a huge translucent +/− | no |
| `joined-pill` | Pill frame open toward the partner key; +/− inside near the outer edge | yes |

**Directional keys — no-value styles** (for triple outer keys; usable standalone):

| Style | Look | Needs position? |
|-------|------|-----------------|
| `big-glyph` | Huge centered +/− in the accent color, no label | no |
| `big-chevron` | Big centered double chevrons pointing in the direction of change, no label | yes (orientation) |
| `pill-end` | Pill end segment with a big +/− glyph, equal margins, no label | yes |

**View keys — display styles:**

| Style | Look |
|-------|------|
| `default` | Today's View key (unchanged) |
| `pill-middle-horizontal` | Pill middle segment open left+right; value + label centered inside |
| `pill-middle-vertical` | Pill middle segment open top+bottom; value + label centered inside |

C (`split`) and D (`ghost`) are deliberately pair-only: in a triple the middle key owns the value, so the no-value styles are what outer keys use.

## Settings

A shared Zod fragment extends each adopting action's settings schema:

- `keyStyle` — the style enum above. The set of valid values depends on the current mode (directional vs View); the PI only offers valid options and the renderer falls back to `legacy`/`default` when a persisted value doesn't apply to the mode. **Schema default `"legacy"`** so every pre-existing key keeps its current look on upgrade. `.catch("legacy")` so a value written by a newer plugin version degrades instead of failing the whole settings parse (the 2.0-settings-contamination failure mode).
- `pairPosition: "auto" | "left" | "right" | "top" | "bottom"` — default `"auto"`, `.catch("auto")`. Consumed by `edge-chevrons`, `joined-pill`, `pill-end`, `big-chevron`. `auto` derives from direction: increase → right, decrease → left (the common horizontal layout). Vertical users pick top/bottom explicitly. Chevrons always point in the true direction of change regardless of which edge they sit on.

### Fresh-key seeding

On `willAppear` of a keypad context whose raw settings are empty (never configured), the action stamps `keyStyle: "split"` and persists it — one-shot, same pattern as the #775 `seedDialFromLegacySetting` migration. Existing keys have persisted settings, miss the seed, and stay `legacy`. Result: nothing changes for existing users; new placements get the modern default (style C).

## Rendering

New shared module `packages/iracing-actions/src/shared/adjust-styles.ts` (sibling of `setup-view.ts`) plus a dynamic 144×144 template. `renderAdjustStyleSvg({ style, direction, pairPosition, value, label, colorSourceSvg, colorOverrides, titleOverrides, borderOverrides, bindingMissing })` returns the SVG data URI; per-style layout is generated content injected into the template.

- **Value** — reuses the `VIEW_DEFS` registry and formatters with the unit stripped (`"54.0%"` → `"54.0"`; signed values keep the sign; `---` null placeholder unchanged). Rendered larger than today's View key since the unit is gone. Per-style base font sizes, with the existing short-integer bump.
- **Label = the title system.** The label renders via `resolveTitleSettings`/`generateTitleText`, so global title defaults and per-key overrides (text — e.g. "BRAKE BIAS" → "BB" — size, position, show/hide) work unchanged. Each style supplies its defaults: `split` → top; value-showing styles → bottom; **no-value styles (`big-glyph`, `big-chevron`, `pill-end`) → `showTitle` false** (a title override can re-enable per key); `pill-middle-*` → centered inside the pill.
- **Colors** — background/text default from the owning action's palette (`colorSourceSvg`, e.g. setup-brakes dark brown `#3a2a1a`); the **accent slot** (`graphic1Color`) colors badge, chevrons, big glyph, and pill stroke, defaulting to the existing chevron yellow `#f1c40f`. All slots editable via the standard Color Overrides PI section.
- **Pill border rule** — `joined-pill`, `pill-end`, and `pill-middle-*` render with `border: { enabled: false, glowEnabled: false, locked: ["enabled", "glowEnabled"] }` so global border defaults never draw a second frame around the pill (the pill IS the border); a deliberate per-key border override still wins (#755 semantics). Other styles keep normal border behavior.
- **Pill geometry** — equal margins (14 units on the 144 canvas) on all sides when the key shows no label; a pair key with a bottom label shortens the frame above the label. Middle segments are open on both joined edges.
- **Live updates** — telemetry subscription per context (as View sub-modes do), memoized on the formatted value string, `icon-update-throttle` for bursts.
- **#612** — missing binding dims the content under the standard centered warning triangle (`applyBindingWarning`).
- **Platform** — only QT5-safe SVG (text, polyline, path, circle, opacity): identical rendering on Elgato, Mirabox, Ulanzi. No manifest changes (Keypad only).

## Interaction

- **Tap** = one step via the mode's existing dispatch (key binding `tapBinding` or API). Styles are purely presentational; the comms catalog (#612) and PI binding-status line are untouched.
- **Hold-to-repeat, always on** for every non-legacy directional key: `RepeatController` (shared module already used by Fuel Service and Replay Control) with `holdMs` = the plugin-wide long-press threshold global (default 500 ms), repeat interval ≈ 150 ms (tune during implementation), built-in safety cap. Legacy-style keys keep today's exact behavior, consistent with the seeding rule.
- **View keys unchanged behaviorally** — read-only or dual-press per #540; `pill-middle-*` is display-only.
- **Readiness/#612** — unchanged per-mode computation (`setActiveBinding`, per-button `isBindingMissing`).

## Property Inspector

- One shared partial (`adjust-style.ejs` in `packages/pi-components/partials/`): **Key Style** `sdpi-select` + conditionally visible **Position in pair** `sdpi-select` (only for the position-aware styles), using the standard conditional-visibility pattern.
- Each adopting action includes the partial and gates it per mode: directional modes with a value source → full style list; View modes → Display Style (Default / Pill middle H / Pill middle V); valueless modes → hidden (legacy only).
- No new global settings. Color / title / border / graphic override sections apply unchanged.

## Rollout

1. **Phase 1** — the seven setup actions (brakes, traction, fuel, engine, aero, chassis, hybrid): every directional sub-mode (each already has a `VIEW_DEFS` entry mapping it to telemetry field + formatter) plus View `pill-middle-*`.
2. **Phase 2** — Fuel Service fuel-to-add (value from action state) and Replay Speed (telemetry).
3. **Later** — other adjustables as value sources appear. Valueless modes (camera nudges, view adjustment) stay legacy-only.

Each phase ships with its artifacts: action docs, website action pages + changelog entry, `iracedeck-actions` skill listing, and rule/CLAUDE.md updates where conventions change.

## Testing

- **Shared module** — per style × direction × position SVG content assertions; unit stripping (incl. signed values); fresh-key seeding one-shot (no re-stamp on configured keys); `auto` position derivation; `.catch` degradation for unknown persisted values.
- **Per action** — style dispatch; repeat wiring with mocked timers (hold below/above threshold, release stops loop, safety cap); #612 overlay; memoized re-render fires only on value change.
- No preview-script changes (dynamic templates are not in the `packages/icons` preview pipeline).

## Out of scope

- Dial surfaces (Fuel Service / Setup Brakes / Audio dials) — unchanged.
- Auto-detection of adjacent partner keys via coordinates — rejected as fragile across folders/profiles/devices; position is an explicit (or auto-derived) setting.
- A dedicated standalone "Paired Adjust" action — rejected; would duplicate mode/binding/comms plumbing (see decision log).

## Decision log

- **Scope**: everything adjustable, phased; value display required for the new styles (2026-07-07).
- **Approach**: style setting on existing directional actions + shared renderer in `iracing-actions/shared` — over a standalone action or a deck-core framework (dependency direction: deck-core can't see telemetry fields).
- **Default**: seed — existing keys stay `legacy`, freshly placed keys get `split` (C).
- **Units**: dropped from the new styles' value text; bigger value instead.
- **Hold-to-repeat**: always on for non-legacy directional styles.
- **Triples**: emergent (no group setting); middle = View key; outer keys use no-value styles without title text.
- **Pill margins**: equal on all sides when the key has no label.
