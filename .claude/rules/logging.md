---
paths:
  - "packages/*/src/**"
---

# Logging Conventions

## Overview

Stream Deck plugins use a scoped logging system built on the Stream Deck SDK's logger. The `createSDLogger` adapter in `@iracedeck/deck-adapter-elgato` wraps the SDK logger to provide an `ILogger`-compatible interface. Actions receive their logger via constructor injection from the platform adapter.

## Core Concepts

### Logger Scopes

Scopes create hierarchical log prefixes automatically. Use `createScope()` to create loggers for specific modules or components:

```typescript
// Creates logs prefixed with scope name automatically
const logger = streamDeck.logger.createScope("iRacingSDK");
logger.info("Connected"); // Output: [iRacingSDK] Connected
```

### The createSDLogger Adapter

`createSDLogger` (from `@iracedeck/deck-adapter-elgato`) wraps a Stream Deck logger to provide:
- `ILogger` interface compatibility (for use with `@iracedeck/logger`)
- Log level filtering
- Scope chaining via `createScope()`

The `ElgatoPlatformAdapter` exposes `createLogger(scope)` which wraps `createSDLogger` internally:

```typescript
// In plugin.ts — use adapter.createLogger() for scoped loggers
const logger = adapter.createLogger("MyModule");
logger.info("Hello"); // Uses proper scope prefix
```

Actions receive their logger via constructor injection:
```typescript
// plugin.ts
adapter.registerAction(MY_ACTION_UUID, new MyAction(adapter.createLogger("MyAction")));
```

## Correct Patterns

### Plugin Initialization

Create scoped loggers in `plugin.ts` via the platform adapter and pass them to modules that need logging:

```typescript
// plugin.ts
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { initializeSDK, initializeKeyboard } from "@iracedeck/deck-core";

const adapter = new ElgatoPlatformAdapter(streamDeck);

// Good: Create scoped logger via adapter and pass to module
initializeSDK(adapter.createLogger("iRacingSDK"));
initializeKeyboard(adapter.createLogger("Keyboard"), ...);
```

### Module Design

Modules that need logging should accept a logger parameter:

```typescript
// my-module.ts
import { ILogger } from "@iracedeck/logger";

let logger: ILogger | null = null;

export function initMyModule(log: ILogger): void {
  logger = log;
  logger.info("Module initialized");
}

function doSomething(): void {
  logger?.debug("Doing something");
}
```

### Creating Sub-Scopes

Use `createScope()` on an existing logger to create nested scopes:

```typescript
function processItem(baseLogger: ILogger, itemId: string): void {
  const logger = baseLogger.createScope(`Item:${itemId}`);
  logger.info("Processing started");
  // Output: [ParentScope] [Item:123] Processing started
}
```

## Anti-Patterns

### Do NOT Use String Prefixes

**Bad:** Manual string prefixes bypass the scope system and create inconsistent formatting:

```typescript
// BAD: String prefix anti-pattern
sd.logger.info("[GlobalSettings] initGlobalSettings called");
sd.logger.warn("[AppMonitor] Already initialized");
```

**Good:** Accept a scoped logger parameter:

```typescript
// GOOD: Use scoped logger
export function initGlobalSettings(adapter: IDeckPlatformAdapter, logger: ILogger, store: SettingsStore): void {
  logger.info("initGlobalSettings called");
}

// In plugin.ts
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore);
```

### Do NOT Use SDK Logger Directly in Modules

**Bad:** Using `sd.logger` directly in shared modules:

```typescript
// BAD: Direct SDK logger usage
export function initAppMonitor(adapter: IDeckPlatformAdapter): void {
  // No way to log here!
}
```

**Good:** Accept an ILogger parameter:

```typescript
// GOOD: Accept logger parameter
export function initAppMonitor(adapter: IDeckPlatformAdapter, logger: ILogger): void {
  logger.info("Initializing...");
}
```

## Log Levels

Use appropriate log levels:

| Level | Usage |
|-------|-------|
| `trace` | Very detailed debugging, method entry/exit |
| `debug` | Debugging information, state changes, parameter values |
| `info` | Normal operational events (no parameters) |
| `warn` | Unexpected but recoverable situations |
| `error` | Errors that affect functionality |

## Best Practices

### Log All Major Events at Info Level

Every significant event must have an info-level log entry. Major events include:
- Module/component initialization
- Connection state changes (connected, disconnected)
- User actions triggered (button pressed, dial rotated)
- Configuration changes
- Feature enabled/disabled

### Info Level: Event Only, No Parameters

Info-level logs should indicate **what happened**, not the details. Keep them concise and parameter-free:

```typescript
// GOOD: Info level - just the event
logger.info("Global settings updated");
logger.info("iRacing connected");
logger.info("Black box selector triggered");

// BAD: Info level with parameters (use debug instead)
logger.info(`Global settings updated: ${JSON.stringify(settings)}`);
logger.info(`Connected to iRacing session ${sessionId}`);
```

