# Issue #183 — Backup driver input controls (Car Control modes) — Design

**Issue:** [#183](https://github.com/niklam/iracedeck/issues/183) — Add backup driver input controls: Handbrake, Second Clutch, Second Upshift/Downshift

**Approach:** Extend the existing **Car Control** action with four new modes (approved over a separate dedicated action). This matches the issue's framing ("sub-actions under Car Control") and the precedent of the last four-mode addition. No new UUIDs, no manifest changes; all three plugins pick the modes up automatically.

## Naming decision

The issue writes "Second Up-Shift" / "Second Downshift", but `docs/keyboard-shortcuts.md` (the authoritative source for iRacing control names) and iRacing's own Controls UI use **"Second Up Shift"** and **"Second Down Shift"**. The iRacing naming was approved and is used everywhere: labels, control values, setting keys, docs.

## New modes

| Mode | Control value | Global setting key | Pattern | iRacing Setting | Default key |
|------|---------------|--------------------|---------|-----------------|-------------|
| Handbrake | `handbrake` | `carControlHandbrake` | Hold | Handbrake | *(none)* |
| Second Clutch | `second-clutch` | `carControlSecondClutch` | Hold | Second Clutch | *(none)* |
| Second Up Shift | `second-up-shift` | `carControlSecondUpShift` | Tap | Second Up Shift | *(none)* |
| Second Down Shift | `second-down-shift` | `carControlSecondDownShift` | Tap | Second Down Shift | *(none)* |

All four are **key binding only** — no SDK support, no `dc*` telemetry variables, no default iRacing key binding (the user must configure the binding in both iRacing and the Property Inspector). Static icons only; `TELEMETRY_AWARE_CONTROLS` is untouched.

## Behavior (`car-control.ts`)

- Add the four control values to the `CarControlSettings` Zod enum and the `CarControlType` union.
- Add the four global setting keys to `CAR_CONTROL_GLOBAL_KEYS`.
- Add `handbrake` and `second-clutch` to `HOLD_CONTROLS` — press on keyDown/dialDown via `holdBinding`, release on keyUp/dialUp via the existing generic release path (same as starter and headlight flash).
- The two shift modes dispatch through the existing default `tapBinding` path — no new code.
- Static icon rendering flows through the existing `STATIC_CAR_CONTROL_ICONS` / `CAR_CONTROL_STATIC_TITLES` path, including the missing-binding ⚠️ overlay (the `CAR_CONTROL_GLOBAL_KEYS` mapping is all the generic code needs).

## Icons (`packages/icons/car-control/`)

Four new trimmed-viewBox graphic snippets, safe SVG Tiny 1.2 features only (shapes, text, fill/stroke, opacity), car-control's standard `#2a3a2a` background in `<desc>`:

- `handbrake.svg` — the dashboard handbrake symbol: circle with "!" flanked by parenthesis arcs, in semantic red (`#e74c3c`). The red is semantic and fixed; if the outline uses `{{graphic1Color}}` alongside it, lock the slot via `"locked"` so global presets can't clash.
- `second-clutch.svg` — clutch disc (segmented circle) with a small "2ND" badge.
- `second-up-shift.svg` — bold up arrow with a "2ND" badge.
- `second-down-shift.svg` — bold down arrow with a "2ND" badge.

The "2ND" badge distinguishes the shift arrows from other arrow-based icons (volume, view adjustments) per the icon distinctiveness rule.

Default titles (in `<desc>` title metadata): `HANDBRAKE`, `2ND\nCLUTCH`, `2ND\nSHIFT UP`, `2ND\nSHIFT DOWN`.

After authoring: run `node scripts/generate-icon-previews.mjs` and `node scripts/generate-icon-defaults.mjs`.

## Property Inspector (`car-control.ejs`)

Append four options to the Control dropdown: Handbrake, Second Clutch, Second Up Shift, Second Down Shift. No new conditional settings (auto-hold stays escape/enter-exit-tow only). The `ird-binding-status` line picks the new modes up from the regenerated comms catalog.

## Data / catalog

- `packages/iracing-actions/src/actions/data/key-bindings.json` — four new `carControl` entries (ids `handbrake`, `secondClutch`, `secondUpShift`, `secondDownShift`; empty `default`).
- `packages/iracing-actions/src/actions/comms-catalog.ts` — four `keybind(...)` descriptors under `car-control`; regenerate with `pnpm generate:action-comms` (freshness + key cross-check tests guard this).

## Tests (`car-control.test.ts`)

- Icon generation returns a valid SVG data URI for each new mode.
- `CAR_CONTROL_GLOBAL_KEYS` maps the four new control values to the expected setting keys.
- Hold behavior: keyDown on handbrake / second-clutch calls `holdBinding`; keyUp calls `releaseBinding`.
- Tap behavior: keyDown on the shift modes calls `tapBinding`.

## Docs & sync artifacts

- **Website** `packages/website/src/content/docs/docs/actions/driving/car-control.md` — four new mode sections in the per-mode format (Method: Key binding; Dial: no rotation support, hold-on-dial-press noted for the hold modes; Default binding: none; Telemetry-aware icon: No), sidebar badge 10 → **14 modes**, intro sentence updated.
- **Changelog** `packages/website/src/content/docs/changelog.mdx` — one `**Features**` line under the in-development version.
- `docs/reference/actions.json` — four mode entries under `com.iracedeck.sd.core.car-control`.
- `.claude/skills/iracedeck-actions/SKILL.md` — Car Control mode list 10 → 14; Driving Controls category modes 31 → 35.
- `docs/keyboard-shortcuts.md` — already lists all four controls (SDK: No); no change needed.
- No internal per-mode doc pages under `docs/plugins/core/actions/` (precedent: none were added for the last four car-control modes).
- No manifest, README action-count, or architecture-page changes (no new action, no structural change). Verify during implementation that no count mentioning car-control modes exists elsewhere.

## Verification

`pnpm build`, `pnpm lint:fix`, `pnpm format:fix`, `pnpm test` (no watcher running — all manual), plus the icon preview/defaults scripts and `pnpm generate:action-comms`. Manual iRacing test by the user before any push/PR.

## Out of scope

- Second Throttle / Second Brake (analog axes — not button-mappable, listed adjacent in iRacing's controls but excluded by the issue).
- Telemetry-aware state for any of the four modes (no `dc*` variables exist).
