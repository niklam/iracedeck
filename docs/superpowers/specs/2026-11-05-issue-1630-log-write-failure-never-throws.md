# A failed log write never throws out of a logger call

> **Issue:** [#1630](https://github.com/niklam/iracedeck/issues/1630) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

On Elgato every iRaceDeck log line goes `ILogger` → `createSDLogger` (`deck-adapter-elgato/src/sd-logger.ts`) → the SDK's `Logger.write` → `@elgato/utils`' `FileTarget.write`. That last call does `openSync` / `writeSync` / `closeSync` with no `catch`, and nothing above it catches either. So `ENOSPC`, or any other write error, comes back out of `logger.info(…)` as an exception. The SDK's own `process.once("uncaughtException", …)` handler logs through the same target and throws again, which ends the process. The 2026-11-05 user log shows the result: the plugin died mid-session once the disk filled, then died again 6 lines into its restart.

Mirabox and Ulanzi are not affected: their `FileSink`s catch write failures, and so does the main-thread watchdog's direct `appendFileSync`.

## Decision

**Guard at our wrapper.** `createSDLogger` wraps each forwarded call (`trace`, `debug`, `info`, `warn`, `error`) in `try` / `catch` and never rethrows. One guard covers every line iRaceDeck writes on Elgato, since `ElgatoPlatformAdapter.createLogger` is the only way our code reaches `streamDeck.logger` (no package calls `streamDeck.logger.<level>(…)` directly).

**Shared failure state, one per root.** The adapter creates one `LogWriteFailures` record (dropped-line count, first failure's reason) and hands it to the root `createSDLogger`. `createScope` and `withLevel` pass the same record on, so a failure in one scope and a recovery in another are counted together. A module-level singleton was rejected: tests would leak state between cases, and the record has an obvious owner.

**Say what was lost once writing works again.** While writes fail, each dropped line increments the count, and the first failure's reason is kept: its `code` (`ENOSPC`, `EACCES`, …), else its message. On the next call the SD logger's own level would write (read from its `level` getter; the wrapper's gate is Debug by design, so a debug line the SDK drops never touches the file and must not retry or count), the wrapper first writes `WARN Log writes failed; <n> lines were dropped (first failure: <reason>)` through the same SD logger, then the line itself. Only once that notice lands is the record reset. If the notice fails, the line is not attempted; it counts as dropped and the count carries over. The notice is a `warn` because it reports lost data, and a support log must show it at the default `info` level. While the SDK filters `warn` (level `error` or `silent`) the notice cannot land, so it waits and the record is kept.

**Nothing goes anywhere else.** No `console` fallback: nobody reads the plugin's stdout, and a blocked console pipe was a freeze suspect in #1330. No retry loop, no buffering of dropped lines: a full disk can last the whole session, and holding lines in memory trades the crash for growth.

**The SDK's own lines stay unguarded here; report them upstream.** In production (`minimumLevel` debug, so no trace output) the SDK writes at `info` and above only in error paths: `connection.js` (an unknown or unparseable message), `i18n.js` (a failed translation load) and its `uncaughtException` handler. All three are failures in themselves. Once our wrapper stops throwing, the uncaught-exception handler is no longer reached by a log write. The unguarded `FileTarget.write` is reported to Elgato; we don't patch the SDK.

## Alternatives rejected

- **A pnpm patch of `@elgato/utils`' `FileTarget.write`.** It would cover the SDK's lines too. But it is a patch to maintain across every SDK bump, for three error-path lines that the wrapper guard already takes out of the crash path.
- **A process-level `uncaughtException` / `unhandledRejection` handler that keeps the process alive.** Carrying on after an arbitrary uncaught exception leaves state undefined. This issue removes the one cause seen in the field; whether the plugin should ever survive an uncaught exception is a separate decision.
- **Guarding at each call site** (the replay store's `logger.error`, the startup phases). There are hundreds of call sites, and a guard every caller has to remember is one the next caller forgets.
- **Changing `ILogger`'s contract in `@iracedeck/logger` to "may throw".** The contract every consumer already assumes is that logging never fails. The Elgato wrapper is the one implementation that breaks it.

## Out of scope

- What fills a user's disk, and any free-space check or warning banner.
- The Mirabox and Ulanzi `FileSink`s, which already swallow write failures and which #1375 is merging into one.
- The replay store's behaviour under `ENOSPC`, which already logs, keeps the record in memory and retries.
- A process-wide crash handler (above).

## Testing

- Unit, `deck-adapter-elgato`: an SD-logger double whose methods throw (`Object.assign(new Error("no space left on device"), { code: "ENOSPC" })`):
  - No level throws through the wrapper, including through `createScope(…)` and `withLevel(…)`.
  - After three failed lines in two different scopes and a recovery, exactly one `warn` reads `3 lines were dropped (first failure: ENOSPC)` and comes before the recovering line. A further line writes no second notice.
  - A line filtered out by the wrapper's level gate is not counted.
  - A failing notice leaves the count in place (it grows by the line that was not attempted) and is retried on the next call.
- Manual, on a real Stream Deck. No full disk is needed: any write failure goes down the same path. While the plugin runs, make its log file read-only (`attrib +r <plugin>/logs/com.iracedeck.sd.core.0.log`). Press a key that logs a line and check that the plugin stays alive and the keys keep working. Clear the attribute (`attrib -r …`), press again, and check that a `Log writes failed; <n> lines were dropped (first failure: EPERM)` line (or `EACCES`, whichever Windows reports) comes before the key's line.
