# A subscriber's failure stays with that subscriber

> **Issue:** [#1558](https://github.com/niklam/iracedeck/issues/1558) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `97e315452`. Line numbers are `packages/iracing-sdk/src/SDKController.ts` unless named otherwise.

## The problem

`SDKController` polls the SDK every 10 ms (`TELEMETRY_INTERVAL_MS`, :34) and delivers each new `SessionTick` to every subscriber, so delivery runs at about 60 Hz (:266-272). The comment at :146 that calls the poll "60 Hz" is stale. Nothing between the controller and a subscriber catches. A throw in one subscriber skips every subscriber after it and escapes the timer callback as an uncaught exception. The repository installs no `uncaughtException` handler. According to #1468's reading of `@elgato/streamdeck`, the Stream Deck SDK logs the first uncaught exception and the second ends the plugin process. On Mirabox and Ulanzi the first one ends it.

One path is worse than a crash. The first `subscribe()` calls `start()` (:100), and `start()` calls `tryConnect()` (:128) before it creates either interval (:131, :148). A subscriber that throws on that connect-time delivery aborts `start()` before any loop exists. `start()` runs only when the map size is 1, so the controller then never polls or reconnects again for the life of the process.

No such crash has been reported; #1468 found the gap by reading the code.

### Every place a subscriber is called

- `subscribe()`'s immediate first notification, :108.
- `notifySubscribers`, :287, reached from:
  - `tryConnect` :205, which is called from `start()` :128, the reconnect interval :142 and `setReconnectEnabled(true)` :325;
  - `update()`'s disconnect fan-out, :234;
  - the `lastValidTelemetry` re-delivery, :248;
  - the normal tick, :277;
  - `setReconnectEnabled(false)`'s disconnect fan-out, :321, which runs off an app-monitor event rather than a timer (app-monitor.ts:224-236 already wraps it for that reason).

## Decision

**An error boundary around every subscriber call, built once and used by every dispatcher.** Niklas agreed the shape on 2026-10-31 ("This makes sense"); the architect's review the same day refined the reporting and the seam.

1. **One delivery path.** The subscriber map is iterated in exactly one private method, and `subscribe()`'s first notification goes through the same per-call `deliver(id, callback, data, connected)`. That method runs the callback inside `try`/`catch`, hands a throw to the reporter (4), and continues with the next subscriber in subscription order. Subscription order stays: the Elgato extension relies on the translator subscribing first. Nothing escapes the controller.
2. **The controller's own loops are bounded, and `start()` cannot be left half-done.** `start()` creates both intervals before its first `tryConnect()`. The poll interval's `update()` and the reconnect interval's body each run inside the same boundary, reported under `controller:update` and `controller:reconnect`. The `controller:` prefix keeps them apart from any subscriber id.
3. **A failing subscriber stays subscribed.** It is called on the next tick like any other. What this promises is that the controller and the other subscribers carry on. It does not promise that the failing subscriber loses nothing: one that batches its work and publishes at the end loses that tick's output. The translator does this (`handleTick` collects into `pending` and publishes at the end, translator.ts:2650-3056, after its diffs have already moved their state on), so a throw part-way through loses those events for good rather than delaying them. How a subscriber protects its own work is its own business (Out of scope). Unsubscribing after a failure would switch a feature off for the session over one bad frame, and a re-subscribe policy would be a second state machine with nothing to justify it.
4. **Reporting is bounded, and lives in `@iracedeck/logger`.** It is a small `createBoundedErrorReporter({ logger, now, ... })`, so a second sim's controller and the scenario harness's `MockSDKController` use the same one rather than re-inventing it. `iracing-sdk` already depends on `@iracedeck/logger`, so no new edge is added to the dependency graph. The rules:
   - **Key:** `(id, where it threw)`. "Where" is the first stack frame of the error. When there is no stack, it is the error's name plus its message with digits normalised. A message that carries data ("index 37 out of range") is then one key, not one per tick.
   - **First occurrence of a key:** one `error` line with the stack, through the logger the controller was given.
   - **Repeats:** counted, not logged. One `warn` line per key every 60 s while the key keeps throwing, saying how many times it threw since the last line.
   - **Recovery:** declared only after a quiet window. Once an id has thrown nothing for 60 s, one `info` line says it recovered and how many times it threw in all, and its keys are forgotten. Until then, a throw after a clean call is a repeat. A subscriber that fails on alternate ticks (a car present on one tick and gone the next) therefore writes one `error` line, not 30 a second.
   - **Caps:** at most 4 keys per id and 32 in all. A new key past either cap is counted under that id's overflow, and one `warn` line says the cap was reached. A noisy subscriber therefore cannot hide another subscriber's first error.
   - **`unsubscribe(id)`** flushes that id's pending counts as a final `warn` line and drops its keys. Action ids change with every profile or page switch (`ev.action.id`, the context ids), so dead ids must not fill the table.
   - **Time** is the injected `now`, `Date.now()` by default, so fake timers drive the window in tests.
5. **The failure policy is injected, never read from the environment.** `SDKController` takes `onSubscriberError: ErrorPolicy` through `createSDK`'s existing options object (as it already takes `beforeKeystrokes`), with `"report"` as the default. `ErrorPolicy` (`"report" | "rethrow"`) is exported from `@iracedeck/logger` beside the reporter, so #1559's translator and a second sim's dispatchers name the same type. Under `"rethrow"`, delivery still reaches every subscriber, then re-throws the first error after the loop. The controller's own tests choose that policy where they want loudness. Production code does not check for the test runner, and none does today. Plugin builds, development and release alike, run `"report"`, since a crash costs the driver the whole plugin. Loudness for a subscriber's own bugs belongs in that subscriber's tests, which call its callback directly.
6. **The guarantee is written on the seam.** `SimConnection.subscribe` (deck-core `sim-connection.ts:21`) documents that a subscriber's throw never reaches the caller and never stops another subscriber, so every `deck-<sim>` connection must honour it. The comment in `initializeSimConnection` (`sim-connection.ts:80-99`) that says iRacing's connection throws from `subscribe` is rewritten. Its aggregation stays, as a defence against a connection that breaks the contract. `MockSDKController` (`scenario-harness/src/mock-sdk-controller.ts:126-131`, 214-226) delivers through the same boundary and reporter, so it keeps mirroring the real controller.

### What goes stale, and is updated in this change

- The "it iterates subscribers unguarded" comment in `elevation-check.ts`. That subscriber sets `checked = true` before calling `setWarning` or `clearWarning`, so a throw there skips the check for that connection. Moving the flag after the call is part of this change.
- The wrap in app-monitor.ts:224-236, the catch at SDKController.ts:324-328 and the comment at :146.
- #1468's recorder catch (`replay-recorder.ts:167-177`, "if that first tick throws … take it back out"), which this change makes unreachable. Whichever of #1468 and #1558 merges second removes it.
- `packages/iracing-sdk/CLAUDE.md`, `packages/deck-core/CLAUDE.md` where it describes `SimConnection`, and `packages/scenario-harness/CLAUDE.md` where it describes the mock controller.

## Approaches weighed and rejected

- **Each subscriber guards its own callback.** It works only where someone remembers to add it, and the next subscriber written won't. The dispatcher is the one place that covers them all.
- **Unsubscribing a subscriber after N consecutive failures.** It turns a data glitch into a feature that is off until restart, and N is a guess.
- **Recovery after one clean call** (the first draft). Under alternating failures it logs a full stack about every other tick.
- **Keying on the message and one global cap** (the first draft). Messages carry data, so one subscriber fills the table in under a second and hides the next subscriber's first error.
- **A process-level `uncaughtException` handler.** It hides errors from every other code path, and still loses the rest of the tick.
- **Worker threads or a process per subscriber.** Far heavier than the problem: subscribers share in-process state and run in microseconds.
- **Re-throwing when `process.env.VITEST` is set** (the first draft). Only `SDKController.test.ts` builds a real controller; every other test mocks the SDK. Existing catches swallow the throw anyway, and it would bring a test-runner check into production code. The injected policy does the same job where it is wanted.
- **The reporter private to `iracing-sdk`.** A second sim's controller and the harness mock would each grow their own.

## Out of scope

- Isolation inside a subscriber: between the translator's diff modules, or whether a batching subscriber publishes the events of the diffs that completed before one threw. A follow-up issue is proposed for the translator.
- The event bus's handler isolation (`event-bus.ts:63-79`), which already catches but logs every throw without a limit. Adopting the reporter there is a follow-up issue, proposed separately.
- Errors inside the iRacing native addon.
- An `uncaughtException` handler for the plugin process.
- Showing subscriber errors to the user as a warning banner. A later issue can add one if the log shows these errors happen.

## Testing

- **The reporter, in `@iracedeck/logger`**, with a fake clock:
  - first occurrence writes one `error` line; repeats write nothing; one `warn` summary per 60 s with the right count;
  - alternating throw and clean calls write one `error` line and no `info` line until 60 s pass with no throw, then one `info` line;
  - a message differing only in its digits is the same key; two throw sites are two keys;
  - the per-id cap and the global cap: a noisy id that hits its cap does not stop a second id's first error being logged;
  - `forget(id)` flushes a pending count as one `warn` line and frees that id's keys.
- **The controller, in `iracing-sdk`**, with a fake SDK and fake timers:
  - three subscribers, the middle one throwing, on each entry point listed under *Every place a subscriber is called*: the first and third still get the call, in order;
  - the first subscriber throws on the connect-time delivery inside `start()`: both intervals exist afterwards and the next poll runs;
  - a throw from `update()` itself is reported as `controller:update`, and the next interval runs;
  - `unsubscribe` of a failing id flushes and drops it;
  - under `"rethrow"`, every subscriber is called and then the first error is thrown; under the default, nothing is thrown.
- **The harness mock** delivers through the same boundary: one test in `scenario-harness` with a throwing subscriber.
- **The elevation check** runs its check again on the next connection after a `setWarning` throw.
- **Positive controls:** with the `try`/`catch` removed from `deliver`, the "middle subscriber throws" test fails. With `start()`'s original order restored, the connect-delivery test fails. Record both in the PR.
- **Manual:** none. Nothing is visible unless a subscriber has a bug. The PR shows the log lines from a test that throws on purpose.
