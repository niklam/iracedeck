# @iracedeck/race-engineer-wiring

The Race Engineer's wiring, in one place (#1349): the plugin-side bus caches the engine's conditions read (`caches.ts`), every one of `registerPitCrew`'s 58 dependencies (`pit-crew-deps.ts`), and the call (`wireRaceEngineer`). The three plugins reach it through `@iracedeck/plugin-runtime`'s `initRaceEngineer`; the scenario harness calls it directly, with its three snapshot stubs as `overrides`.

## Boundaries

- It imports `audio-scenarios`, `deck-core`, `event-bus`, `sim-events-iracing` and `logger`. `deck-core` never imports it (the cycles run one way only). Settings, `evaluateSetupWarning` and `resolveActiveDriverName` come from `deck-core` directly; nothing `deck-core` provides is injected.
- It takes one `logger` and makes every logger it needs with `logger.createScope(...)`; the bootstrap passes `adapter.createLogger("RaceEngineer")`, so its lines print as `[RaceEngineer:LapCompleted]` and the like on Mirabox and Ulanzi, and as `RaceEngineer->LapCompleted` on Stream Deck, whose SDK joins scopes with `->`.
- `voice` is the voice-pack phase's driver-name state, read on every call (the harness passes its seeded list).
- `SimRuntime` (`sim-runtime.ts`) is the translator's query side as one object. It is iRacing-shaped; making it sim-neutral is #1351.
- The 30 `get<Family>CalloutEnabled` closures are here unchanged; replacing them is #1350.

## Rules

- A new `PitCrewDeps` key fails `pnpm typecheck` until `buildPitCrewDeps` builds it (`Required<PitCrewDeps>`), so nothing is left to `DEFAULT_DEPS`. A new family gate gets a row in `pit-crew-deps.test.ts`'s `GATES` table.
- A cache the engine's `where:` clauses read is subscribed in `subscribeRaceEngineerCaches`, which runs before `registerPitCrew`.

## Build

`pnpm build` runs `tsc` into `dist/`, which is what its consumers resolve: the three plugin bundles, through `plugin-runtime` (raw TypeScript compiled into each bundle, whose import of this package resolves to `dist/`), and the scenario harness, whose `tsc` and runtime (`dev` and `start` alike) resolve it there, so build this package before running the harness. Tests run against `src/` through the root Vitest alias.
