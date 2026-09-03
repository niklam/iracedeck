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
  type InitGlobalSettingsOptions,
  MIGRATION_TIMEOUT_MS,
  MIGRATION_ABANDONED_KEY,
  MIGRATION_PENDING_KEY,
  MIGRATION_RETRY_STARTS,
  SETTINGS_CHANNEL_KEY,
  LOAD_RETRY_DELAY_MS,
  LOAD_ATTEMPTS,
  getGlobalSettings,
  getGlobalColors,
  onGlobalSettingsChange,
  updateGlobalSettings,
  deleteGlobalSettings,
  isGlobalSettingsInitialized,
  isSettingsStoreReady,
  getSettingsStoreSource,
  type SettingsStoreSource,
  hostMirrorPayload,
  DEFAULT_RACE_ENGINEER_VOICE,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  sameValue,
  _resetGlobalSettings,
} from "./global-settings.js";

// One-shot renamed-key migrations (issue #953)
export { migrateGlobalSettingsKeys } from "./global-settings-migrations.js";

// Per-feature startup policy for the Race Engineer / Radar gates (issue #1007)
export {
  DEFAULT_FEATURE_STARTUP_POLICY,
  FEATURE_STARTUP_GATES,
  FEATURE_STARTUP_POLICIES,
  resolveStartupGate,
  type FeatureStartupGate,
  type FeatureStartupPolicy,
} from "./feature-startup-policy.js";
export { applyStartupFeatureGates, migrateStartupPolicies } from "./feature-startup-gates.js";

// Plugin-owned settings store (issue #993)
export {
  createFileSettingsStore,
  createMemorySettingsStore,
  resolveSettingsStorePath,
  settingsStoreFolderName,
  WRITE_RETRY_DELAYS_MS,
  type FileSettingsStoreOptions,
  type ResolveSettingsStorePathOptions,
  type SettingsStore,
} from "./settings-store.js";

