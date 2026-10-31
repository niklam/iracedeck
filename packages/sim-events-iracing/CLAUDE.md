# @iracedeck/sim-events-iracing

The iRacing translator (`initializeSimEventsIracing`, `src/translator.ts`): it diffs `sdkController` ticks and publishes semantic events on `@iracedeck/event-bus`, one diff module per family under `src/diff/`.

## Place in the architecture

- It is the bus's only source of sim events. A future sim adapter is a parallel sibling emitting the same catalog. The one exception is `telemetryReadout.requested`, which the deck layer publishes, not a translator.
- It is not the only reader of `@iracedeck/iracing-sdk` telemetry: actions read the SDK controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry through `getLatestTelemetry()`. The measured leaks are listed under the Architecture page's "Seams & where the abstraction leaks" (#1351).

## What it owns besides the events

- **The canonical live order** — `getLiveRacePositions` / `getLivePosition` (`race-order.ts`). Every position consumer must use it; see `.claude/rules/race-positions.md`.
- **The pace lineup, that rule's one carve-out** — who a driver lines up behind under a caution or in a rolling-start formation: `getPaceLineup()` (`diff/pace-lineup.ts`), whose `anchor` says which of the two frames the rows were counted in (#1127 / #1167); the formation as a state, `getRollingStartFormation()` (#1167); and the caution catch-up reading, `getCautionGap()` — measured in `diff/caution-gap.ts`, decided by `diffCatchUp` in `diff/caution.ts` (#1168).
- **The track-order gaps** Session Info's Gaps shows outside a race: `getTrackGaps()` (`diff/track-gaps.ts`, #1515), the nearest cars ahead and behind on track in practice, warmup, testing and open qualifying (Lone Qualify and Lone Practice excluded), measured by the race gaps' crossing time over per-car odometer traces. Mutually exclusive with `getLiveGaps()`, which answers only in a race past the green. Deliberately not on `SimRuntime`, so the Race Engineer's gap callouts stay race-only.
- **The last-stop tire temperature reading** Session Info shows (`getLastStopTireTemps`, #254).
- **The session kind** the Stream Deck plugin switches profiles by: `getSessionKind()`, from `classifySessionKind()` in `session-kind.ts` (#1111). Deliberately separate from the translator's three-bucket `classifySessionType`, which the Race Engineer depends on; see `.claude/rules/profiles-and-devices.md`.

## Recording for `@iracedeck/replay-store`

Pre-guard recorder diffs, which share one eligibility module (`diff/replay-record-gate.ts`), publish what the replay store writes:

- every car's lap crossings — `replay-laps`, `replay.lapStarted` / `replay.lapTimed` (#1203);
- the race start and caution restarts — `replay-greens`, `replay.greenFlag` (#1354);
- each session's start and every incident — `replay-sessions`, `replay.sessionStarted`, and `replay-incidents`, `replay.incident` (#1426).

The session starts are also recorded out of the car at the live edge of a live session, through the gate module's second resolver.

## The tick order (#1499)

`TICK_ORDER` (`src/tick-order.ts`) lists every stage of one `handleTick` that can publish, in the order its publishes reach the bus: the direct publishes first (the session-change sites, the pre-guard recorder diffs, the replay-entry teardown), then the `pending` batch the live diffs fill, flushed in call order. `findEndsOnOrderViolations` reads it to prove an `endsOn` contract's trigger is never published after its end on one tick (#1407); `race-engineer-wiring`'s `ends-on-order.test.ts` applies it to every registered contract. `tick-order.test.ts` proves the table is the code by spying on the real diff calls and publishes. Keeping it true:

- **A diff module that emits declares what.** It exports `<NAME>_EVENTS` (`as const satisfies readonly SimEventName[]`) and types its emitter `EmitFn<(typeof <NAME>_EVENTS)[number]>`. `EmitFn` has no default, so an emit the list does not name is a compile error; a module with two emitting functions declares one list each (`START_COUNTDOWN_EVENTS`, `START_LIGHTS_EVENTS`).
- **A new emitting diff, or one that starts emitting,** gets its `TICK_ORDER` row at its call position in `handleTick` (`via: "pending"` for a live diff, `"direct"` for a pre-guard one), whose `events` is the module's list itself rather than a copy, and a `vi.mock` spy line in `tick-order.test.ts` naming the index of its emitter argument. The completeness test fails on a declared list with no row, and the call-order test on a stage it never recorded. A diff that publishes nothing gets no row.
- **Reordering any diff call in `handleTick`** means moving its row too; the call-order test fails until it does. If an `endsOn` pair then fails in the wiring test, the reorder broke that contract: put the trigger's stage back ahead of its end's.
- **A new publish site in `translator.ts` itself** gets a `source: "translator.ts"` row and a real tick that publishes from it in the translator-sites test; the completeness test fails on an event those sites name that no such row lists.

## Rules

- A new bus event needs an entry in the scenario harness's `src/event-names.ts`, and a new callout a shortcut button there (`packages/scenario-harness/CLAUDE.md`).
- Captured telemetry fixtures for the diff tests live in `src/diff/__fixtures__/` (see its `README.md`).
