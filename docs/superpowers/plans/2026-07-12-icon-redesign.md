# Icon Redesign (#827) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ~170 template SVGs across 16 icon sets with the approved rich design language, consolidate FFB Max Force into Force Feedback, add tri-state rendering to ABS/TC toggles, and sync all documentation.

**Architecture:** A one-off emitter script (scratchpad, not committed) ports the approved artwork — already encoded as JS snippet functions in the design-phase gallery generators — into repo-format graphic snippets (trimmed viewBox, `<desc>` metadata, Mustache slots, per-file `<defs>`). Behavioral changes (mode consolidation, tri-state toggles) are ordinary TS edits with tests. Docs/website/skill sync closes it out.

**Tech Stack:** Node ESM scripts, SVG 1.1 (resvg target), Vitest, EJS PI templates.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-icon-redesign-design.md` — per-set compositions are authoritative; artwork sources are the approved gallery generators in the session scratchpad (`gen-ff.mjs`, `gen-media.mjs`, `gen-camedit.mjs`, `gen-cockpit-tele.mjs`, `gen-setup1.mjs`, `gen-chassis.mjs`, `gen-setup3.mjs`, `gen-final.mjs`, plus `blackbox-v6.html` and the eye/wheel/camera fix screens).
- Icon SVG format per `.claude/rules/icons.md` / `key-icon-types.md`: trimmed viewBox, no background rect, no title text elements, `<desc>` JSON `{colors, title, border}` (keep each set's current `backgroundColor`/`border` values and title texts unless the spec changed them).
- Mustache slots: metal artwork = base fill `{{graphic1Color}}` + fixed shade/sheen overlays; background cutouts = `{{backgroundColor}}`; semantic colors literal. Preserve each icon's current `locked` arrays.
- After ANY icon change: `node scripts/generate-icon-previews.mjs`; after all icons: `node scripts/generate-icon-defaults.mjs`.
- Build verification: review full `pnpm build` output for `TS\d+:` diagnostics, not just exit code.
- Commit per task (`git add` specific paths). NO push, NO PR — Niklas tests on hardware first.
- Changelog: single line under the in-development version in `packages/website/src/content/docs/changelog.mdx`.

---

### Task 1: Emitter scaffold + Force Feedback set (11 SVGs)

**Files:**
- Create (scratchpad, uncommitted): `build-icons.mjs` — shared helpers: `defs(materialsUsed)`, `shaded(shape)` ({{graphic1Color}} + overlay technique), `chip(sign)`, `aBadge(pos)`, `emit(set, file, viewBox, descMeta, art)` + XML well-formedness + placeholder-presence validation.
- Replace: `packages/icons/force-feedback/*.svg` (11)
- Test: existing preview freshness test (`packages/icons`), visual check via regenerated previews.

**Interfaces:** Produces the emitter helpers reused by Tasks 2–9; every later icon task calls `emit()` with ported artwork.

- [ ] Port FF artwork from `gen-ff.mjs` v5 (momo wheel, Nm weight, both-way arc, arcs/sine/subwoofer/puck, A-badge on auto).
- [ ] Run emitter for `force-feedback`; run `node scripts/generate-icon-previews.mjs`; run `pnpm test packages/icons` → freshness PASS.
- [ ] Eyeball previews; commit `improve(icons): redesign force-feedback icon set (#827)`.

### Task 2: Look Direction (4) + Media Capture (7)

Port eye family (fixes-round4 geometry + v5 nudge: Left iris cx=31, Right cx=65; clipPath lids) and media artwork (`gen-media.mjs`). Emit → previews → test → commit per set.

### Task 3: Camera Editor Adjustments (30)

Port `gen-camedit.mjs` v2 (pitch per-sign, A-badge on auto-set-mic-gain both signs). Emit → previews → test → commit.

### Task 4: Cockpit Misc (5) + Telemetry Control (6)

- Port `gen-cockpit-tele.mjs` v3 (text dashes, IN LAP board, trace + badges, save-into-tray snapshot).
- `git rm packages/icons/cockpit-misc/ffb-max-force-{increase,decrease}.svg` (consolidation, Task 10 rewires code before the build can break — do Task 10 in the same commit if the plugin build references them; otherwise commit here and fix imports in Task 10 within the same push-less branch, keeping each commit buildable: **check `cockpit-misc.ts` imports first; if referenced, defer the `git rm` to Task 10.**)
- Emit → previews → test → commit.

### Task 5: Setup Aero (7) + Brakes (13) + Engine (8)

Port `gen-setup1.mjs` v4 (hero wings, per-mode brake artwork with R-left/F-right balance, ISO ABS, turbo v2). `abs-toggle.svg` = ISO symbol only (status bar is runtime). Emit → previews → test → commit.

### Task 6: Setup Chassis (26)

Port `gen-chassis.mjs` (corner-map system, diff corner-arc badges, PS wheel+bolt). Emit → previews → test → commit.

### Task 7: Setup Fuel (7) + Hybrid (9) + Traction (9)

Port `gen-setup3.mjs` v2 (valve, flag, battery family, padlock, deploy dial; `tc-toggle.svg` = big TC text only). Emit → previews → test → commit.

### Task 8: Chat (6) + View Adjustment (9)

Port `gen-final.mjs` v4 (in-bubble whisper/power, reply arrow — `respond-pm.svg` duplicates reply; direction-aware fov/horizon/ui-size/driver-height; horizon rim last). Emit → previews → test → commit.

### Task 9: Black Box (13) + rule update

Port `blackbox-v6.html` tiles (frame `#453a1c→#221a0a` stroke `#6a5138`, per-box content, 0.8-scale crossed tools). Keep current `title` texts from existing `<desc>`s (incl. mirror's "GRAPHICS" — flag in PR notes). Rewrite `.claude/rules/black-box-icons.md` to the new frame spec + per-icon content list. Emit → previews → test → commit.

### Task 10: FFB Max Force consolidation

**Files:** `packages/iracing-actions/src/actions/cockpit-misc/cockpit-misc.{ts,ejs,test.ts}`, `force-feedback/force-feedback.ejs`, possibly `comms-catalog.ts` (no binding change expected).

- [ ] `cockpit-misc.ts`: keep `ffb-max-force` in the settings enum + handler (hidden-but-functional); switch its icon imports to `@iracedeck/icons/force-feedback/ffb-force-{increase,decrease}.svg`; delete the two cockpit-misc SVGs if not done in Task 4.
- [ ] `cockpit-misc.ejs`: remove the `ffb-max-force` `<option>`; add comment referencing #827 + the radar-volume precedent.
- [ ] `force-feedback.ejs`: label `ffb-force` option "FFB Force (max force)".
- [ ] Tests: cockpit-misc test asserting the hidden mode still resolves its bindings + icon; run `pnpm test packages/iracing-actions`.
- [ ] `pnpm generate:action-comms` (expect no diff; commit if regenerated). Commit.

### Task 11: Tri-state ABS/TC toggles

**Files:** `packages/iracing-actions/src/actions/setup-brakes/setup-brakes.{ts,test.ts}`, `setup-traction/setup-traction.{ts,test.ts}`; consume `statusBarOn/Off/NA`, `borderColorForState`, `ToggleState` from `src/icons/status-bar.js`.

- [ ] Failing tests: abs-toggle mode renders status bar from `dcABS` telemetry (on/off) and N/A without telemetry; tc-toggle renders N/A (no state source) — mirror the DRS test pattern in `car-control.test.ts`.
- [ ] Implement: telemetry subscription for the toggle modes (follow the existing view-mode subscription in each action), compose icon = mode SVG + status bar, pass `borderStateColor`.
- [ ] Tests green; commit.

### Task 12: Per-action statics + icon-defaults

- Regenerate `icon.svg` (20×20) + `key.svg` (72×72) for the 16 actions from each family mark (emitter variant baking defaults, no Mustache); `dial.svg` for the 7 setup actions.
- `node scripts/generate-icon-defaults.mjs`; verify no unintended default color changes (backgrounds unchanged → expect minimal diff).
- Previews regen; `pnpm test packages/icons packages/iracing-actions`; commit.

### Task 13: Docs, website, skill, changelog

- `.claude/rules/icons.md` + `key-icon-types.md`: add the design-system section (materials, chips, A-badge, tri-state, direction-aware list).
- `docs/` action pages + website action pages: icon-state tables for the affected actions; Cockpit Misc loses the FFB Max Force row, Force Feedback notes the consolidation.
- `iracedeck-actions` SKILL.md + `docs/reference/actions.json`: Cockpit Misc modes 7→6 visible (hidden alias documented), Force Feedback note.
- `changelog.mdx`: one Features line (icon redesign + consolidation).
- `pnpm --filter @iracedeck/website build` PASS; commit.

### Task 14: Full verification

- `pnpm build` (scan output for `TS\d+:`), `pnpm lint:fix`, `pnpm format:fix`, `pnpm test` — all green.
- Final visual sweep of `packages/icons/preview/**` vs the approved galleries; fix drifts; commit any stragglers.
- STOP: no push/PR — hand to Niklas for on-device testing.

## Self-Review

- Spec coverage: sets ↔ Tasks 1–9; consolidation ↔ 10; tri-state ↔ 11; statics/defaults ↔ 12; docs/skill/changelog/rules ↔ 13 (black-box rule in 9); verification ↔ 14. Send/macro + turtle exclusions need no task. ✓
- No placeholders: artwork geometry intentionally referenced to the committed spec + session generators rather than inlined (172 SVGs); executor is the design-phase session itself with full context. ✓
- Type consistency: `statusBarOn/Off/NA`, `borderColorForState`, `ToggleState` match `src/icons/status-bar.ts`. ✓
