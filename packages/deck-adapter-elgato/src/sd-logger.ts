/**
 * Stream Deck Logger Adapter
 *
 * Creates an ILogger-compatible wrapper around Stream Deck's logger.
 *
 * A failed log write never throws out of the wrapper (#1630). The SDK's
 * `FileTarget.write` does `openSync` / `writeSync` with no `catch`, so a full
 * disk (`ENOSPC`) or any other write error would otherwise come back out of
 * `logger.info(…)` and, uncaught, end the plugin. The wrapper swallows the
 * failure and counts the dropped line; once writing works again it writes one
 * `WARN` naming how many lines were lost and why, before the line that got
 * through. Design record:
 * `docs/superpowers/specs/2026-11-05-issue-1630-log-write-failure-never-throws.md`.
 */
import { defcon, type LogLevel as SDLevelName } from "@elgato/utils/logging";
import { ILogger, LogLevel } from "@iracedeck/logger";

/**
 * Minimal interface for Stream Deck logger methods we use.
 * This allows testing without the full Stream Deck SDK dependency.
 */
export interface SDLoggerLike {
  /**
   * The SDK logger's effective level (`"error"` … `"trace"`). Read only while
   * lines are being dropped, to tell whether a line would really be written;
   * a logger without it is treated as writing every level.
   */
  readonly level?: string;
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  createScope(scope: string): SDLoggerLike;
}

/**
 * Log lines lost to failed writes, shared by a root logger and every scope and
 * `withLevel` logger made from it, so a failure in one scope and the recovery
 * in another are counted together.
 */
export interface LogWriteFailures {
  /** Lines dropped since the last notice landed. */
  dropped: number;
  /** The first failure's error `code` (`ENOSPC`, `EPERM`, …), else its message. */
  firstReason: string | undefined;
}

/** A fresh, empty failure record: one per adapter. */
export function createLogWriteFailures(): LogWriteFailures {
  return { dropped: 0, firstReason: undefined };
}

/**
 * Whether the SDK logger would write a line at `lineLevel`: its own
 * `Logger.write` gate, through its own `defcon` ranking. A missing or unknown
 * level counts as writing everything, as `defcon` ranks it with `trace`.
 */
function sdWrites(sdLogger: SDLoggerLike, lineLevel: SDLevelName): boolean {
  return defcon(lineLevel) <= defcon(sdLogger.level as SDLevelName);
}

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === "string" && code !== "") return code;

    if (error.message !== "") return error.message;
  }

  return String(error);
}

function droppedNotice(failures: LogWriteFailures): string {
  const lines = failures.dropped === 1 ? "1 line was" : `${failures.dropped} lines were`;

  return `Log writes failed; ${lines} dropped (first failure: ${failures.firstReason})`;
}

/**
 * Creates an ILogger-compatible wrapper around a Stream Deck logger.
 *
 * @param sdLogger - The Stream Deck logger instance
 * @param level - The minimum log level to output (defaults to Debug)
 * @param failures - The failure record shared with every logger of the same
 *   root; a root logger gets its own when none is passed
 * @returns An ILogger instance that delegates to the Stream Deck logger and never throws
 */
export function createSDLogger(
  sdLogger: SDLoggerLike,
  level: LogLevel = LogLevel.Debug,
  failures: LogWriteFailures = createLogWriteFailures(),
): ILogger {
  const write = (lineLevel: LogLevel, sdLevel: SDLevelName, msg: string): void => {
    if (level > lineLevel) return;

    // Lines were dropped: say so before the next line that will really be
    // written. A line the SDK filters out touches no file, so it neither
    // attempts the notice nor counts as dropped; and the notice waits while the
    // SDK would filter a warn too, since it could not land.
    if (failures.dropped > 0 && sdWrites(sdLogger, sdLevel) && sdWrites(sdLogger, "warn")) {
      try {
        sdLogger.warn(droppedNotice(failures));
        failures.dropped = 0;
        failures.firstReason = undefined;
      } catch {
        // Still failing: the line is not attempted and counts as dropped.
        failures.dropped += 1;

        return;
      }
    }

    try {
      sdLogger[sdLevel](msg);
    } catch (error) {
      failures.dropped += 1;
      failures.firstReason ??= failureReason(error);
    }
  };

  return {
    trace: (msg: string) => write(LogLevel.Trace, "trace", msg),
    debug: (msg: string) => write(LogLevel.Debug, "debug", msg),
    info: (msg: string) => write(LogLevel.Info, "info", msg),
    warn: (msg: string) => write(LogLevel.Warn, "warn", msg),
    error: (msg: string) => write(LogLevel.Error, "error", msg),
    withLevel: (newLevel: LogLevel) => createSDLogger(sdLogger, newLevel, failures),
    createScope: (scope: string) => createSDLogger(sdLogger.createScope(scope), level, failures),
  };
}
