# @iracedeck/sim-events-iracing

The iRacing translator (`initializeSimEventsIracing`, `src/translator.ts`): it diffs `sdkController` ticks and publishes semantic events on `@iracedeck/event-bus`, one diff module per family under `src/diff/`. The `replay.*` events come from a second subscriber beside it, the replay recorder (below).

## Place in the architecture

- It is the bus's only source of sim events. A future sim adapter is a parallel sibling emitting the same catalog. The one exception is `telemetryReadout.requested`, which the deck layer publishes, not a translator.
- It is not the only reader of `@iracedeck/iracing-sdk` telemetry: actions read the SDK controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry — through the `getLatestTelemetry` dependency `race-engineer-wiring` fills from this package's getter by way of `SimRuntime`, never by importing it (#1378). `TelemetryData` is re-exported as a type so those consumers name the tick's shape without importing `iracing-sdk`. The measured leaks are listed under the Architecture page's "Seams & where the abstraction leaks" (#1351).

## What it owns besides the events

- **The canonical live order** — `getLiveRacePositions` / `getLivePosition` (`race-order.ts`). Every position consumer must use it; see `.claude/rules/race-positions.md`.
- **The pace lineup, that rule's one carve-out** — who a driver lines up behind under a caution or in a rolling-start formation: `getPaceLineup()` (`diff/pace-lineup.ts`), whose `anchor` says which of the two frames the rows were counted in (#1127 / #1167); the formation as a state, `getRollingStartFormation()` (#1167); and the caution catch-up reading, `getCautionGap()` — measured in `diff/caution-gap.ts`, decided by `diffCatchUp` in `diff/caution.ts` (#1168).
- **The track-order gaps** Session Info's Gaps shows outside a race: `getTrackGaps()` (`diff/track-gaps.ts`, #1515), the nearest cars ahead and behind on track in practice, warmup, testing and open qualifying (Lone Qualify and Lone Practice excluded), measured by the race gaps' crossing time over per-car odometer traces. Mutually exclusive with `getLiveGaps()`, which answers only in a race past the green. Deliberately not on `SimRuntime`, so the Race Engineer's gap callouts stay race-only.
- **The last-stop tire temperature reading** Session Info shows (`getLastStopTireTemps`, #254).
- **The session kind** the Stream Deck plugin switches profiles by: `getSessionKind()`, from `classifySessionKind()` in `session-kind.ts` (#1111). Deliberately separate from the translator's three-bucket `classifySessionType`, which the Race Engineer depends on; see `.claude/rules/profiles-and-devices.md`.

## Recording for `@iracedeck/replay-store`

The replay recorder (`startReplayRecorder`, `src/replay-recorder.ts`, #1468) is a second SDK-controller subscriber, started by `initializeSimEventsIracing` right after the translator subscribes. Its four recorder diffs share one eligibility module (`diff/replay-record-gate.ts`) and publish what the replay store writes:

- every car's lap crossings — `replay-laps`, `replay.lapStarted` / `replay.lapTimed` (#1203);
- the race start and caution restarts — `replay-greens`, `replay.greenFlag` (#1354);
- each session's start and every incident — `replay-sessions`, `replay.sessionStarted`, and `replay-incidents`, `replay.incident` (#1426).

The session starts are also recorded out of the car at the live edge of a live session, through the gate module's second resolver.

- **No replay guard.** A recorder must see the ticks it cannot record, to mark itself unseeded on them and re-seed silently on the first eligible tick after; each diff's gate is the only one. Its "in a replay" answer is the controller's debounced replay state, read in its own callback.
- **Its own state**, `ReplayRecorderState` (`replay-recorder-state.ts`); it reads nothing of `TranslatorState`, and the translator's per-session and replay wipes never reach it. `readSimState()` reports it under `raw.replayRecorder`.
- **Its own reset points**, listed in the header of `replay-recorder.ts`: the lap, green and incident baselines at a session change (before the diffs run), on entering and on leaving a replay view (after them); everything at a disconnect. The session record (`replay-sessions`' run and published list) survives every reset but the disconnect.
- **Pinned across the move.** `replay-recorder.equivalence.test.ts` compares the `replay.*` stream of the real init with a golden recorded while the recorders still ran inside the translator; a deliberate behaviour change regenerates it (`REPLAY_GOLDEN_UPDATE=1`) and reviews the diff. One change the golden cannot see: inside the translator, the first subscriber, the recorders got the first connected tick twice at startup (the controller's connect notification, then the subscribe callback), so the session record published that session's start during init, before replay-store subscribed, and lost it; subscribed second, the recorder gets it once and publishes on the first poll. `replay-recorder.startup.test.ts` pins that over the real `SDKController`.

## Session identity (#1509)

`session-identity.ts` states once which tick starts a different session: a new `(SubSessionID, SessionNum)`, never inside a saved replay, read on every tick, the baseline reset only at a disconnect. The translator (per-session wipe, `session.changed`) and the replay recorder (baseline reset) each read it from a baseline of their own (`readSessionIdentity`, then `advanceSessionIdentity`), so both change on the same ticks. A change to the rule is made there, never in one subscriber.

## The tick order (#1499, #1468)

`src/tick-order.ts` lists every stage that can publish, in the order its publishes reach the bus, in three tables. `TICK_ORDER` is the translator's `handleTick`: the direct publishes first (the session-change sites, the pre-guard diffs, the replay-entry teardown), then the `pending` batch the live diffs fill, flushed in call order. `REPLAY_RECORDER_ORDER` is the replay recorder's tick, its four diffs publishing directly. The controller notifies in subscription order, so a tick's `replay.*` events reach the bus after all of the translator's; `CONTROLLER_TICK_ORDER` is the two end to end, the table an `endsOn` check reads. `findEndsOnOrderViolations` reads it to prove an `endsOn` contract's trigger is never published after its end on one tick (#1407); `race-engineer-wiring`'s `ends-on-order.test.ts` applies it to every registered contract. `tick-order.test.ts` proves the tables are the code by spying on the real diff calls, the publishes and the subscriber boundaries. Keeping them true:

- **A diff module that emits declares what.** It exports `<NAME>_EVENTS` (`as const satisfies readonly SimEventName[]`) and types its emitter `EmitFn<(typeof <NAME>_EVENTS)[number]>`. `EmitFn` has no default, so an emit the list does not name is a compile error; a module with two emitting functions declares one list each (`START_COUNTDOWN_EVENTS`, `START_LIGHTS_EVENTS`).
- **A new emitting diff, or one that starts emitting,** gets its row at its call position in the table of the subscriber that calls it — `TICK_ORDER` (`via: "pending"` for a live diff, `"direct"` for a pre-guard one) or `REPLAY_RECORDER_ORDER` (`"direct"`), never both — whose `events` is the module's list itself rather than a copy, and a `vi.mock` spy line in `tick-order.test.ts` naming the index of its emitter argument. The completeness test fails on a declared list with no row, and the call-order test on a stage it never recorded. A diff that publishes nothing gets no row.
- **Reordering any diff call in either subscriber** means moving its row too; the call-order test fails until it does. If an `endsOn` pair then fails in the wiring test, the reorder broke that contract: put the trigger's stage back ahead of its end's.
- **A new publish site in `translator.ts` itself** gets a `source: "translator.ts"` row and a real tick that publishes from it in the translator-sites test; the completeness test fails on an event those sites name that no such row lists. `replay-recorder.ts` publishes from one site, `publish`, and the same test fails on a second.

## Rules

- A new bus event needs an entry in the scenario harness's `src/event-names.ts`, and a new callout a shortcut button there (`packages/scenario-harness/CLAUDE.md`).
- Captured telemetry fixtures for the diff tests live in `src/diff/__fixtures__/` (see its `README.md`).
