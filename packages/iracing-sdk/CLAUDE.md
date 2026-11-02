# @iracedeck/iracing-sdk

The TypeScript layer over the native iRacing SDK (`@iracedeck/iracing-native`). The API reference is in `README.md`.

## What it holds

- `SDKController` — the telemetry poll, every 10 ms (`TELEMETRY_INTERVAL_MS`), deduped on `SessionTick` so subscribers see each tick once. How it delivers is below.
- Session-YAML parsing (`session-yaml.ts`, `session-utils.ts`).
- `createSDK` / `createCommands` (`factory.ts`) — the `Commands` broadcast surface behind `@iracedeck/deck-iracing`'s `getCommands()`.
- The template resolver (`template-resolver.ts`, `template-context.ts`) for key titles.
- Flag, position, grid and track utilities (`flag-utils.ts`, `penalty-flag-utils.ts`, `position-utils.ts`, `grid-utils.ts`, `track-utils.ts`, and the gap, wind and iRating helpers beside them).

## Delivery to subscribers (#1558)

Every subscriber call runs inside one error boundary, `@iracedeck/logger`'s `createErrorBoundary`, so a subscriber's throw never leaves the controller and never stops another subscriber. The subscriber map is iterated in one private method, `notifySubscribers`, in subscription order (the Elgato extension relies on the translator subscribing first), and `subscribe()`'s immediate first notification runs inside the same boundary under the subscriber's id. A subscriber that throws stays subscribed and is called on the next tick; one that batches its work and publishes at the end loses that tick's output, which is its own business. `unsubscribe(id)` flushes the id's unreported error counts as one `warn` line and drops them, since action context ids come and go.

- **Reporting** is the boundary's bounded reporter (`createBoundedErrorReporter`), keyed on the id and the throw's first stack frame: one `error` line with the stack for a key's first throw, a `warn` count at most once per 60 s while it keeps throwing, one `info` recovery line once the id has been quiet for 60 s, and caps of 4 keys per id and 32 in all.
- **The controller's own work** runs in the same boundary under ids no subscriber takes: `controller:update` (the poll), `controller:reconnect` (every connect attempt: the first one in `start()`, the reconnect poll, `setReconnectEnabled(true)`) and `controller:disconnect` (the fan-out when iRacing terminates). A subscriber's throw inside that work is reported once, under the subscriber's id, never again under the `controller:` one.
- **`start()` creates both intervals before its first connect attempt.** That attempt delivers to subscribers, and `start()` runs only for the first subscriber, so a throw there must never leave the controller without its loops.
- **The policy is injected, never read from the environment:** `onSubscriberError` (`ErrorPolicy`, `"report" | "rethrow"`, from `@iracedeck/logger`), passed through `createSDK`'s options or `SDKControllerOptions`. `"report"`, the default, is what every plugin build runs. Under `"rethrow"` delivery still reaches every subscriber, then the first error is thrown out of the entry point that delivered (a timer callback, `subscribe`, `setReconnectEnabled`) and nothing is reported; the controller's own tests choose it where they want loudness. A subscriber's own tests call its callback directly.

`@iracedeck/scenario-harness`' `MockSDKController` delivers through the same boundary, and `@iracedeck/deck-core`'s `SimConnection.subscribe` states this isolation as the contract every sim connection honours. Spec: `docs/superpowers/specs/2026-10-31-issue-1558-sdk-subscriber-isolation.md`.

## Readers

`@iracedeck/sim-events-iracing` is the bus's only translator, but not the only reader: actions read the controller directly through `deck-iracing`'s `SimIRacingAction`, and part of the `audio-scenarios` catalog reads raw telemetry through the translator's `getLatestTelemetry()`, handed to it as a dependency by `race-engineer-wiring` (#1378), and calls this package's telemetry helpers on it. For the live race order use the translator's `getLiveRacePositions` / `getLivePosition`, not this package's position utilities directly (`.claude/rules/race-positions.md`).