// Downloadable Race Engineer voice packs (issue #1034)
export { resolveVoicePacksPath, type ResolveVoicePacksPathOptions } from "./voice-packs-path.js";
export {
  parseVoicePackManifest,
  VoicePackManifestSchema,
  type ParseVoicePackManifestResult,
  type VoicePackManifest,
} from "./voice-pack-manifest.js";
export {
  scanVoicePacks,
  type InstalledVoice,
  type InstalledVoicePack,
  type ScanVoicePacksOptions,
  type ScanVoicePacksResult,
  type VoicePackFileSystem,
  type VoicePackProblem,
} from "./voice-pack-scanner.js";
export {
  VOICE_LABELS_KEY,
  VOICE_PACK_PROVENANCE_FILE,
  VOICE_PACK_STATUS_KEY,
  VOICE_PACKS_KEY,
} from "./voice-pack-constants.js";
export {
  isVoicePackOfferable,
  parseVoicePackCatalog,
  type VoicePackCatalogEntry,
  VoicePackCatalogEntrySchema,
  VoicePackCatalogSchema,
} from "./voice-pack-catalog.js";
export {
  parseVoicePackProvenance,
  serializeVoicePackProvenance,
  VOICE_PACK_SOURCES,
  type VoicePackProvenance,
  VoicePackProvenanceSchema,
  type VoicePackSource,
} from "./voice-pack-provenance.js";
export {
  emptyVoicePackStatus,
  VOICE_PACK_INSTALL_PHASES,
  VOICE_PACK_OFFER_VERDICTS,
  type VoicePackCatalogState,
  type VoicePackInstallPhase,
  type VoicePackInstallState,
  type VoicePackOffer,
  type VoicePackOfferVerdict,
  type VoicePackStatus,
} from "./voice-pack-status.js";
export { voiceDisplayLabels } from "./voice-labels.js";
export { createVoicePackArchiveFileSystem, createVoicePackFileSystem, VOICE_PACK_MAX_DEPTH } from "./voice-pack-fs.js";
export {
  type BundledVoicePack,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  readInstalledVoicePackSha,
  VOICE_PACK_INSTALL_FAILURE_CODES,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_PACK_PROGRESS_INTERVAL_MS,
  type VoicePackInstallFailureCode,
  type VoicePackInstaller,
  type VoicePackInstallerCatalog,
  type VoicePackInstallerDeps,
  type VoicePackInstallerFileSystem,
  type VoicePackInstallOutcome,
  type VoicePackInstallResult,
  type VoicePackRemoveResult,
  type VoicePackSeedResult,
} from "./voice-pack-installer.js";
export { createVoicePackService, type VoicePackService, type VoicePackServiceDeps } from "./voice-pack-service.js";
export {
  type ExtractVoicePackArchiveOptions,
  type ExtractVoicePackArchiveResult,
  extractVoicePackArchive,
  VOICE_PACK_ARCHIVE_FAILURE_CODES,
  VOICE_PACK_ARCHIVE_LIMITS,
  type VoicePackArchiveFailureCode,
  type VoicePackArchiveFileSystem,
  type VoicePackArchiveLimits,
  type VoicePackArchiveWrite,
} from "./voice-pack-archive.js";
export {
  type DownloadVoicePackOptions,
  downloadVoicePack,
  VOICE_PACK_DOWNLOAD_CEILING_BYTES,
  VOICE_PACK_DOWNLOAD_FAILURES,
  VOICE_PACK_DOWNLOAD_STALL_TIMEOUT_MS,
  type VoicePackDownloadFailure,
  type VoicePackDownloadProgress,
  type VoicePackDownloadResult,
  type VoicePackDownloadSink,
} from "./voice-pack-download.js";
export {
  type CreateVoicePackStagingResult,
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  type OpenVoicePackDownloadResult,
  type PromoteVoicePackResult,
  type RetireVoicePackResult,
  type SweepVoicePacksResult,
  VOICE_PACK_TMP_DIR,
  VOICE_PACK_TRASH_DIR,
  type VoicePackFsResult,
  type VoicePackLock,
  type VoicePackStorage,
  type VoicePackStorageDeps,
  type VoicePackStorageFileSystem,
  type VoicePackWriteHandle,
} from "./voice-pack-storage.js";
export {
  fetchVoicePackCatalog,
  VOICE_PACK_CATALOG_FETCH_TIMEOUT_MS,
  VOICE_PACK_CATALOG_URL,
  type VoicePackCatalogFetchResult,
} from "./voice-pack-catalog-client.js";
export {
  createVoicePackCatalogService,
  VOICE_PACK_CATALOG_FAILURE_TTL_MS,
  VOICE_PACK_CATALOG_SUCCESS_TTL_MS,
  type VoicePackCatalogService,
  type VoicePackCatalogServiceDeps,
} from "./voice-pack-catalog-service.js";

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

