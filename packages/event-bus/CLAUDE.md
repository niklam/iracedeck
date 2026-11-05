# @iracedeck/event-bus

Typed pub/sub with the canonical sim-event catalog. Sim- and audio-agnostic: the envelope's telemetry field is generic, so the package depends on no simulator SDK; it is in `SIM_NEUTRAL_PACKAGES` in `eslint.config.js`, whose block refuses a sim package import here (#1375).

## Shape

- The singleton trio `initializeEventBus` / `getEventBus` / `isEventBusInitialized` (`src/event-bus.ts`), plus `_resetEventBus` for tests.
- The catalog types (`SimEventMap`, `SimEventName`, `SimEventOf` and the payloads) live in `src/event-catalog.ts` and are re-exported from `src/index.ts`. Publishers and subscribers both index into `SimEventMap` by event name and receive a fully typed envelope. Beside them are the sim-neutral read types a translator answers through a resolver rather than publishes, among them `SessionCategory` (the practice / qualifying / race union every session-typed payload carries) and `SessionClass` (the classified session the Race Engineer reads through `SimRuntime.getSessionClass`, #1587).

## Handler errors (#1560)

A handler that throws never stops another handler for the same event, and never reaches `publish`'s caller. Every handler call runs inside one #1558 `createErrorBoundary` from `@iracedeck/logger`, built per bus in `initializeEventBus`, with a reporter table of its own. Each subscription is reported under its own id, `event-bus:<event name>#<registration number>`, with the handler's function name in parentheses when it has one (`event-bus:radar.changed#7 (handleRadarChanged)`). A throw is one `error` line with the stack for each new throw site of that id; repeats are counted and summarised in one `warn` line a minute; one `info` line declares recovery once the id has thrown nothing for a minute. The failing handler stays subscribed.

- **Ids follow the subscription, not the function.** One function subscribed to two events has two ids; subscribing a handler that is already subscribed to that event is a no-op that keeps its id; unsubscribing and subscribing again gives a new number, so its next throw is logged in full. `unsubscribe` flushes the id's unreported count as one `warn` line and drops its keys, so handlers that come and go do not fill the table.
- **The global cap is `EVENT_BUS_REPORTER_MAX_KEYS`**, four throw sites for each of 64 handlers rather than #1558's default of 32, which was sized for the SDK controller's few subscribers. The table is bounded by the live subscriptions anyway; the cap is the backstop against a subscription leak.
- **The policy and clock are `initializeEventBus` options**, `onHandlerError` (#1558's `ErrorPolicy`, default `"report"`, what every plugin build runs) and `errorClock`. Under `"rethrow"` every handler still runs, then `publish` throws the first error; a test that wants loudness chooses it.

## Rules

- The catalog is a published contract (reviewed at `xhigh`, `.claude/rules/code-review.md`).
- Its publisher is the sim's translator (`@iracedeck/sim-events-iracing` for iRacing); a second sim gets a parallel translator emitting the same catalog. `telemetryReadout.requested` is the exception: the deck layer publishes it.
- Every new event needs an `src/event-names.ts` entry in `@iracedeck/scenario-harness`.
