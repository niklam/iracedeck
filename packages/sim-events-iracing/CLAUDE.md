# @iracedeck/sim-events-iracing

The iRacing translator (`initializeSimEventsIracing`, `src/translator.ts`): it diffs `sdkController` ticks and publishes semantic events on `@iracedeck/event-bus`, one diff module per family under `src/diff/`.

## Place in the architecture

- It is the bus's only source of sim events. A future sim adapter is a parallel sibling emitting the same catalog. The one exception is `telemetryReadout.requested`, which the deck layer publishes, not a translator.
- It is not the only reader of `@iracedeck/iracing-sdk` telemetry: actions read the SDK controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry — through the `getLatestTelemetry` dependency `race-engineer-wiring` fills from this package's getter by way of `SimRuntime`, never by importing it (#1378). `TelemetryData` is re-exported as a type so those consumers name the tick's shape without importing `iracing-sdk`. The measured leaks are listed under the Architecture page's "Seams & where the abstraction leaks" (#1351).

## What it owns besides the events

- **The canonical live order** — `getLiveRacePositions` / `getLivePosition` (`race-order.ts`). Every position consumer must use it; see `.claude/rules/race-positions.md`.
- **The pace lineup, that rule's one carve-out** — who a driver lines up behind under a caution or in a rolling-start formation: `getPaceLineup()` (`diff/pace-lineup.ts`), whose `anchor` says which of the two frames the rows were counted in (#1127 / #1167); the formation as a state, `getRollingStartFormation()` (#1167); and the caution catch-up reading, `getCautionGap()` — measured in `diff/caution-gap.ts`, decided by `diffCatchUp` in `diff/caution.ts` (#1168).
- **The last-stop tire temperature reading** Session Info shows (`getLastStopTireTemps`, #254).
- **The session kind** the Stream Deck plugin switches profiles by: `getSessionKind()`, from `classifySessionKind()` in `session-kind.ts` (#1111). Deliberately separate from the translator's three-bucket `classifySessionType`, which the Race Engineer depends on; see `.claude/rules/profiles-and-devices.md`.

## Recording for `@iracedeck/replay-store`

Pre-guard recorder diffs, which share one eligibility module (`diff/replay-record-gate.ts`), publish what the replay store writes:

- every car's lap crossings — `replay-laps`, `replay.lapStarted` / `replay.lapTimed` (#1203);
- the race start and caution restarts — `replay-greens`, `replay.greenFlag` (#1354);
- each session's start and every incident — `replay-sessions`, `replay.sessionStarted`, and `replay-incidents`, `replay.incident` (#1426).

The session starts are also recorded out of the car at the live edge of a live session, through the gate module's second resolver.

## Rules

- A new bus event needs an entry in the scenario harness's `src/event-names.ts`, and a new callout a shortcut button there (`packages/scenario-harness/CLAUDE.md`).
- Captured telemetry fixtures for the diff tests live in `src/diff/__fixtures__/` (see its `README.md`).
