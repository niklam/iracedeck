/**
 * @iracedeck/deck-core
 *
 * Platform-agnostic core interfaces, base classes, and utilities
 * for deck device plugins.
 */

// Platform abstraction types
export type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialDownEvent,
  IDeckDialRotateEvent,
  IDeckDialUpEvent,
  IDeckDidReceiveSettingsEvent,
  IDeckEvent,
  IDeckKeyDownEvent,
  IDeckKeyUpEvent,
  IDeckPlatformAdapter,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
} from "./types.js";

// Base action with inactive overlay support
export { BaseAction } from "./base-action.js";

// Common settings (shared by all actions)
export { CommonSettings, ColorOverridesSchema, type ColorOverrides } from "./common-settings.js";

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
  overlayConfig,
} from "./overlay-utils.js";

// Icon template utilities
export {
  escapeXml,
  generateIconText,
  parseIconDefaults,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
  type ColorSlots,
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
  getGlobalColors,
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

// Scan code mapping
export { getScanCode, getModifierScanCode } from "./scan-code-map.js";

// Key binding utilities
export { formatKeyBinding, parseKeyBinding } from "./key-binding-utils.js";
