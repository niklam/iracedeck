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
  DIMMED_OPACITY,
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

// User-entered title template resolution (issue #899)
export { resolveTitleTemplate, titleHasTemplate } from "./title-template.js";

// Per-context icon-update throttle (issue #493; moved from iracing-actions in #899)
export { IconUpdateThrottle } from "./icon-update-throttle.js";

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

// The sim-neutral connection the base classes read (#1351)
export {
  _resetSimConnection,
  getSimConnection,
  initializeSimConnection,
  isSimConnectionInitialized,
  type OverlayFlag,
  type SimConnection,
} from "./sim-connection.js";

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

// Shared dial-gesture convention (Push + Turn pair, release-time classifier,
// display-only hold preview)
export {
  DIAL_LONG_PRESS_THRESHOLD_MS,
  type DirectionalPair,
  type DialReleaseKind,
  type HoldPreview,
  resolvePairedAction,
  classifyDialRelease,
  createHoldPreview,
} from "./dial-gesture.js";

// Keyboard types
export {
  KEYBOARD_KEYS,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  type IRacingHotkeyPreset,
} from "./keyboard-types.js";

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

// Window focus service singleton
export {
  _resetWindowFocus,
  type ElevationMismatchCheck,
  FOCUS_TIMEOUT_COOLDOWN_MS,
  FocusResult,
  focusIRacingBeforeInput,
  focusIRacingIfEnabled,
  focusIRacingNow,
  initWindowFocus,
  type SimRunningCheck,
  type WindowFocuser,
} from "./window-focus-service.js";

// Clipboard service singleton
export {
  initializeClipboard,
  getClipboard,
  isClipboardInitialized,
  _resetClipboard,
  type IClipboardService,
  type ClipboardWriter,
} from "./clipboard-service.js";

// Mouse pointer service singleton (issue #926)
export {
  _resetMousePointer,
  DEFAULT_POINTER_X_FRACTION,
  DEFAULT_POINTER_Y_FRACTION,
  initMousePointer,
  movePointerToSim,
  PointerMoveResult,
  type SimPointerMover,
} from "./mouse-pointer-service.js";

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
  type DeviceImageSize,
  type SvgRenderFn,
} from "./rasterizer-service.js";

// Key binding utilities
export { formatKeyBinding, parseKeyBinding, parseBinding } from "./key-binding-utils.js";

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
  getDevVoicePacksRoot,
  _resetPluginConfig,
  type PluginConfig,
  type PlatformFeatureFlags,
  type PlatformFeatures,
} from "./plugin-config.js";

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

// The dial's own screen: hardware profiles the adapters hand out and the
// renderers branch on (issue #1013)
export {
  DIAL_CANVAS_KEY,
  SD_PLUS_STRIP_CANVAS,
  STREAM_DOCK_KNOB_CANVAS,
  type DialCanvasId,
  type DialCanvasProfile,
} from "./dial-canvas.js";

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
