/**
 * @iracedeck/deck-core
 *
 * Platform-agnostic core interfaces, base classes, and utilities
 * for deck device plugins.
 */

// Platform abstraction types
export type {
  DeckTriggerDescription,
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
  IDeckTouchTapEvent,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
} from "./types.js";

// Encoder touch-strip feedback types (platform-agnostic)
export type {
  DeckFeedbackPayload,
  DeckFeedbackValue,
  DeckFeedbackBarItem,
  DeckFeedbackTextItem,
  DeckFeedbackPixmapItem,
} from "./feedback-types.js";

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

// Binding-missing warning overlay (issue #612, re-exports from icon-composer)
export {
  applyBindingWarning,
  BINDING_WARNING_DIM_OPACITY,
  BINDING_WARNING_GLYPH,
  bindingWarningSvg,
  dimForBindingWarning,
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
  parseIconBorderDefaults,
  parseIconDefaults,
  parseIconLocked,
  parseIconTitleDefaults,
  parseSvgViewBox,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
  type ColorSlots,
  type IconBorderDefaults,
  type IconTitleDefaults,
  type GenerateIconTextOptions,
  type SvgViewBox,
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
  deleteGlobalSettings,
  isGlobalSettingsInitialized,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  _resetGlobalSettings,
} from "./global-settings.js";

// Per-mode sim-communication descriptors (issue #612)
export {
  isConstantBindingKey,
  isMultiBindingKey,
  keybind,
  keybindBy,
  keybindFixed,
  keybindKeys,
  resolveBindingKey,
  resolveBindingKeys,
  type ActionCommMap,
  type BindingKeyConstant,
  type BindingKeyMulti,
  type BindingKeyRef,
  type BindingKeyResolved,
  type CommDescriptor,
  type CommMethod,
  type CommsCatalog,
} from "./comm-descriptor.js";

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

// Shared pit fuel-fill / autofuel telemetry readers (Fuel Service keypad + dial surfaces)
export { isFuelFillOn, isAutofuelActive, isAutofuelEnabled, isPitstopActive } from "./fuel-telemetry.js";

// Shared dial-gesture convention (Push + Turn pair + release-time classifier)
export {
  DIAL_LONG_PRESS_THRESHOLD_MS,
  type DirectionalPair,
  type DialReleaseKind,
  resolvePairedAction,
  classifyDialRelease,
} from "./dial-gesture.js";

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

// Clipboard service singleton
export {
  initializeClipboard,
  getClipboard,
  isClipboardInitialized,
  _resetClipboard,
  type IClipboardService,
  type ClipboardWriter,
} from "./clipboard-service.js";

// App monitor for iRacing process detection
export {
  _resetAppMonitor,
  initAppMonitor,
  IRACING_EXIT_SDK_CONFIRM_MS,
  isAppMonitorInitialized,
  isIRacingActive,
  isIRacingRunning,
  onIRacingTerminated,
} from "./app-monitor.js";

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

// Rasterizer service singleton
export {
  _resetRasterizer,
  initializeRasterizer,
  isRasterizerInitialized,
  isSvgDataUri,
  TOUCH_STRIP_SLOT_WIDTH,
  toDeviceImage,
  type SvgRenderFn,
} from "./rasterizer-service.js";

// Key binding utilities
export { formatKeyBinding, parseKeyBinding, parseBinding } from "./key-binding-utils.js";
export { setWarning, clearWarning, type PiWarning, type PiWarningLevel } from "./pi-warnings.js";

// Setup-name mismatch warning (issue #625)
export {
  compileSetupWarningPattern,
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
  evaluateSetupWarning,
  resolveSetupWarningPattern,
  SETUP_WARNING_ENABLED_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID,
  SETUP_WARNING_RACE_PATTERN_KEY,
  SETUP_WARNING_RACE_PATTERN_WARNING_ID,
  setupNameMatchesPattern,
  validateSetupWarningPatterns,
  type SetupWarningKind,
} from "./setup-warning.js";
export { evaluateElevationWarning, ELEVATION_WARNING_ID, ELEVATION_WARNING_MESSAGE } from "./elevation-warning.js";

// Dual-press tracker (issue #540)
export {
  DualPressTracker,
  DUAL_PRESS_THRESHOLD_FALLBACK_MS,
  DUAL_PRESS_DIRECTIONS_FALLBACK,
  type DualPressDirections,
  getDualPressThresholdMs,
  getDualPressDirections,
} from "./dual-press.js";

// Plugin config singleton
export {
  initPluginConfig,
  getPluginVersion,
  getPluginPlatform,
  isPluginConfigInitialized,
  getFeatureFlag,
  getPlatformFeatures,
  _resetPluginConfig,
  type PluginConfig,
  type PlatformFeatureFlags,
  type PlatformFeatures,
} from "./plugin-config.js";

// Version-check / changelog opener (issues #680, #742, #870)
export {
  buildChangelogUrl,
  CHANGELOG_BASE_URL,
  CHANGELOG_NOTIFICATION_POLICIES,
  type ChangelogDecision,
  type ChangelogNotificationPolicy,
  MONTHLY_WINDOW_MS,
  resolveChangelogDecision,
  runVersionCheck,
  shouldOpenChangelog,
  VERSION_CHECK_STARTUP_GRACE_MS,
} from "./version-check.js";

// Device + profile reference (issues #736, #753, #790)
export {
  CAR_SELECTOR_PROFILE,
  DEFAULT_KEY_IMAGE_SIZE,
  DEVICE_SPECS,
  DEVICE_SUPPORT,
  deviceProfileName,
  DeviceType,
  getDeviceSpec,
  getDeviceSupport,
  isDeviceSupported,
  keyImageSizeForDevice,
  PROFILE_DEVICE_SUFFIXES,
  profileDeviceSuffix,
  profileDisplayName,
  PROFILE_NAMES,
  PROFILE_NAV_ACTIONS,
  PROFILE_TARGET_DEVICES,
  resolveProfileNameForDevice,
  shipsBundledProfiles,
  type DeviceControlSupport,
  type DeviceSpec,
  type DeviceSupport,
  type ProfileTemplate,
  type ProfileTemplateStatus,
} from "./device-profiles.js";

// Profile switcher singleton (issue #736)
export {
  _resetProfileSwitcher,
  initProfileSwitcher,
  isProfileSwitcherInitialized,
  notifyProfileVisible,
  requestProfileSwitch,
  requestProfileSwitchBack,
  type ProfileSwitcher,
} from "./profile-switcher.js";
