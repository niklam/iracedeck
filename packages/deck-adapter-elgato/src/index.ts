/**
 * @iracedeck/deck-adapter-elgato
 *
 * Elgato Stream Deck adapter for the deck-core platform abstraction.
 */

export { ElgatoPlatformAdapter } from "./adapter.js";
export { createLogWriteFailures, createSDLogger, type LogWriteFailures, type SDLoggerLike } from "./sd-logger.js";
export { elgatoPluginLogFile, elgatoPluginUuid } from "./log-file.js";
