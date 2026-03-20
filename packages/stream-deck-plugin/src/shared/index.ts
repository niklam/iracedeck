/**
 * @iracedeck/stream-deck-utils
 *
 * Shared utilities for Stream Deck plugins.
 * Re-exports from @iracedeck/deck-core and @iracedeck/deck-adapter-elgato
 * for backward compatibility.
 */

// Re-export everything from deck-core
export {
  // Platform abstraction types
  type IDeckActionContext,
  type IDeckActionHandler,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckPlatformAdapter,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  // Base actions
  BaseAction,
  CommonSettings,
  ColorOverridesSchema,
  type ColorOverrides,
  ConnectionStateAwareAction,
  // Overlay utilities
  applyInactiveOverlay,
  hexToGrayscale,
  isDataUri,
  isRawSvg,
  svgToDataUri,
  dataUriToSvg,
  // Icon template utilities
  escapeXml,
  generateIconText,
  parseIconDefaults,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
  type ColorSlots,
  type GenerateIconTextOptions,
  // Logger
  LogLevel,
  // SDK singleton
  initializeSDK,
  getSDK,
  getController,
  getCommands,
  isSDKInitialized,
  _resetSDK,
  // Global settings
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
  // Unit conversion
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
  // Keyboard types
  KEYBOARD_KEYS,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  type IRacingHotkeyPreset,
  // iRacing hotkeys
  IRACING_HOTKEY_PRESETS,
  getHotkeyPreset,
  getHotkeysByCategory,
  // Keyboard service
  initializeKeyboard,
  getKeyboard,
  isKeyboardInitialized,
  _resetKeyboard,
  type IKeyboardService,
  type ScanKeySender,
  type ScanKeyPresser,
  type ScanKeyReleaser,
  // App monitor
  initAppMonitor,
  isIRacingRunning,
  isAppMonitorInitialized,
  _resetAppMonitor,
  // Key binding utilities
  formatKeyBinding,
  parseKeyBinding,
} from "@iracedeck/deck-core";

// Re-export from deck-adapter-elgato
export { createSDLogger, type SDLoggerLike } from "@iracedeck/deck-adapter-elgato";

// Window focus service (Elgato-specific, depends on @iracedeck/iracing-native)
export { initWindowFocus, focusIRacingIfEnabled } from "./window-focus.js";
