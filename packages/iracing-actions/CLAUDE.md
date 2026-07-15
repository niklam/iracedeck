# @iracedeck/iracing-actions

The platform-agnostic iRaceDeck action classes — one folder per action under `src/actions/`. Actions contain no platform-specific code — they import from `@iracedeck/deck-core` and are registered by each plugin's entry point (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`, each in its `src/plugin.ts`).

## Package Structure

```text
src/
  index.ts                               # Barrel export of all actions + UUIDs
  actions/
    <action-name>/                       # One folder per action, self-contained
      <action-name>.ts                   # Action class + UUID constant
      <action-name>.test.ts              # Unit tests
      <action-name>.ejs                  # Property Inspector template
      icon.svg                           # Category icon (20x20)
      key.svg                            # Key icon (72x72)
    race-admin/                          # Same layout plus non-action helper modules
                                         # (commands, modes, #732 selector slot math + icon,
                                         # #491 useViewedCar settings migration)
    comms-catalog.ts                     # Authoritative per-(action, mode) comms source (#612)
    data/                                # Shared template data
      action-comms.json                  # GENERATED from comms-catalog.ts
      docs-urls.json
      icon-defaults.json
      key-bindings.json
      profiles.json                      # GENERATED bundled-profile registry (pnpm generate:action-profiles)
    settings/                            # Plugin-global PI template
      settings.ejs
  audio/                                 # Shared audio helpers: Race Engineer/Radar feature-gate
                                         # toggles + voice-sequence player (audio-toggles), bus
                                         # volume steppers (audio-volume)
  icons/                                 # status-bar: tri-state (on/off/na) toggle indication shared
                                         # by status bars, state borders, and dial bar styling
  shared/                                # Cross-action utilities (see below)
icons/                                   # Dynamic SVG templates (telemetry-driven)
```

`src/shared/` holds cross-action utilities:

- `adjust-styles.ts` — paired +/− key styles: style catalog, shared settings fields + fresh-key seeding, value-source gating over VIEW_DEFS, and the SVG renderer (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md)
- `black-box.ts` — canonical black-box id↔global-key map (`BLACK_BOX_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`) plus `showBlackBox()` / `resolvePrimeKey()`: press a different box first, then the target, as one atomic key sequence, because a black-box hotkey toggles and telemetry never reports the shown box (#818)
- `car-select-intent.ts` — per-device intent deciding what a selector car-key press means (admin target vs camera focus, #790)
- `dial-box.ts` — shared Stream Deck+ dial "dash box" renderer + `dialAppearanceFields` settings fragment: the seven Setup dial surfaces plus Camera Editor Adjustments resolve their per-setting accent plus user color overrides (`resolveDialBoxColors`) and route rendering through `renderDialBox` (#811). `renderDialBox` takes two additive optional capabilities (#804), both default-off so existing callers are unchanged: `labelLayout: "top"` places an identity-only label small near the frame top (default `"center"`), and `innerGraphic` injects extra resvg-safe SVG inside the frame beneath the #612 warning dim (Camera Editor Adjustments passes a static −/+ rotary arc there). Identity-only labels are baseline-centered (`+0.36em`) so they sit truly centered rather than above center
- `dial-name-icon.ts` — plain two-line action-name image that dual-surface actions push for dial contexts (#775)
- `icon-update-throttle.ts` — per-context throttle + trailing-edge coalescer for telemetry-driven `setKeyImage` bursts (#493)
- `profile-entries.ts` — shared `_deviceProfiles` PI-dropdown entry building + echo-loop change guard (#790)
- `repeat-controller.ts` — long-press hold-to-repeat timing controller
- `setup-view.ts` — registry, formatters, and render helper for the setup actions' "View …" sub-modes (#541)

The top-level `icons/` directory holds one 144x144 runtime template per dynamic-icon action (content rendered from live telemetry) — see the directory for the current set and `.claude/rules/icons.md` for the template format.

## Action Pattern

See `.claude/rules/stream-deck-actions.md` for the full requirements (UUID constant, `ConnectionStateAwareAction`, `CommonSettings`, icon assembly, super calls, settings handlers).

## Comms Catalog (#612)

`src/actions/comms-catalog.ts` (in this package) is the authoritative record of how every (action, mode) talks to iRacing — API, key binding, or chat. After editing it, run `pnpm generate:action-comms` from the repo root to regenerate `data/action-comms.json`; a freshness test (`comms-catalog.test.ts`) fails when the committed JSON drifts from the catalog, and a cross-check verifies every keybind key exists in `key-bindings.json`. The full wiring (PI status line, icon overlay) is in `.claude/rules/stream-deck-actions.md` §"Per-Mode Communication Method & Binding Status".

## Build

This package has **no build step**. It exports raw TypeScript source. Consumer packages (e.g., `iracing-plugin-stream-deck`) bundle it via their Rollup config with `@rollup/plugin-typescript`.

The `iracing-plugin-stream-deck` Rollup config includes:
- `resolve-actions-ts` plugin — resolves `.js` → `.ts` for relative imports within this package
- `typescript({ include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts"] })` — compiles action TypeScript
- `svgPlugin()` — resolves `@iracedeck/icons/` and local `../../icons/` SVG imports

## Tests

```bash
# From monorepo root — scope by path (the root `test` script is `vitest run`)
pnpm test packages/iracing-actions

# Or run a specific test file
npx vitest run packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts
```

Tests mock `@iracedeck/deck-core` (not `@elgato/streamdeck`) — the canonical mock is in `.claude/rules/testing.md`. Binding-aware actions additionally stub `isBindingMissing` on the mock `ConnectionStateAwareAction` (see `splits-delta-cycle/splits-delta-cycle.test.ts`).

## Adding a New Action

See `packages/iracing-plugin-stream-deck/CLAUDE.md` for the full step-by-step guide. The action source file and PI template (`<name>.ejs`) stay in this package alongside the action code; action registration and `manifest.json` entries are done in every plugin package (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi` — each `src/plugin.ts` plus its manifest).
