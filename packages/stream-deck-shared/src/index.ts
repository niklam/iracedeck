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

// Icon template utilities
export {
  clearTemplateCache,
  escapeXml,
  loadIconTemplate,
  renderIcon,
  renderIconTemplate,
  validateIconTemplate,
} from "./icon-template.js";

// Re-export LogLevel for convenience
export { LogLevel } from "@iracedeck/logger";

// SDK singleton for lazy initialization
export { initializeSDK, getSDK, getController, getCommands, isSDKInitialized, _resetSDK } from "./sdk-singleton.js";

// Global settings
export {
  GlobalSettingsSchema,
  type GlobalSettings,
  initGlobalSettings,
  getGlobalSettings,
  onGlobalSettingsChange,
  isGlobalSettingsInitialized,
  _resetGlobalSettings,
} from "./global-settings.js";
