/**
 * Stream Deck Logger Adapter
 *
 * Creates an ILogger-compatible wrapper around Stream Deck's logger.
 */
import { ILogger, LogLevel } from "@iracedeck/iracing-sdk";

/**
 * Minimal interface for Stream Deck logger methods we use.
 * This allows testing without the full Stream Deck SDK dependency.
 */
export interface SDLoggerLike {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  createScope(scope: string): SDLoggerLike;
}

/**
 * Creates an ILogger-compatible wrapper around a Stream Deck logger.
 *
 * @param sdLogger - The Stream Deck logger instance
 * @param level - The minimum log level to output (defaults to Info)
 * @returns An ILogger instance that delegates to the Stream Deck logger
 */
export function createSDLogger(sdLogger: SDLoggerLike, level: LogLevel = LogLevel.Info): ILogger {
  return {
    trace: (msg: string) => {
      if (level <= LogLevel.Trace) sdLogger.trace(msg);
    },
    debug: (msg: string) => {
      if (level <= LogLevel.Debug) sdLogger.debug(msg);
    },
    info: (msg: string) => {
      if (level <= LogLevel.Info) sdLogger.info(msg);
    },
    warn: (msg: string) => {
      if (level <= LogLevel.Warn) sdLogger.warn(msg);
    },
    error: (msg: string) => {
      if (level <= LogLevel.Error) sdLogger.error(msg);
    },
    withLevel: (newLevel: LogLevel) => createSDLogger(sdLogger, newLevel),
    createScope: (scope: string) => createSDLogger(sdLogger.createScope(scope), level),
  };
}
