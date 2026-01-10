/**
 * @iracedeck/stream-deck-utils
 *
 * Shared utilities for Stream Deck plugins.
 */

// Logger adapter
export { createSDLogger, SDLoggerLike } from "./sd-logger.js";

// Base action with inactive overlay support
export { BaseAction } from "./base-action.js";

// Overlay utilities
export { applyInactiveOverlay, isDataUri, isRawSvg, svgToDataUri, dataUriToSvg } from "./overlay-utils.js";

// Re-export LogLevel for convenience
export { LogLevel } from "@iracedeck/logger";
