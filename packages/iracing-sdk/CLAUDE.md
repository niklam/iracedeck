# @iracedeck/iracing-sdk

The TypeScript layer over the native iRacing SDK (`@iracedeck/iracing-native`). The API reference is in `README.md`.

## What it holds

- `SDKController` — the telemetry poll, every 10 ms (`TELEMETRY_INTERVAL_MS`), deduped on `SessionTick` so subscribers see each tick once.
- Session-YAML parsing (`session-yaml.ts`, `session-utils.ts`).
- `createSDK` / `createCommands` (`factory.ts`) — the `Commands` broadcast surface behind `@iracedeck/deck-iracing`'s `getCommands()`.
- The template resolver (`template-resolver.ts`, `template-context.ts`) for key titles.
- Flag, position, grid and track utilities (`flag-utils.ts`, `penalty-flag-utils.ts`, `position-utils.ts`, `grid-utils.ts`, `track-utils.ts`, and the gap, wind and iRating helpers beside them).

## Readers

`@iracedeck/sim-events-iracing` is the bus's only translator, but not the only reader: actions read the controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry through the translator's `getLatestTelemetry()`. For the live race order use the translator's `getLiveRacePositions` / `getLivePosition`, not this package's position utilities directly (`.claude/rules/race-positions.md`).
