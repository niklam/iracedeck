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
  // Keyboard types
  KEYBOARD_KEYS,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  type IRacingHotkeyPreset,
  // Keyboard service
  initializeKeyboard,
  getKeyboard,
  isKeyboardInitialized,
  _resetKeyboard,
  type IKeyboardService,
  type ScanKeySender,
  type ScanKeyPresser,
  type ScanKeyReleaser,
  // Window focus service
  initWindowFocus,
  focusIRacingIfEnabled,
  FocusResult,
  type WindowFocuser,
  // Key binding utilities
  formatKeyBinding,
  parseKeyBinding,
  // Unconditional focus + mouse pointer placement (#926)
  focusIRacingNow,
  initMousePointer,
  movePointerToSim,
} from "@iracedeck/deck-core";

// Re-export from deck-adapter-elgato
export { createSDLogger, type SDLoggerLike } from "@iracedeck/deck-adapter-elgato";