// Window focus service singleton
export {
  _resetWindowFocus,
  FocusResult,
  focusIRacingIfEnabled,
  focusIRacingNow,
  initWindowFocus,
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

// Mouse to Sim pointer target resolution (issue #1029)
export {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_ANCHOR_X_FRACTIONS,
  POINTER_ANCHOR_Y_FRACTIONS,
  POINTER_ANCHORS_X,
  POINTER_ANCHORS_Y,
  POINTER_OFFSET_LIMIT,
  type PointerAnchorX,
  type PointerAnchorY,
  resolveSimPointerTarget,
  type SimPointerTarget,
  type SimPointerTargetConfig,
} from "./sim-pointer-target.js";

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
export {
  setWarning,
  clearWarning,
  reconcileWarnings,
  PI_WARNINGS_KEY,
  type PiWarning,
  type PiWarningLevel,
} from "./pi-warnings.js";
// Settings keys that describe THIS RUN and are never persisted (#1014).
export { RUN_SCOPED_SETTING_KEYS, stripRunScopedKeys } from "./run-scoped-settings.js";

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
export { createElevationCheckSubscriber, type ElevationCheckOptions } from "./elevation-check.js";

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

// Version-check / changelog opener (issues #680, #742, #870, #901)
export {
  buildChangelogUrl,
  CHANGELOG_BASE_URL,
  CHANGELOG_NOTIFICATION_POLICIES,
  type ChangelogDecision,
  type ChangelogNotificationPolicy,
  DEFAULT_CHANGELOG_NOTIFICATION_POLICY,
  MONTHLY_WINDOW_MS,
  resolveChangelogDecision,
  runVersionCheck,
  shouldOpenChangelog,
  VERSION_CHECK_STARTUP_GRACE_MS,
} from "./version-check.js";

// Upstream update check for the settings window's What's New tab (issue #1016)
export { sanitizeChangelogHtml } from "./changelog-html-sanitize.js";
export {
  parsePublishedChangelog,
  type PublishedRelease,
  type PublishedReleaseCategory,
} from "./published-changelog.js";
export {
  CHANGELOG_FETCH_TIMEOUT_MS,
  fetchPublishedChangelog,
  PUBLISHED_CHANGELOG_URL,
} from "./changelog-feed-client.js";
export { selectAvailableUpdates } from "./update-check.js";
export {
  createUpdateCheckService,
  UPDATE_CHECK_FAILURE_TTL_MS,
  UPDATE_CHECK_SUCCESS_TTL_MS,
  type UpdateCheckService,
  type UpdateCheckServiceDeps,
  type UpdateStatus,
} from "./update-check-service.js";

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

// Settings window (issue #992): loopback-served, chromeless-app-window settings UI
export {
  appWindowArgs,
  findChromiumBrowser,
  findChromiumBrowserOnThisMachine,
  queryWindowsAppPath,
  SETTINGS_WINDOW_SIZE,
  spawnAppWindow,
  type ChromiumLookupDeps,
} from "./chromium-browser.js";
export {
  authorizeSettingsRequest,
  type SettingsRequestDecision,
  type SettingsRequestDenial,
  type SettingsRequestInput,
} from "./settings-window-guard.js";
export {
  launchSettingsWindow,
  type SettingsWindowBounds,
  type SettingsWindowLaunch,
  type SettingsWindowLaunchInput,
} from "./settings-window-launcher.js";
export {
  FIRST_RUN_VERSION_KEY,
  type FirstRunDecision,
  GETTING_STARTED_PANE,
  resolveFirstRunDecision,
  runFirstRunCheck,
} from "./first-run.js";
export {
  createSettingsWindowCommandHandler,
  enableFeatureWrites,
  parseSettingsWindowBounds,
  SETTINGS_WINDOW_BOUNDS_KEY,
  type SettingsWindowCommandDeps,
} from "./settings-window-commands.js";
export {
  startSettingsWindowServer,
  type SettingsWindowHost,
  type SettingsWindowServer,
  type SettingsWindowServerOptions,
} from "./settings-window-server.js";
export {
  createSettingsWindowController,
  SETTINGS_WINDOW_HTML,
  type SettingsWindowController,
  type SettingsWindowOpenOptions,
  type SettingsWindowControllerOptions,
  type SettingsWindowStatus,
} from "./settings-window.js";
// Settings-window failure banner: the controller's lifecycle outcomes surfaced
// as a PI warning, so an unreachable settings window is diagnosable rather than
// a dead button (issue #1005)
export {
  evaluateSettingsWindowWarnings,
  SETTINGS_WINDOW_OPEN_BLOCKED_MESSAGE,
  SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE,
  SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
  settingsWindowWarningScope,
  type SettingsWindowWarningContext,
} from "./settings-window-warning.js";
export {
  createSettingsWindowWarningReporter,
  type SettingsWindowWarningReporterOptions,
} from "./settings-window-warning-reporter.js";
// Reveal the settings file in Explorer (issue #993)
export { explorerSelectArgs, openDirectoryInExplorer, openFolderInExplorer } from "./open-folder.js";
// Settings-channel publisher: store write + the one host mirror per start (issue #993 phase 2)
export {
  createSettingsChannelPublisher,
  type SettingsChannel,
  type SettingsChannelPublisher,
  type SettingsChannelPublisherDeps,
} from "./settings-channel-publisher.js";
