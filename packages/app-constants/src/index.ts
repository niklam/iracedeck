// Changelog notification policy (issues #742, #1061)
export {
  CHANGELOG_NOTIFICATION_POLICIES,
  type ChangelogNotificationPolicy,
  DEFAULT_CHANGELOG_NOTIFICATION_POLICY,
} from "./changelog-policy.js";

// CPU profile capture status key (issue #1338)
export { PROFILE_CAPTURE_STATUS_KEY } from "./cpu-profile-capture-constants.js";

// Focus iRacing Window mode (issue #977)
export {
  DEFAULT_FOCUS_IRACING_MODE,
  FOCUS_IRACING_MODES,
  type FocusIRacingMode,
  parseFocusIRacingMode,
} from "./focus-iracing-mode.js";

// The key map and default-binding parser the PI and the plugin share (issue #1277)
export {
  type DefaultKeyBinding,
  defaultBindingStoredValue,
  isValidKey,
  KEY_CODE_MAP,
  keyForCode,
  keyToCode,
  type Modifier,
  MODIFIER_ALIASES,
  MODIFIERS,
  parseDefaultKeyBinding,
} from "./key-binding-defaults.js";

// Where a host's own plugin log lives, for the adapter contract and the watchdog (issues #1349, #1367)
export type { LogLocation } from "./log-location.js";

// Property Inspector warning banner key and record shape (issues #610, #1014, #1366)
export { PI_WARNING_LEVELS, PI_WARNINGS_KEY, type PiWarning, type PiWarningLevel } from "./pi-warnings-constants.js";

// Settings-window page name and warning ids (issues #992, #1005)
export {
  SETTINGS_WINDOW_HTML,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
} from "./settings-window-ids.js";

// Mouse to Sim pointer target (issue #1029)
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

// Voice-pack catalog location and its development override key (issue #1100)
export {
  VOICE_PACK_CATALOG_DEFAULT_BASE,
  VOICE_PACK_CATALOG_FILENAME,
  VOICE_PACK_DEV_BASE_URL_KEY,
} from "./voice-pack-catalog-location.js";

// Voice-pack setting keys and the managed pack id (issue #1034)
export { ENSURED_VOICE_PACK_ID, VOICE_LABELS_KEY, VOICE_PACK_STATUS_KEY, VOICE_PACKS_KEY } from "./voice-pack-keys.js";

// Voice-pack status payload (issue #1034)
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
