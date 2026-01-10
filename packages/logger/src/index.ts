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
 * Create an immutable console logger
 */
export function createConsoleLogger(scope?: string, level: LogLevel = LogLevel.Info): ILogger {
  const formatMessage = (message: string) => (scope ? `[${scope}] ${message}` : message);

  return {
    trace: (message: string) => {
      if (level <= LogLevel.Trace) console.debug(formatMessage(message));
    },
    debug: (message: string) => {
      if (level <= LogLevel.Debug) console.debug(formatMessage(message));
    },
    info: (message: string) => {
      if (level <= LogLevel.Info) console.info(formatMessage(message));
    },
    warn: (message: string) => {
      if (level <= LogLevel.Warn) console.warn(formatMessage(message));
    },
    error: (message: string) => {
      if (level <= LogLevel.Error) console.error(formatMessage(message));
    },
    withLevel: (newLevel: LogLevel) => createConsoleLogger(scope, newLevel),
    createScope: (newScope: string) => {
      const childScope = scope ? `${scope}:${newScope}` : newScope;

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
