# @iracedeck/iracing-actions

All 30 platform-agnostic iRaceDeck action classes. These actions contain no platform-specific code — they import from `@iracedeck/deck-core` and are registered by platform-specific entry points (e.g., `iracing-plugin-stream-deck/src/plugin.ts`).

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
    race-admin/                          # Same layout plus helpers
      race-admin-commands.ts             # Helper (no action class)
      race-admin-modes.ts                # Helper (no action class)
    data/                                # Shared template data
      icon-defaults.json
      key-bindings.json
      docs-urls.json
    settings/                            # Plugin-global PI template
      settings.ejs
icons/                                   # Dynamic SVG templates (telemetry-driven)
  car-control-pit-limiter.svg
  session-info.svg
  telemetry-display.svg
  tire-service.svg
```

## Action Pattern

Each action file exports:
1. A **UUID constant** (e.g., `export const SPLITS_DELTA_CYCLE_UUID = "com.iracedeck.sd.core.splits-delta-cycle" as const`)
2. An **action class** extending `ConnectionStateAwareAction` from `@iracedeck/deck-core`
3. Optionally, **`@internal` exported functions/constants** for testing (icon generation, global key names)

Actions receive their logger via constructor injection (from `BaseAction`). No `@action` decorator, no `@elgato/streamdeck` imports.

## Build

This package has **no build step**. It exports raw TypeScript source. Consumer packages (e.g., `iracing-plugin-stream-deck`) bundle it via their Rollup config with `@rollup/plugin-typescript`.

The `iracing-plugin-stream-deck` Rollup config includes:
- `resolve-actions-ts` plugin — resolves `.js` → `.ts` for relative imports within this package
- `typescript({ include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts"] })` — compiles action TypeScript
- `svgPlugin()` — resolves `@iracedeck/icons/` and local `../../icons/` SVG imports

## Tests

```bash
# From monorepo root
pnpm test --filter @iracedeck/iracing-actions

# Or run specific test
npx vitest run packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts
```

Tests mock `@iracedeck/deck-core` (not `@elgato/streamdeck`). The mock `ConnectionStateAwareAction` provides a logger, `sdkController`, `setKeyImage`, `setRegenerateCallback`, and lifecycle stubs.

## Adding a New Action

See `packages/iracing-plugin-stream-deck/CLAUDE.md` for the full step-by-step guide. The action source file and PI template (`<name>.ejs`) stay in this package alongside the action code; action registration and `manifest.json` entries are done in each plugin package (`packages/iracing-plugin-stream-deck/src/plugin.ts` and `packages/iracing-plugin-mirabox/src/plugin.ts`).
