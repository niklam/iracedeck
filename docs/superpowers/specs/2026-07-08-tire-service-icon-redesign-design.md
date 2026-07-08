# Tire Service Icon Redesign — Design

_2026-07-08 · #815 · approved in brainstorming_

## Scope

Visual-only redesign of three Tire Service modes: **Change Compound**, **Change All Tires**, **Clear Tires**. Behavior (the iRacing commands each sends) is unchanged. The `toggle-tires` mode is **out of scope** and untouched. Background stays the existing tire-service brown `#3a2a2a` (kept so all four modes remain consistent).

## Change Compound (dynamic, telemetry-driven)

Replace the two-concentric-circles tire glyph with an **F1 compound badge**: a bold colored ring + the compound's initial letter, name spelled below.

- **Colors** (`getCompoundColor`, unchanged): soft = `#e74c3c`, medium = `#f1c40f`, hard = `#ffffff`, intermediate = `#2ecc71`, wet = `#3498db`, **anything else (incl. dry) = `#888888` gray** — deliberately distinct from hard's white so Dry and Hard are never confused. This is already the fallback; no color-map change.
- **Initial** = first character of the display name (`getCompoundName`), uppercased: SOFT→S, MEDIUM→M, HARD→H, INTER→I, WET→W, DRY→D.
- **Badge geometry** (144 canvas): ring `circle cx=72 cy=54 r=33 stroke-width=9`; letter centered in the ring via baseline math (`y = 54 + round(0.36·fontSize)`, no `dominant-baseline` — Qt ignores it), font-size ~40 bold, both in the compound color.
- **Two states** (from `isChanging = player ≠ pitSv`):
  - **Changing** — vivid badge; label two lines `CHANGE TO` (muted) + `<NAME>` (compound color).
  - **Staying on** — badge dimmed (`opacity 0.55`) + a small green ✓ badge top-right; label `STAYING ON` (muted) + `<NAME>` (muted gray). Reads "settled, nothing pending."
- Rendered through the existing dynamic template `icons/tire-service.svg` (`iconContent` = badge, `textElement` = labels). Telemetry subscription / state-key memoization unchanged.

## Change All Tires & Clear Tires (static)

A matched **four-corner tire set** (the car's four corners as rounded rects):

- **Change All** — four corners filled green `#2ecc71`, a small change ↻ in a center hub; title `TIRES / CHANGE ALL`.
- **Clear** — four corners empty (grey outline), a bold red `#e74c3c` diagonal wipe across; title `TIRES / CLEAR`.

Authored as trimmed-viewBox graphic-snippet SVGs (`packages/icons/tire-service/{change-all-tires,clear-tires}.svg`) with `<desc>` metadata, assembled via `assembleIcon` exactly as today (background/title/border/graphic slots colorizable; the semantic green/red action colors are fixed). Regenerate previews + icon-defaults.

## Files

- `packages/iracing-actions/src/actions/tire-service/tire-service.ts` — rewrite `generateTireIcon` to emit the badge; update the `change-compound` case for the change/stay treatment and `CHANGE TO`/`STAYING ON` wording.
- `packages/iracing-actions/src/actions/tire-service/tire-service.test.ts` — update compound-icon + change/stay assertions (wording `STAYING ON`; badge contains the compound color + initial); keep `getCompoundColor`/`getCompoundName` tests.
- `packages/icons/tire-service/change-all-tires.svg`, `clear-tires.svg` — new artwork; then `node scripts/generate-icon-previews.mjs` + `node scripts/generate-icon-defaults.mjs`.
- Docs: `packages/website/src/content/docs/docs/actions/pit-service/tire-service.md` (icon descriptions) + `changelog.mdx` (2.1.0, Improvements). Action-doc icon table if present.

## Out of scope

- `toggle-tires` mode, the compound cycle logic, the color map itself, any behavior. No manifest / registration changes.

## Decisions log

- Dry = gray (user), distinct from hard's white.
- Wording: `CHANGE TO` / `STAYING ON` (uppercase, matching the approved mockup).
- No ↻ badge on the compound key (its yellow clashed with the Medium compound; vivid/dim + wording carry the state).
- Background stays `#3a2a2a` (toggle-tires consistency; not requested to change).
- Change All / Clear = four-corner "Set 1" (user pick).
