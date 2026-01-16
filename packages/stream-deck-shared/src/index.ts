/**
 * @iracedeck/stream-deck-utils
 *
 * Shared utilities for Stream Deck plugins.
 */

// Logger adapter
export { createSDLogger, SDLoggerLike } from "./sd-logger.js";

// Base action with inactive overlay support
export { BaseAction } from "./base-action.js";

// Connection state aware action (extends BaseAction with iRacing connection tracking)
export { ConnectionStateAwareAction } from "./connection-state-aware-action.js";

// Overlay utilities
export {
  applyInactiveOverlay,
  hexToGrayscale,
  isDataUri,
  isRawSvg,
  svgToDataUri,
  dataUriToSvg,
} from "./overlay-utils.js";

// Re-export LogLevel for convenience
export { LogLevel } from "@iracedeck/logger";
