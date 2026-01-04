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

export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setLevel(level: LogLevel): void;
  createScope(scope: string): Logger;
}

/**
 * Create a console logger with configurable level
 */
function createConsoleLogger(scope?: string): Logger {
  let currentLevel: LogLevel = LogLevel.Info;

  const formatMessage = (message: string) => (scope ? `[${scope}] ${message}` : message);

  const logger: Logger = {
    trace: (message: string) => {
      if (currentLevel <= LogLevel.Trace) console.debug(formatMessage(message));
    },
    debug: (message: string) => {
      if (currentLevel <= LogLevel.Debug) console.debug(formatMessage(message));
    },
    info: (message: string) => {
      if (currentLevel <= LogLevel.Info) console.info(formatMessage(message));
    },
    warn: (message: string) => {
      if (currentLevel <= LogLevel.Warn) console.warn(formatMessage(message));
    },
    error: (message: string) => {
      if (currentLevel <= LogLevel.Error) console.error(formatMessage(message));
    },
    setLevel: (level: LogLevel) => {
      currentLevel = level;
    },
    createScope: (newScope: string) => {
      const childScope = scope ? `${scope}:${newScope}` : newScope;
      const child = createConsoleLogger(childScope);
      child.setLevel(currentLevel);

      return child;
    },
  };

  return logger;
}

/**
 * Console logger implementation
 */
export const consoleLogger: Logger = createConsoleLogger();

/**
 * Silent logger that discards all messages
 */
export const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setLevel: () => {},
  createScope: () => silentLogger,
};
