# @iracedeck/race-engineer-wiring

The Race Engineer's wiring, in one place (#1349): the plugin-side bus caches the engine's conditions read (`caches.ts`), every one of `registerPitCrew`'s 30 dependencies (`pit-crew-deps.ts`; `pit-crew-deps.test.ts` pins the count, so a new one bumps both), and the call (`wireRaceEngineer`). The three plugins reach it through `@iracedeck/plugin-runtime`'s `initRaceEngineer`; the scenario harness calls it directly, with its three snapshot stubs as `overrides`.

## Boundaries

- It imports `audio-scenarios`, `settings`, `event-bus`, `sim-events-iracing` and `logger`. Neither `settings` nor `deck-core` imports it (the cycles run one way only). Settings, `isCalloutEnabled`, `evaluateSetupWarning` and `resolveActiveDriverName` come from `@iracedeck/settings` directly (#1365); nothing it provides is injected.
- It takes one `logger` and makes every logger it needs with `logger.createScope(...)`; the bootstrap passes `adapter.createLogger("RaceEngineer")`, so its lines print as `[RaceEngineer:LapCompleted]` and the like on Mirabox and Ulanzi, and as `RaceEngineer->LapCompleted` on Stream Deck, whose SDK joins scopes with `->`.
- `voice` is the voice-pack phase's driver-name state, read on every call (the harness passes its seeded list).
- `SimRuntime` (`sim-runtime.ts`) is the translator's query side as one object. It is iRacing-shaped; making it sim-neutral is #1351. Three of its readers serve the pace lineup: `getPaceLineup` (the caution's and the formation's, #1127 / #1167), `getRollingStartFormation` (#1167) and `getCautionGap` (#1168), each passed to `registerPitCrew` as a live read the callouts ask at speak time.
- Every callout opt-in is one dependency, `isCalloutEnabled`, passed straight from `@iracedeck/settings` (#1350): each family in `registerPitCrew` resolves its own callout id to a key through `@iracedeck/callout-settings`, so a new callout needs no change here.

## Rules

- A new `PitCrewDeps` key fails `pnpm typecheck` until `buildPitCrewDeps` builds it (`Required<PitCrewDeps>`), so nothing is left to `DEFAULT_DEPS`.
- A cache the engine's `where:` clauses read is subscribed in `subscribeRaceEngineerCaches`, which runs before `registerPitCrew`.

## Build

`pnpm build` runs `tsc` into `dist/`, which is what its consumers resolve: the three plugin bundles, through `plugin-runtime` (raw TypeScript compiled into each bundle, whose import of this package resolves to `dist/`), and the scenario harness, whose `tsc` and runtime (`dev` and `start` alike) resolve it there, so build this package before running the harness. Tests run against `src/` through the root Vitest alias.
