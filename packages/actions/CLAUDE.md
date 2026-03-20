# @iracedeck/actions

All 33 platform-agnostic iRaceDeck action classes. These actions contain no platform-specific code — they import from `@iracedeck/deck-core` and are registered by platform-specific entry points (e.g., `stream-deck-plugin/src/plugin.ts`).

## Package Structure

```text
src/
  index.ts                    # Barrel export of all actions + UUIDs
  actions/
    splits-delta-cycle.ts     # Action class + UUID constant
    splits-delta-cycle.test.ts
    black-box-selector.ts
    ...                       # 33 action files + 33 test files
    race-admin-commands.ts    # Helper (no action class)
    race-admin-modes.ts       # Helper (no action class)
icons/
  car-control.svg             # Dynamic SVG templates (telemetry-driven)
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

This package has **no build step**. It exports raw TypeScript source. Consumer packages (e.g., `stream-deck-plugin`) bundle it via their Rollup config with `@rollup/plugin-typescript`.

The `stream-deck-plugin` Rollup config includes:
- `resolve-actions-ts` plugin — resolves `.js` → `.ts` for relative imports within this package
- `typescript({ include: ["src/**/*.ts", "../actions/src/**/*.ts"] })` — compiles action TypeScript
- `svgPlugin()` — resolves `@iracedeck/icons/` and local `../../icons/` SVG imports

## Tests

```bash
# From monorepo root
pnpm test --filter @iracedeck/actions

# Or run specific test
npx vitest run packages/actions/src/actions/splits-delta-cycle.test.ts
```

Tests mock `@iracedeck/deck-core` (not `@elgato/streamdeck`). The mock `ConnectionStateAwareAction` provides a logger, `sdkController`, `setKeyImage`, `setRegenerateCallback`, and lifecycle stubs.

## Adding a New Action

See `packages/stream-deck-plugin/CLAUDE.md` for the full step-by-step guide. The action source file goes in this package; registration and PI templates go in `stream-deck-plugin`.
