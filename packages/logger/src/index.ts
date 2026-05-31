/**
 * @iracedeck/logger
 *
 * Logger interface for iRaceDeck packages.
 * Allows consumers to inject their own logging implementation.
 */

/**
 * Log levels in order of verbosity (most verbose first)
 */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Silent = 5,
}

/**
 * Logger interface - inject implementations for testability
 */
export interface ILogger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  withLevel(level: LogLevel): ILogger;
  createScope(scope: string): ILogger;
}

/**
 * A fixed log level, or a function that resolves the current level on demand.
 *
 * Passing a resolver lets a logger's effective level change at runtime: every
 * log call re-reads it, and child scopes created via `createScope` share the
 * same resolver. The Mirabox adapter uses this so the "Enable debug logging"
 * global setting (issue #609) takes effect on already-created loggers without
 * recreating them.
 */
export type LogLevelSource = LogLevel | (() => LogLevel);

/**
 * Create a console logger whose level may be fixed or resolved live per call.
 */
export function createConsoleLogger(scope?: string, level: LogLevelSource = LogLevel.Info): ILogger {
  const formatMessage = (message: string) => (scope ? `[${scope}] ${message}` : message);
  const currentLevel = (): LogLevel => (typeof level === "function" ? level() : level);

  return {
    trace: (message: string) => {
      if (currentLevel() <= LogLevel.Trace) console.debug(formatMessage(message));
    },
    debug: (message: string) => {
      if (currentLevel() <= LogLevel.Debug) console.debug(formatMessage(message));
    },
    info: (message: string) => {
      if (currentLevel() <= LogLevel.Info) console.info(formatMessage(message));
    },
    warn: (message: string) => {
      if (currentLevel() <= LogLevel.Warn) console.warn(formatMessage(message));
    },
    error: (message: string) => {
      if (currentLevel() <= LogLevel.Error) console.error(formatMessage(message));
    },
    withLevel: (newLevel: LogLevel) => createConsoleLogger(scope, newLevel),
    createScope: (newScope: string) => {
      const childScope = scope ? `${scope}:${newScope}` : newScope;

      // Pass `level` through unchanged so a resolver stays shared with children.
      return createConsoleLogger(childScope, level);
    },
  };
}

/**
 * Default console logger instance
 */
export const consoleLogger: ILogger = createConsoleLogger();

/**
 * Silent logger that discards all messages
 */
export const silentLogger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withLevel: () => silentLogger,
  createScope: () => silentLogger,
};
