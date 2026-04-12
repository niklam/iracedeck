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
export {
  CommonSettings,
  BorderOverridesSchema,
  ColorOverridesSchema,
  type ColorOverrides,
  GraphicOverridesSchema,
  TitleOverridesSchema,
} from "./common-settings.js";

// Settings migration helpers
export { migrateLegacyActionToMode } from "./migrate-legacy-action.js";

// Title, border, and graphic settings (re-exports from icon-composer + global readers)
export {
  applyGraphicTransform,
  assembleIcon,
  BORDER_DEFAULTS,
  calculateYPositions,
  computeGraphicArea,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  GRAPHIC_DEFAULTS,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveTitleSettings,
  TITLE_DEFAULTS,
  type BorderOverrides,
  type GenerateTitleTextOptions,
  type GlobalBorderSettings,
  type GlobalGraphicSettings,
  type GraphicArea,
  type GraphicOverrides,
  type ResolvedBorderSettings,
  type ResolvedGraphicSettings,
  type ResolvedTitleSettings,
  type GlobalTitleSettings,
  type TitleOverrides,
} from "./title-settings.js";

// Icon base template (re-exports from icon-composer)
export { generateBorderParts, ICON_BASE_TEMPLATE, extractGraphicContent } from "./icon-base.js";

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

// Icon template utilities (re-exports from icon-composer)
export {
  escapeXml,
  generateIconText,
  parseDescMetadata,
  parseIconArtworkBounds,
  parseIconBorderDefaults,
  parseIconDefaults,
  parseIconLocked,
  parseIconTitleDefaults,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
  type ColorSlots,
  type IconArtworkBounds,
  type IconBorderDefaults,
  type IconTitleDefaults,
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
  SimHubBindingValueSchema,
  type SimHubBindingValue,
  type BindingValue,
  isSimHubBinding,
  initGlobalSettings,
  getGlobalSettings,
  getGlobalColors,
  onGlobalSettingsChange,
  updateGlobalSettings,
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

// SimHub Control Mapper service singleton
export {
  initializeSimHub,
  getSimHub,
  isSimHubInitialized,
  isSimHubReachable,
  onSimHubReachabilityChange,
  _resetSimHub,
  type ISimHubService,
} from "./simhub-service.js";

// Binding dispatcher singleton
export {
  initializeBindingDispatcher,
  getBindingDispatcher,
  isBindingDispatcherInitialized,
  _resetBindingDispatcher,
  type IBindingDispatcher,
} from "./binding-dispatcher.js";

// Key binding utilities
export { formatKeyBinding, parseKeyBinding, parseBinding } from "./key-binding-utils.js";

// Plugin config singleton
export {
  initPluginConfig,
  getPluginVersion,
  getPluginPlatform,
  isPluginConfigInitialized,
  _resetPluginConfig,
  type PluginConfig,
} from "./plugin-config.js";
