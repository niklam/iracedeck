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
export function initGlobalSettings(adapter: IDeckPlatformAdapter, logger: ILogger): void {
  logger.info("initGlobalSettings called");
}

// In plugin.ts
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"));
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
- **Property Inspector:** the "Enable debug logging" checkbox in the global "Common Settings" accordion ("Diagnostics" group, shared partial `global-common-settings.ejs`) — so both plugins expose it.
- **Elgato:** `streamDeck.logger.setLevel(...)` is the single file-writer gate and is runtime-mutable. It takes a level string (`"info"` / `"debug"`), not the `@iracedeck/logger` enum. `plugin.ts` applies `settings.debugLogging ? "debug" : "info"` after init and re-applies on every `onGlobalSettingsChange`. The scoped-logger wrapper (`createSDLogger`) keeps forwarding debug so a runtime flip surfaces scoped debug logs without recreating loggers — gate at the `streamDeck.logger` layer only, not in the wrapper.
- **Mirabox:** `createConsoleLogger` captures its level at creation, so the adapter holds a shared mutable level (`VSDPlatformAdapter.setLogLevel`) that loggers read live via a resolver (`createConsoleLogger(scope, () => this.logLevel)`). `plugin.ts` calls `adapter.setLogLevel(debugLogging ? LogLevel.Debug : LogLevel.Info)` after init and on every change — live, no restart.
- **Mirabox file logging:** the Stream Dock host does **not** capture plugin stdout, so console output alone leaves the toggle with nothing to attach for support. The adapter therefore tees every logger to `<plugin>/log/<YYYY.M.D>.log` (`FileSink` + `withFileSink` in `deck-adapter-mirabox`), matching the host's own `log/` convention (unpadded month/day, e.g. `2026.5.31.log`). The plugin passes the directory as `new VSDPlatformAdapter(undefined, join(__binDir, "..", "log"))`. File writes share the same live level gate, so flipping `debugLogging` controls the file too. (Elgato needs no equivalent — `streamDeck.logger` already writes `<sdPlugin>/logs/`.)
- **Log retention (issue #904):** both `FileSink`s (Mirabox and Ulanzi — deliberate near-duplicates, keep them in sync) prune per-day files older than `LOG_RETENTION_DAYS` (14) on the first write of each plugin run. Only names matching the exact `<YYYY.M.D>.log` pattern are deleted, the date comparison is date-only (a file exactly 14 days old survives the whole day), and prune failures are swallowed like write failures. The packed plugins never ship logs regardless: every plugin folder's `.sdignore` excludes `log/`, `logs/`, and `*.log` (the three files are kept byte-identical).

When changing how logging is gated, keep both plugins and the shared PI partial in sync.

## Summary

1. Always use `createScope()` to create named logger scopes
2. Pass loggers as parameters to modules (dependency injection)
3. Never use manual string prefixes like `[ModuleName]`
4. Never use `sd.logger` directly in shared modules
5. Use `createSDLogger()` from `@iracedeck/deck-adapter-elgato` (or `adapter.createLogger()`) to wrap SDK loggers for ILogger compatibility
