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
  extractSvgContent,
  generateIconText,
  loadIconTemplate,
  renderIcon,
  renderIconTemplate,
  validateIconTemplate,
  type GenerateIconTextOptions,
} from "./icon-template.js";

// Re-export LogLevel for convenience
export { LogLevel } from "@iracedeck/logger";

// SDK singleton for lazy initialization
export { initializeSDK, getSDK, getController, getCommands, isSDKInitialized, _resetSDK } from "./sdk-singleton.js";

// Global settings
export {
  GlobalSettingsSchema,
  type GlobalSettings,
  KeyBindingValueSchema,
  type KeyBindingValue,
  initGlobalSettings,
  getGlobalSettings,
  onGlobalSettingsChange,
  isGlobalSettingsInitialized,
  _resetGlobalSettings,
} from "./global-settings.js";

// Unit conversion utilities
export {
  LITERS_TO_GALLONS,
  GALLONS_TO_LITERS,
  FUEL_UNIT_METRIC,
  FUEL_UNIT_IMPERIAL,
  litersToGallons,
  gallonsToLiters,
  getFuelUnitSuffix,
  isMetricUnits,
  fuelToDisplayUnits,
  fuelFromDisplayUnits,
  formatFuelAmount,
  formatFuelAmountWithPrefix,
  formatFuelSettingWithUnit,
} from "./unit-conversion.js";

// Keyboard types
export {
  KEYBOARD_KEYS,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  type IRacingHotkeyPreset,
} from "./keyboard-types.js";

// iRacing hotkey presets
export { IRACING_HOTKEY_PRESETS, getHotkeyPreset, getHotkeysByCategory } from "./iracing-hotkeys.js";

// Keyboard service singleton
export {
  initializeKeyboard,
  getKeyboard,
  isKeyboardInitialized,
  _resetKeyboard,
  type IKeyboardService,
  type ScanKeySender,
  type ScanKeyPresser,
  type ScanKeyReleaser,
} from "./keyboard-service.js";

// App monitor for iRacing process detection
export { initAppMonitor, isIRacingRunning, isAppMonitorInitialized, _resetAppMonitor } from "./app-monitor.js";

// Key binding utilities
export { formatKeyBinding, parseKeyBinding } from "./key-binding-utils.js";