### Debug Level: Include Parameters and Details

Use debug level when you need to log values, parameters, or state details:

```typescript
// Debug level - include the details
logger.debug(`Settings received: ${JSON.stringify(settings)}`);
logger.debug(`Processing action with mode=${mode}, target=${target}`);
logger.debug(`Key combination: ${key} with modifiers [${modifiers.join(", ")}]`);
```

### Pattern: Info + Debug Together

For important events where details may be needed for debugging:

```typescript
logger.info("Global settings updated");
logger.debug(`New settings: ${JSON.stringify(settings)}`);

logger.info("Action triggered");
logger.debug(`Action settings: mode=${settings.mode}, key=${settings.keyBinding?.key}`);
```

This allows production logs (info level) to show what happened, while debug logs provide the detail needed for troubleshooting.

## Changing Log Levels

Use `withLevel()` to create a logger with a different minimum level:

```typescript
const verboseLogger = logger.withLevel(LogLevel.Trace);
const quietLogger = logger.withLevel(LogLevel.Warn);
```

## Default Log Level & Debug Toggle

Production defaults to **`info`** (issue #609). Debug logging is opt-in for troubleshooting — it must not be the default, because it bloats the `.log`, leaks internal detail, and buries real signal during support.

- **Global setting:** `debugLogging` (boolean, default `false`) in `GlobalSettingsSchema`. Persists across restarts.
- **Where users flip it:** the "Enable debug logging" checkbox on the settings window's Diagnostics tab (shared partial `global-common-diagnostics.ejs`). Since #1003 it is not in any action Property Inspector — when a support thread says "turn on debug logging", point the user at the **iRaceDeck Settings** button, which sits directly under any action's own settings (#1024).
- **Elgato:** `streamDeck.logger.setLevel(...)` is the single file-writer gate and is runtime-mutable. It takes a level string (`"info"` / `"debug"`), not the `@iracedeck/logger` enum. `plugin.ts` applies `settings.debugLogging ? "debug" : "info"` after init and re-applies on every `onGlobalSettingsChange`. The scoped-logger wrapper (`createSDLogger`) keeps forwarding debug so a runtime flip surfaces scoped debug logs without recreating loggers — gate at the `streamDeck.logger` layer only, not in the wrapper.
- **Elgato debug mode stays off (#1330).** The manifest's `Nodejs` block carries no `Debug` key. `Debug` is not an on/off switch: it holds extra Node command-line arguments that Stream Deck applies whenever developer mode is on, with `"enabled"` and `"break"` as shorthands for `--inspect` and `--inspect-brk`. Any other value is passed to Node verbatim — `"disabled"` made Node try to run a script named `disabled`, so the plugin exited with code 1 on every start until Stream Deck disabled it as unstable. With `"enabled"`, Stream Deck starts the plugin with `--inspect`, and `@elgato/streamdeck` then puts a `ConsoleTarget` in front of the `FileTarget`, so every line is first written to stdout or stderr. Both are pipes owned by the Stream Deck app, which keeps none of that output, and Node on Windows writes to a pipe synchronously: should the host stop reading, the next log call blocks the main thread for good. That is a suspect in the connect-time freezes of #1330. The file under `<sdPlugin>/logs/` is unaffected. To attach DevTools, run `pnpm debug:plugin on` (#1338): it adds `"Debug": "--inspect=127.0.0.1:9229"` to your working copy as a one-line text edit, the plugin picks it up at its next start (developer mode only), and `chrome://inspect` attaches on the fixed port; `pnpm debug:plugin off` restores the file byte for byte, and `status` says which state it is in. Three guards keep the key out of a release: the pre-bash hook refuses a commit that would record it, `scripts/manifest-no-debug.test.mjs` fails CI when HEAD's manifest carries it (it reads the committed copy, so a local `on` keeps the suite green), and `assert-release-build` refuses to pack it. For a profile from a user's machine, use **Capture CPU profile** below instead — it needs no developer mode and no port.
- **Mirabox:** `createConsoleLogger` captures its level at creation, so the adapter holds a shared mutable level (`VSDPlatformAdapter.setLogLevel`) that loggers read live via a resolver (`createConsoleLogger(scope, () => this.logLevel)`). `plugin.ts` calls `adapter.setLogLevel(debugLogging ? LogLevel.Debug : LogLevel.Info)` after init and on every change — live, no restart.
- **Mirabox file logging:** the Stream Dock host does **not** capture plugin stdout, so console output alone leaves the toggle with nothing to attach for support. The adapter therefore tees every logger to `<plugin>/log/<YYYY.M.D>.log` (`FileSink` + `withFileSink` in `deck-adapter-mirabox`), matching the host's own `log/` convention (unpadded month/day, e.g. `2026.5.31.log`). The plugin passes the directory as `new VSDPlatformAdapter(undefined, join(__binDir, "..", "log"))`. File writes share the same live level gate, so flipping `debugLogging` controls the file too. (Elgato needs no equivalent — `streamDeck.logger` already writes `<sdPlugin>/logs/`.)
- **Log retention (issue #904):** both `FileSink`s (Mirabox and Ulanzi — deliberate near-duplicates, keep them in sync) prune per-day files older than `LOG_RETENTION_DAYS` (14) on the first write of each plugin run. Only names matching the exact `<YYYY.M.D>.log` pattern are deleted, the date comparison is date-only (a file exactly 14 days old survives the whole day), and prune failures are swallowed like write failures. The packed plugins never ship logs regardless: every plugin folder's `.sdignore` excludes `log/`, `logs/`, and `*.log` (the three files are kept byte-identical).
- **Main-thread watchdog (issue #1330):** every plugin starts `startMainThreadWatchdog` from deck-core right after its debug-logging toggle is applied. When the main thread stops answering a 500 ms heartbeat for 5 s, a worker thread pauses it through the inspector. A pause that lands within 250 ms writes `ERROR MainThreadWatchdog: main thread blocked for <n> s in JavaScript` followed by the call frames. One that lands later, or not at all within 2 s, writes `... in native code`, and then `main thread resumed after <n> s; the pause landed at:` with the frames once the thread returns. Recovery writes `WARN MainThreadWatchdog: main thread responsive again after <n> s`. These lines are not gated on `debugLogging`, nothing is written while the thread is healthy, and a sleep/resume of the PC is not a stall (the worker restarts its clock after a gap in its own samples). They bypass the logger: a frozen main thread blocks every logger, and a worker's `console` is relayed through that same thread, so the worker appends with `fs.appendFileSync` straight to the host's file — Elgato's `<cwd>/logs/<plugin UUID>.0.log` (`elgatoPluginLogFile()` in the Elgato adapter, tested against the SDK), and the Mirabox and Ulanzi `<plugin>/log/<YYYY.M.D>.log` their `FileSink` writes (each adapter's `file-logger.test.ts` checks the name against the watchdog's `watchdogDailyLogFileName`). Two main-thread WARNs come through the normal logger instead: `Main-thread watchdog cannot tell where a stall is stuck, only that it happened: <reason>` when the worker finds the inspector unusable (stalls are then reported without frames), and `Main-thread watchdog stopped: <reason>` when the worker dies, which also stops the heartbeat. If the log path or file-name scheme of a host changes, change the target its `plugin.ts` passes in the same change.
- **Resource monitor (issue #1338):** every plugin starts deck-core's resource monitor right after the watchdog. Once a minute it samples the process's own CPU (a share of one core), event-loop utilisation and memory. Three consecutive samples at or above 50 % of a core, or 0.5 event-loop utilisation, write one `WARN Plugin CPU use is high: <n>% of one core, event loop <m>% busy, …` that carries the numbers — the one place a support log needs them, which is why that line is a warn rather than an info. The first sample below both thresholds writes `INFO Plugin CPU use back to normal` and re-arms. It also takes a short extra sample at each session edge — on app-monitor's `onIRacingStarted` (the first of the launch event or the SDK connection, once per session) and on `onIRacingTerminated` — so every interval lies wholly inside or outside a session; an edge sample counts towards the session but neither extends nor breaks a run of high minutes. Each iRacing session ends with `INFO Resource summary for the iRacing session`, its figures at debug (the CPU average weighted by time); every sample is a debug `Resources: …` line. None of it is gated on `debugLogging`. Thresholds and the three-sample rule live in the module's pure reducer, which the tests drive.
- **CPU profile capture (issue #1338):** the settings window's Diagnostics card has **Capture CPU profile**, which records 30 s of the main thread through an in-process `inspector.Session` (no `--inspect`, no developer mode) and writes `cpu-<time>.cpuprofile` plus a `.txt` top-30 summary to a `profiles` folder inside the host's log directory, keeping the newest five pairs. It logs `INFO CPU profile capture started` / `CPU profile saved` (path at debug) and `WARN CPU profile capture failed: <reason>`. Its state is the run-scoped `_profileCaptureStatus` (see `global-settings.md`). This is the tool to ask a user for when a report says the plugin is slow — the `.txt` is readable in a chat, the `.cpuprofile` opens in Chrome DevTools.

When changing how logging is gated, keep both plugins and the shared PI partial in sync.

## Summary

1. Always use `createScope()` to create named logger scopes
2. Pass loggers as parameters to modules (dependency injection)
3. Never use manual string prefixes like `[ModuleName]`
4. Never use `sd.logger` directly in shared modules
5. Use `createSDLogger()` from `@iracedeck/deck-adapter-elgato` (or `adapter.createLogger()`) to wrap SDK loggers for ILogger compatibility
