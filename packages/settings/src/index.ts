/**
 * @iracedeck/settings — the plugin's global settings: the schema and cache,
 * the one-shot migrations, the plugin-owned settings store, the run-scoped
 * keys, the PI warnings and the banners built on them, the first-run check and
 * the per-feature startup gates (#1365). It sits below the deck layer:
 * `SettingsHost` is the host surface it needs, which deck-core's
 * `IDeckPlatformAdapter` extends.
 */

// The host surface the settings layer reads and writes through (#1365)
export type { SettingsHost } from "./settings-host.js";

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
  isCalloutEnabled,
  setCalloutEnabled,
  getGlobalColors,
  onGlobalSettingsChange,
  updateGlobalSettings,
  deleteGlobalSettings,
  isGlobalSettingsInitialized,
  isSettingsStoreHostDerived,
  isSettingsStoreReady,
  whenSettingsStoreSettled,
  getSettingsStoreSource,
  type SettingsStoreSource,
  hostMirrorPayload,
  DEFAULT_RACE_ENGINEER_VOICE,
  frameOptionsFromSettings,
  type RadioFrameSwitches,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  sameValue,
  _resetGlobalSettings,
} from "./global-settings.js";

// One-shot renamed-key migrations (issue #953), the idempotent voice-id
// qualification (#1144) and the seed-if-absent binding defaults (#1277)
export {
  migrateGlobalSettingsKeys,
  migrateRaceEngineerVoiceId,
  seedBindingDefaultsIfAbsent,
} from "./global-settings-migrations.js";

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
  nonBlank,
  resolveLocalAppData,
  resolveSettingsStorePath,
  settingsStoreFolderName,
  WRITE_RETRY_DELAYS_MS,
  type FileSettingsStoreOptions,
  type ResolveSettingsStorePathOptions,
  type SettingsFileRejection,
  type SettingsStore,
} from "./settings-store.js";
// The banner for a settings file the store rejected (issue #1036)
export {
  evaluateSettingsFileRejectionWarning,
  SETTINGS_FILE_REJECTED_WARNING_ID,
} from "./settings-file-rejection-warning.js";
export { createSettingsFileRejectionReporter } from "./settings-file-rejection-reporter.js";

// Property Inspector warning banners
export { setWarning, clearWarning, reconcileWarnings } from "./pi-warnings.js";
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
  type SetupWarningSettings,
} from "./setup-warning.js";

// First-run detection and the Getting Started open (issue #1061)
export {
  FIRST_RUN_VERSION_KEY,
  type FirstRunDecision,
  GETTING_STARTED_PANE,
  resolveFirstRunDecision,
  runFirstRunCheck,
} from "./first-run.js";
