/**
 * iRaceDeck Mirabox Plugin
 *
 * Entry point for the VSD Craft plugin. Registers all iRaceDeck actions
 * via the VSDPlatformAdapter, enabling them on Mirabox devices.
 *
 * Mirrors the Elgato Stream Deck plugin initialization order.
 */
import defaultVoicePackCatalogEntry from "@iracedeck/audio-assets/catalog/default.json" with { type: "json" };
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import { AudioNative } from "@iracedeck/audio-native";
import {
  type AudioAssetsManifest,
  getScenarioEngine,
  initializeAudioScenarios,
  isAudioScenariosInitialized,
  mergeManifests,
  scanDriverNames,
  scanRaceEngineerVoices,
} from "@iracedeck/audio-scenarios";
import {
  CORNER_NAME_CALLOUT_SETTING_KEYS,
  type CornerNameCalloutId,
  type CornerNameSnapshot,
  DAMAGE_CALLOUT_SETTING_KEYS,
  type DamageCalloutId,
  FLAG_CALLOUT_SETTING_KEYS,
  type FlagCalloutId,
  FUEL_CALLOUT_SETTING_KEYS,
  type FuelCalloutId,
  GAP_CALLOUT_SETTING_KEYS,
  type GapCalloutId,
  INCIDENT_CALLOUT_SETTING_KEYS,
  type IncidentCalloutId,
  LAP_TIME_CALLOUT_SETTING_KEYS,
  type LapCompletedSnapshot,
  type LapTimeCalloutId,
  NO_LIMITER_CALLOUT_SETTING_KEYS,
  type NoLimiterCalloutId,
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  type OpponentFlagCalloutId,
  type OpponentPitCalloutId,
  OVERTAKE_CALLOUT_SETTING_KEYS,
  type OvertakeCalloutId,
  type OvertakeGate,
  PIT_BOX_CALLOUT_SETTING_KEYS,
  PIT_LIMITER_CALLOUT_SETTING_KEYS,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  PIT_SPEEDING_CALLOUT_SETTING_KEYS,
  PIT_STATUS_CALLOUT_SETTING_KEYS,
  PIT_WINDOW_CALLOUT_SETTING_KEYS,
  type PitBoxCalloutId,
  type PitLimiterCalloutId,
  type PitReadbackCalloutId,
  type PitSpeedingCalloutId,
  type PitStatusCalloutId,
  type PitWindowCalloutId,
  POSITION_CALLOUT_SETTING_KEYS,
  type PositionCalloutId,
  QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS,
  type QualifyingInvalidationCalloutId,
  RACE_END_CALLOUT_SETTING_KEYS,
  RACE_START_CALLOUT_SETTING_KEYS,
  RACE_STATUS_CALLOUT_SETTING_KEYS,
  type RaceEndCalloutId,
  type RaceFinishedSnapshot,
  type RaceStartCalloutId,
  type RaceStatusCalloutId,
  registerPitCrew,
  resolveGapCooldownMs,
  resolveStillThereIntervalMs,
  ROLLING_START_CALLOUT_SETTING_KEYS,
  type RollingStartCalloutId,
  SESSION_START_CALLOUT_SETTING_KEYS,
  type SessionStartCalloutId,
  SPOTTER_CALLOUT_SETTING_KEYS,
  SPOTTER_STILL_THERE_SECONDS_KEY,
  type SpotterCalloutId,
  START_LIGHT_CALLOUT_SETTING_KEYS,
  type StartLightCalloutId,
  TRACK_CONDITIONS_CALLOUT_SETTING_KEYS,
  type TrackConditionsCalloutId,
} from "@iracedeck/audio-scenarios/pit-crew";
import { getAudio, initializeAudio } from "@iracedeck/audio-service";
import { VSDPlatformAdapter } from "@iracedeck/deck-adapter-mirabox";
import {
  applyStartupFeatureGates,
  type BundledVoicePack,
  createElevationCheckSubscriber,
  createFileSettingsStore,
  createSettingsChannelPublisher,
  createSettingsWindowCommandHandler,
  createSettingsWindowController,
  createSettingsWindowWarningReporter,
  createUpdateCheckService,
  createVoicePackArchiveFileSystem,
  createVoicePackCatalogService,
  createVoicePackFileSystem,
  createVoicePackInstaller,
  createVoicePackInstallerFileSystem,
  createVoicePackService,
  createVoicePackStorage,
  createVoicePackStorageFileSystem,
  deleteGlobalSettings,
  evaluateSetupWarning,
  findChromiumBrowserOnThisMachine,
  FIRST_RUN_VERSION_KEY,
  focusIRacingIfEnabled,
  getController,
  getGlobalSettings,
  getPluginPlatform,
  getPluginVersion,
  getSimHub,
  GETTING_STARTED_PANE,
  initAppMonitor,
  initGlobalSettings,
  initializeBindingDispatcher,
  initializeClipboard,
  initializeKeyboard,
  initializeRasterizer,
  initializeSDK,
  initializeSimHub,
  initMousePointer,
  initPluginConfig,
  initWindowFocus,
  isGlobalSettingsInitialized,
  isIRacingActive,
  isSettingsStoreReady,
  isSimHubReachable,
  migrateGlobalSettingsKeys,
  migrateStartupPolicies,
  MIGRATION_PENDING_KEY,
  onGlobalSettingsChange,
  onIRacingTerminated,
  openDirectoryInExplorer,
  openFolderInExplorer,
  parseSettingsWindowBounds,
  type PluginConfig,
  readInstalledVoicePackSha,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  resolveSettingsStorePath,
  resolveVoicePacksPath,
  runFirstRunCheck,
  runVersionCheck,
  SETTINGS_WINDOW_BOUNDS_KEY,
  SETTINGS_WINDOW_HTML,
  type SettingsWindowOpenOptions,
  shouldOpenChangelog,
  spawnAppWindow,
  updateGlobalSettings,
  validateSetupWarningPatterns,
  VERSION_CHECK_STARTUP_GRACE_MS,
  VOICE_LABELS_KEY,
  VOICE_PACK_STATUS_KEY,
  VOICE_PACKS_KEY,
  voiceDisplayLabels,
  VoicePackCatalogEntrySchema,
} from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import {
  AI_SPOTTER_CONTROLS_UUID,
  AiSpotterControls,
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
  armFeatureGateSync,
  AUDIO_CONTROLS_UUID,
  AudioControls,
  BLACK_BOX_SELECTOR_UUID,
  BlackBoxSelector,
  CAMERA_CONTROLS_UUID,
  CAMERA_EDITOR_ADJUSTMENTS_UUID,
  CAMERA_EDITOR_CONTROLS_UUID,
  CameraControls,
  CameraEditorAdjustments,
  CameraEditorControls,
  CAR_CONTROL_UUID,
  CarControl,
  Chat,
  CHAT_UUID,
  COCKPIT_MISC_UUID,
  CockpitMisc,
  FORCE_FEEDBACK_UUID,
  ForceFeedback,
  FUEL_SERVICE_UUID,
  FuelService,
  isAudioPreviewKind,
  LOOK_DIRECTION_UUID,
  LookDirection,
  MEDIA_CAPTURE_UUID,
  MediaCapture,
  migrateLfeIntensityBindingKeys,
  PIT_CREW_UUID,
  PIT_QUICK_ACTIONS_UUID,
  PitCrew,
  PitQuickActions,
  RACE_ADMIN_UUID,
  RaceAdmin,
  REPLAY_CONTROL_UUID,
  REPLAY_NAVIGATION_UUID,
  REPLAY_SPEED_UUID,
  REPLAY_TRANSPORT_UUID,
  ReplayControl,
  ReplayNavigation,
  ReplaySpeed,
  ReplayTransport,
  runAudioPreview,
  SESSION_INFO_UUID,
  SessionInfo,
  SETUP_AERO_UUID,
  SETUP_BRAKES_UUID,
  SETUP_CHASSIS_BINDING_KEY_RENAMES,
  SETUP_CHASSIS_UUID,
  SETUP_ENGINE_UUID,
  SETUP_FUEL_UUID,
  SETUP_HYBRID_UUID,
  SETUP_TRACTION_UUID,
  SetupAero,
  SetupBrakes,
  SetupChassis,
  SetupEngine,
  SetupFuel,
  SetupHybrid,
  SetupTraction,
  SPLITS_DELTA_CYCLE_UUID,
  SplitsDeltaCycle,
  stopRaceEngineerPlayback,
  syncFeatureGates,
  TELEMETRY_CONTROL_UUID,
  TELEMETRY_DISPLAY_UUID,
  TelemetryControl,
  TelemetryDisplay,
  TIRE_SERVICE_UUID,
  TireService,
  TOGGLE_UI_ELEMENTS_UUID,
  ToggleUiElements,
  VIEW_ADJUSTMENT_UUID,
  ViewAdjustment,
} from "@iracedeck/iracing-actions";
import { IRacingNative } from "@iracedeck/iracing-native";
import { LogLevel } from "@iracedeck/logger";
import { createSvgRasterizer } from "@iracedeck/rasterizer";
import {
  getDriverSetupName,
  getLiveCarPosition,
  getLiveGaps,
  getLivePosition,
  getLiveRacePositions,
  getNearestCarGapMeters,
  getOvertakeTelemetryGate,
  getQualifyingInvalidationSnapshot,
  getRaceStartConditions,
  getReadbackSnapshot,
  getSessionStartConditions,
  getTrackDirection,
  initializeSimEventsIracing,
  isPitActionsAllowed,
  isRaceFinished,
  sanitizeCornerCalloutLeadSeconds,
  sanitizeFuelCalloutMarginLaps,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load build-time config (version, platform)
const __binDir = dirname(fileURLToPath(import.meta.url));
const pluginConfig: PluginConfig = JSON.parse(readFileSync(join(__binDir, "config.json"), "utf-8"));
initPluginConfig(pluginConfig);

// Create the VSDinside platform adapter
// Tee logs to <plugin>/log/<YYYY.M.D>.log. The Stream Dock host discards plugin
// stdout, so file logging is what makes the debug toggle actually capture a log
// for support on Mirabox (issue #609). __binDir is <plugin>/bin, so the log dir
// sits next to it under the plugin root — the same convention the host's own
// plugins use.
const adapter = new VSDPlatformAdapter(undefined, join(__binDir, "..", "log"));

// Default to info-level logging in production; the user opts into verbose
// debug logging from the PI "Enable debug logging" toggle (issue #609). The
// adapter holds a shared mutable level its loggers read live, so re-apply on
// every settings change without recreating loggers. The initial call reads the
// schema-default cache (debugLogging=false → info); the host echo re-fires the
// listener with the persisted value once global settings load.
const applyDebugLogging = (settings: ReturnType<typeof getGlobalSettings>): void => {
  adapter.setLogLevel(settings.debugLogging ? LogLevel.Debug : LogLevel.Info);
};
onGlobalSettingsChange(applyDebugLogging);
applyDebugLogging(getGlobalSettings());

// Banner a broken setup-warning regex pattern (issue #625). Validating on every
// settings change gives immediate PI feedback when a user types an invalid
// pattern; the live match closure independently skips the warning, so the
// callout never crashes. The initial call reads the schema-default cache (both
// patterns default → valid → no banner); the host echo re-fires the listener
// with persisted values once global settings load.
const applySetupWarningValidation = (): void => {
  validateSetupWarningPatterns(getGlobalSettings() as Record<string, unknown>);
};
onGlobalSettingsChange(applySetupWarningValidation);
applySetupWarningValidation();

// Initialize the SDK singleton
initializeSDK(adapter.createLogger("iRacingSDK"));

// Initialize the event bus BEFORE any publisher (sim-events-iracing) or
// subscriber (actions) exist. Must land before sdk translator + actions so
// both sides can see the bus.
const eventBus = initializeEventBus(adapter.createLogger("EventBus"));

// Translate sdkController ticks → semantic events on the bus. The only
// package allowed to read `@iracedeck/iracing-sdk` for telemetry.
// The laps-of-fuel-left margin (issue #838) is injected as a live-read
// closure over global settings — sanitized so a malformed persisted value
// can't poison the estimate — keeping sim-events-iracing deck-core-free.
initializeSimEventsIracing(eventBus, getController(), adapter.createLogger("SimEventsIracing"), {
  getFuelLapsLeftMarginLaps: () =>
    sanitizeFuelCalloutMarginLaps((getGlobalSettings() as Record<string, unknown>).fuelCalloutMarginLaps),
  // Corner-name announcement lead (issue #888) — same live-read + sanitize
  // shape as the fuel margin above.
  getCornerCalloutLeadSeconds: () =>
    sanitizeCornerCalloutLeadSeconds((getGlobalSettings() as Record<string, unknown>).cornerCalloutLeadSeconds),
  // Gap alert threshold (issue #933) — read live so a PI slider change takes
  // effect on the next tick without a restart. Clamp mirrors the schema.
  getGapAlertThresholdSeconds: () =>
    sanitizeGapAlertThresholdSeconds((getGlobalSettings() as Record<string, unknown>).gapAlertThresholdSeconds),
  // Consistency gate (issue #933 follow-up) — minimum gap movement in the
  // announced direction from its extreme since the side's last call. 0
  // disables.
  getGapMinChangeSeconds: () =>
    sanitizeGapMinChangeSeconds((getGlobalSettings() as Record<string, unknown>).gapCalloutMinChangeSeconds),
  // Opponent-flag opt-ins enforced translator-side (issue #936 review) — a
  // disabled subject must never feed the burst aggregation.
  getOpponentFlagCalloutEnabled: (flag) =>
    (getGlobalSettings() as Record<string, unknown>)[
      OPPONENT_FLAG_CALLOUT_SETTING_KEYS[OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID[flag]]
    ] !== false,
});

// Feed the translator's live per-car race order into the template-context builder
// so Telemetry Display / Chat / Race Admin driver prefixes report the same
// continuously-updating positions (overall + class) as the Session Info display,
// for every car (issue #700).
getController().setLivePositionsProvider(() => getLiveRacePositions());

// Initialize keyboard for hotkey actions with scan code support for non-US layouts
const native = new IRacingNative();
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
  (chords, holdMs) => native.sendScanKeySequence(chords, holdMs),
);

// Initialize clipboard for paste-based action flows (e.g. race-admin "Type in Chat").
// Pasting itself uses the keyboard service above (Ctrl+V).
initializeClipboard(adapter.createLogger("Clipboard"), (text) => native.setClipboardText(text));

// Rasterize device-bound SVG icons to PNG in-plugin (#642). When the flag is
// off, the service stays uninitialized and adapters pass SVG through as before.
if (__FEATURE_PNG_RASTERIZATION__) {
  const rasterizerLogger = adapter.createLogger("Rasterizer");

  try {
    initializeRasterizer(createSvgRasterizer({ fontsDir: join(__binDir, "..", "assets", "fonts") }), rasterizerLogger);
  } catch (err) {
    // Fonts missing or resvg init failed — stay uninitialized so adapters
    // fall back to sending SVG, instead of crashing the whole plugin.
    rasterizerLogger.warn(`PNG rasterization disabled: ${err}`);
  }
}

// Initialize audio engine for pit crew voice playback.
// Base path lets scenarios emit manifest-relative clip paths (e.g.
// "sfx/IRD-tick-open.mp3") that audio-service prepends with the plugin's
// assets/audio directory before passing them to the native engine.
// Resolved from __binDir (→ <sdPlugin>/bin/) so lookup is stable
// regardless of the launching process's cwd.
const audioNative = new AudioNative();
const audioRootDir = join(__binDir, "..", "assets", "audio");

// The plugin's own assets are always the first, highest-precedence audio root;
// `voicePacks.refresh()` below extends the list with one root per installed
// voice pack (issue #1034).
initializeAudio(adapter.createLogger("Audio"), audioNative, [audioRootDir]);
getAudio().init();

const featureGateLogger = adapter.createLogger("FeatureGates");

// Plugin-level audio-state syncer (issue #515). See iracing-plugin-stream-deck
// plugin.ts for the full rationale — Pit Crew's per-action listener only
// fires when a button is mounted; this one always runs, so the audio
// buses + radar engine track the master toggles even on a no-button deck.
const applyAudioState = (): void => {
  applyRadarVolume();
  applyRadarEnabled();
  applyRaceEngineerAudio();
};

onGlobalSettingsChange(applyAudioState);

// Live Race Engineer / Radar gate changes (#1007). `applyAudioState` above
// re-applies the bus volumes on every settings arrival; this listener adds the
// side effects only a gate CHANGE should have — stopping in-flight scenarios
// and the spoken acknowledgment — so the settings window's live checkboxes
// behave exactly like a Pit Crew toggle key. Dormant until
// `armFeatureGateSync()` runs in the first-arrival block below, so applying
// the startup policies is silent.
onGlobalSettingsChange(() => syncFeatureGates(featureGateLogger));
applyAudioState();

// The available Race Engineer voices and driver-name keys, derived from the
// ACTIVE manifest. Installed voice packs (issue #1034) make that manifest
// dynamic: the compiled-in one is the built-in half — sfx plus any bundled
// voice — and each installed pack contributes its own audio root and its own
// clips on top. Rescanned on demand, so a hand-placed pack needs a button
// press in Settings rather than a restart.
let activeManifest: AudioAssetsManifest = audioAssetsManifest;
let raceEngineerVoices = scanRaceEngineerVoices(activeManifest);
let driverNames = scanDriverNames(activeManifest);

// The voices the plugin itself bundles — fixed for the process, since they come
// from the compiled-in manifest. No pack may claim one of these.
const bundledVoices = scanRaceEngineerVoices(audioAssetsManifest);

const voicePacksLogger = adapter.createLogger("VoicePacks");
// Named once: the scanner reads this directory and the settings window's
// "Open folder" button reveals it, and those must be the same place. The page
// supplies no path for either (#1100).
const voicePacksRoot = resolveVoicePacksPath({ env: process.env });
// One scanner port for the scan AND the installer (#1100): the installer reads
// `.install.json`, a staged manifest and the bundled clip tree through it.
const voicePackFs = createVoicePackFileSystem(voicePacksLogger);
const voicePacks = createVoicePackService({
  root: voicePacksRoot,
  fs: voicePackFs,
  logger: voicePacksLogger,
  pluginAudioDir: audioRootDir,
  reservedVoices: bundledVoices,
  applyRoots: (roots) => getAudio().setRoots(roots),
  applyManifest: (fragments) => {
    activeManifest = mergeManifests(audioAssetsManifest, fragments);
    raceEngineerVoices = scanRaceEngineerVoices(activeManifest);
    driverNames = scanDriverNames(activeManifest);

    // Guarded because the first scan runs BEFORE the engine is constructed, so
    // startup needs no reload — every later refresh does.
    if (isAudioScenariosInitialized()) getScenarioEngine().setManifest(activeManifest);
  },
  onPacksChanged: () => {
    // The first scan runs long before `initGlobalSettings`, and a write made
    // then would set the dedupe markers below while reaching nothing — which
    // would suppress the real push forever. The post-init call sites publish
    // the startup scan; every later refresh publishes itself.
    //
    // This guard is also what keeps the startup scan away from the dedupe
    // markers themselves: they are `let`s declared FURTHER DOWN this module, so
    // reaching a push function from here before `initGlobalSettings` runs would
    // be a temporal-dead-zone ReferenceError, not a wasted write. Keep
    // `initGlobalSettings` after `voicePacks.refresh()`, or hoist the markers.
    if (!isGlobalSettingsInitialized()) return;

    pushRaceEngineerVoicesIfChanged();
    pushDriverNamesIfChanged();
    pushVoicePackListIfChanged();
  },
});

voicePacks.refresh();

// Downloadable voice packs (#1100). The pipeline itself — decide, lock,
// download while hashing, verify, extract, validate, stop playback, swap,
// refresh — lives in deck-core (`createVoicePackInstaller`); this is its
// composition root, and everything platform-shaped is injected here in the
// shape `voicePacks` above established. Every disk port is rooted at the SAME
// `voicePacksRoot` the scanner reads and the settings window reveals.
const voicePackStorage = createVoicePackStorage({
  root: voicePacksRoot,
  fs: createVoicePackStorageFileSystem(voicePacksLogger),
  logger: voicePacksLogger,
});

const voicePackCatalog = createVoicePackCatalogService({
  // Constant TRUE — settled for this release: there is no setting gating the
  // catalog, and none is added here. Every catalog fetch this build makes is
  // user-initiated — the settings window being put on screen (`openSettingsWindow`
  // below), the Rescan button, and Install, which looks the pressed entry up in
  // the same cache — so there is nothing to opt out of. Nothing asks
  // iracedeck.com at launch, with one bounded exception: the installer re-asks
  // the catalog after every promote so the card's verdicts follow, and the seed
  // of the bundled pack is a promote — once per installation, on the one start
  // that finds an empty packs folder, never per launch.
  //
  // Stage 3 of #1034 changes that, and this is the obligation whoever does it
  // inherits: once the bundled voice is dropped from the distributable, first
  // run must fetch the catalog at launch, unprompted — a fresh install has no
  // engineer until it does — and at that point "no setting" becomes "phones
  // home every launch". Give this gate a real setting THEN, read live the way
  // `updateCheck` gates the changelog feed (the service reads the predicate on
  // every call precisely so that switching it off stops outbound requests
  // without a restart), rather than leaving it at `true` by omission.
  isEnabled: () => true,
  getPluginVersion,
  // ONE implementation of "which digest is installed?", shared with the
  // installer's own decision. This verdict is what puts Install / Update /
  // Installed on the card, and the installer's copy of the same read decides
  // whether pressing it downloads anything; two implementations would
  // eventually disagree silently.
  getInstalledSha: (id) => readInstalledVoicePackSha(voicePackFs, voicePackStorage.packDir(id), id),
  logger: adapter.createLogger("VoicePackCatalog"),
});

// The catalog entries compiled into this build, so a pack the plugin still
// ships can be SEEDED — copied into an empty packs folder with the catalog's
// own `sha256` as its provenance, which is what makes the first catalog check
// after a seed answer "installed" rather than re-download what was just
// copied. The seed is inert for this release (plugin-root-first resolution
// means the bundle still provides every clip); its purpose is that the NEXT
// release, which stops shipping audio, needs no network for anyone.
//
// Importing an entry does NOT decide that its pack is bundled. That is decided
// once, in `@iracedeck/audio-assets`'s `voice-packs.mjs`, and reaches this
// process as the clips the build copied into `assets/audio` and the manifest
// it compiled in — `bundledVoices` above, the same set the scanner reserves.
// An entry whose voices that set does not cover is a published pack this
// build does not carry, and is simply not seeded. So stage 3's one-word flip
// needs no edit here: the import goes stale and inert, nothing more.
const compiledInVoicePackEntries: readonly unknown[] = [defaultVoicePackCatalogEntry];
const bundledVoicePacks: BundledVoicePack[] = [];

for (const candidate of compiledInVoicePackEntries) {
  // safeParse, never parse: this runs at module scope, and a malformed
  // committed entry must cost the seed, not the plugin process.
  const parsed = VoicePackCatalogEntrySchema.safeParse(candidate);

  if (!parsed.success) {
    voicePacksLogger.warn("A compiled-in voice pack catalog entry is invalid; that pack will not be seeded");
    voicePacksLogger.debug(parsed.error.message);
    continue;
  }

  if (!parsed.data.voices.every((voice) => bundledVoices.includes(voice.id))) {
    voicePacksLogger.debug(`Voice pack "${parsed.data.id}" is published, not bundled; not seeded`);
    continue;
  }

  bundledVoicePacks.push({ entry: parsed.data, audioDir: audioRootDir });
}

// `_voicePackStatus` is run-scoped (#1014). Deduped by content like the
// sibling pushes above, so the re-assertion on every Property Inspector
// appearance costs a write only when the payload actually moved — the cache
// holds the last published value for the whole run either way.
let lastPublishedVoicePackStatusJson = "";

const voicePackInstaller = createVoicePackInstaller({
  storage: voicePackStorage,
  packFs: voicePackFs,
  archiveFs: createVoicePackArchiveFileSystem(voicePacksLogger),
  fs: createVoicePackInstallerFileSystem(voicePacksLogger),
  catalog: voicePackCatalog,
  bundled: bundledVoicePacks,
  getPluginVersion,
  // Called immediately before a swap or a removal, and only then: on Windows a
  // directory with an open file inside cannot be renamed, and a callout may be
  // holding one of the pack's clips open. Two layers, because a voice reaches
  // the Voice channel by two routes. The scenario engine — a callout
  // mid-sequence, whose pause timer would otherwise play its NEXT clip straight
  // into the swap, plus its looping ambient bed — is stopped through the same
  // call the Race Engineer master gate uses. The audio service's own channel
  // stop then covers anything on the Voice channel that never went through the
  // engine: the settings window's voice Test plays clip by clip via
  // `playOnChannel`, and `stopChannel` also cancels a native voice sequence.
  // One call: stopping the engineer is three coupled facts about audio state,
  // and it lives with that state rather than being restated in three plugins.
  stopPlayback: stopRaceEngineerPlayback,
  publishStatus: (status) => {
    const json = JSON.stringify(status);

    if (json === lastPublishedVoicePackStatusJson) return;

    lastPublishedVoicePackStatusJson = json;
    updateGlobalSettings({ [VOICE_PACK_STATUS_KEY]: json });
  },
  refreshPacks: () => voicePacks.refresh(),
  logger: voicePacksLogger,
});

// Initialize the scenario engine AFTER audio (so it can drive playback) but
// BEFORE actions register (so actions see a ready engine when they wire PI
// toggles and Test buttons to setEnabled / fire).
//
// `getActiveVoice` resolves at clip-resolution time so a PI voice change
// takes effect on the next scenario fire without re-initialising the engine.
initializeAudioScenarios(eventBus, getAudio(), activeManifest, adapter.createLogger("AudioScenarios"), () =>
  resolveActiveRaceEngineerVoice(raceEngineerVoices),
);

// Cache the most recent `lap.completed` payload so the lap-time scenario's
// var resolvers can read frozen lap data at fire time (issue #555).
// Subscribed BEFORE `registerPitCrew` (which subscribes the scenario engine
// to the same event via `defineScenario`) so this listener runs first and
// the cache is up-to-date by the time the scenario evaluates its
// `where:` predicate. The 2 000 ms initial pause in the scenario sequence
// further guarantees the cache is populated by the time the var resolvers
// run.
const lapCompletedLogger = adapter.createLogger("LapCompleted");
let lastLapCompleted: LapCompletedSnapshot | null = null;
eventBus.subscribe("lap.completed", (ev) => {
  lastLapCompleted = ev.data;
  lapCompletedLogger.info(
    `lap=${ev.data.lap} time=${ev.data.lapTime.toFixed(3)} isBest=${ev.data.isBest} isFirstValid=${ev.data.isFirstValid} ` +
      `sessionType=${ev.data.sessionType ?? "?"} position=${ev.data.position ?? "?"} previousPosition=${ev.data.previousPosition ?? "?"} ` +
      `classPosition=${ev.data.classPosition ?? "?"} previousClassPosition=${ev.data.previousClassPosition ?? "?"} ` +
      `isMultiClass=${ev.data.isMultiClass ?? "?"} lapsSincePositionChange=${ev.data.lapsSincePositionChange ?? "?"}`,
  );
  lapCompletedLogger.debug(`payload: ${JSON.stringify(ev.data)}`);
});

// Cache the most recent `cornerName.approaching` payload so the corner-name
// scenario's clip resolver reads it at fire time (issue #888) — the lap-time
// subscription pattern. Subscribed BEFORE registerPitCrew so this listener
// runs first and the cache is fresh when the scenario evaluates.
let lastCornerName: CornerNameSnapshot | null = null;
eventBus.subscribe("cornerName.approaching", (ev) => {
  lastCornerName = ev.data;
});

// Cache the most recent `race.finished` payload so the race-end scenario's
// snapshot resolver can compose it with the PI-picked driver name at fire
// time (issue #569). Subscribed BEFORE `registerPitCrew` so this listener
// runs before the scenario engine's subscriber — by the time the scenario
// evaluates its `where:` predicate the cache holds the just-fired payload.
const raceFinishedLogger = adapter.createLogger("RaceFinished");
let lastRaceFinished: { position: number; classPosition?: number; isMultiClass?: boolean } | null = null;
eventBus.subscribe("race.finished", (ev) => {
  lastRaceFinished = ev.data;
  raceFinishedLogger.info(
    `position=${ev.data.position} classPosition=${ev.data.classPosition ?? "?"} isMultiClass=${ev.data.isMultiClass ?? "?"}`,
  );
});

// Log overtake events for debugging (issue #574). Reactions read `isLeader`
// off the event payload and the position readouts read LIVE telemetry via
// `getLivePosition()`, so no per-event cache is needed — just observability.
// Mirrors the Stream Deck plugin.
const overtakeLogger = adapter.createLogger("Overtake");
eventBus.subscribe("overtake.completed", (ev) => {
  overtakeLogger.info(
    `gained position=${ev.data.position} previousPosition=${ev.data.previousPosition} isLeader=${ev.data.isLeader} ` +
      `gapBehindMeters=${ev.data.gapBehindMeters?.toFixed(1) ?? "?"} sustained=${ev.data.sustained}`,
  );
});
eventBus.subscribe("overtake.lost", (ev) => {
  overtakeLogger.info(
    `lost position=${ev.data.position} previousPosition=${ev.data.previousPosition} ` +
      `gapAheadMeters=${ev.data.gapAheadMeters?.toFixed(1) ?? "?"} sustained=${ev.data.sustained}`,
  );
});

// Track the most recent incident so the overtake gate can suppress callouts
// for a swap caused by an incident (issue #574 follow-up). Mirrors the Stream
// Deck plugin.
let lastIncidentAt: number | null = null;
eventBus.subscribe("incident.occurred", () => {
  lastIncidentAt = Date.now();
});

const getOvertakeGate = (): OvertakeGate | null => {
  const gate = getOvertakeTelemetryGate();

  if (!gate) return null;

  return { ...gate, msSinceIncident: lastIncidentAt === null ? null : Date.now() - lastIncidentAt };
};

// Live speak-time position resolver shared by the opponent-pit (#622) and
// opponent-flag (#936) families — one definition so the projection/fallback
// logic can never drift (#936 review).
const resolvePendingCarLivePosition = (pending: {
  carIdx: number;
  position: number;
  isMultiClass: boolean;
}): number | null => {
  const live = getLiveCarPosition(pending.carIdx);

  if (!live) return null;

  const n = pending.isMultiClass ? live.classPosition : live.position;

  return n > 0 ? n : null;
};

// Every opt-in below is a live-reading closure: the gate runs at
// event-arrival time inside the scenario engine, before fire/expand, so a
// mid-session toggle takes effect on the next event without re-registering
// scenarios and without cutting a callout already playing. Per-key rationale
// lives on `PitCrewDeps` in @iracedeck/audio-scenarios.
registerPitCrew(eventBus, {
  getFlagCalloutEnabled: (id: FlagCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
  logger: adapter.createLogger("PitCrewScenarios"),
  getPitReadbackEnabled: (id: PitReadbackCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_READBACK_CALLOUT_SETTING_KEYS[id]] !== false,
  getPitActionsAllowed: () => isPitActionsAllowed(),
  getPitServiceRequestsEnabled: () =>
    (getGlobalSettings() as Record<string, unknown>).calloutEnabledPitServiceRequests !== false,
  getReadbackSnapshot: () => getReadbackSnapshot(),
  getDamageCalloutEnabled: (id: DamageCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[DAMAGE_CALLOUT_SETTING_KEYS[id]] !== false,
  getPitStatusCalloutEnabled: (id: PitStatusCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
  getTrackConditionsCalloutEnabled: (id: TrackConditionsCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[TRACK_CONDITIONS_CALLOUT_SETTING_KEYS[id]] !== false,
  getIncidentCalloutEnabled: (id: IncidentCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[INCIDENT_CALLOUT_SETTING_KEYS[id]] !== false,
  getSessionStartCalloutEnabled: (id: SessionStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SESSION_START_CALLOUT_SETTING_KEYS[id]] !== false,
  getSessionStartSnapshot: () => {
    const conditions = getSessionStartConditions();

    if (!conditions) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...conditions, driverName } : null;
  },
  getLapTimeCalloutEnabled: (id: LapTimeCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[LAP_TIME_CALLOUT_SETTING_KEYS[id]] !== false,
  getLapCompletedSnapshot: () => lastLapCompleted,
  getPositionCalloutEnabled: (id: PositionCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[POSITION_CALLOUT_SETTING_KEYS[id]] !== false,
  getQualifyingInvalidationCalloutEnabled: (id: QualifyingInvalidationCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS[id]] !== false,
  getQualifyingInvalidationSnapshot: () => getQualifyingInvalidationSnapshot(),
  getRaceStatusCalloutEnabled: (id: RaceStatusCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
  getRaceFinishedFired: () => isRaceFinished(),
  getRaceEndCalloutEnabled: (id: RaceEndCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_END_CALLOUT_SETTING_KEYS[id]] !== false,
  getRaceFinishedSnapshot: (): RaceFinishedSnapshot | null => {
    if (!lastRaceFinished) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...lastRaceFinished, driverName } : null;
  },
  getRaceStartCalloutEnabled: (id: RaceStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_START_CALLOUT_SETTING_KEYS[id]] !== false,
  getRaceStartSnapshot: () => {
    const conditions = getRaceStartConditions();

    if (!conditions) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...conditions, driverName } : null;
  },
  getOvertakeCalloutEnabled: (id: OvertakeCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OVERTAKE_CALLOUT_SETTING_KEYS[id]] !== false,
  getOvertakeDriverName: () => resolveActiveDriverName(driverNames, "driver"),
  getLivePosition: () => getLivePosition(),
  getOvertakeGate: getOvertakeGate,
  getPitBoxCalloutEnabled: (id: PitBoxCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_BOX_CALLOUT_SETTING_KEYS[id]] !== false,
  getSetupWarningMismatch: (kind) =>
    evaluateSetupWarning(kind, getGlobalSettings() as Record<string, unknown>, getDriverSetupName()),
  getSpotterCalloutEnabled: (id: SpotterCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SPOTTER_CALLOUT_SETTING_KEYS[id]] !== false,
  getSpotterTrackDirection: () => getTrackDirection(),
  getSpotterStillThereIntervalMs: () =>
    resolveStillThereIntervalMs((getGlobalSettings() as Record<string, unknown>)[SPOTTER_STILL_THERE_SECONDS_KEY]),
  getSpotterNearestCarGapMeters: () => getNearestCarGapMeters(),
  getPitWindowCalloutEnabled: (id: PitWindowCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_WINDOW_CALLOUT_SETTING_KEYS[id]] !== false,
  getRollingStartCalloutEnabled: (id: RollingStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[ROLLING_START_CALLOUT_SETTING_KEYS[id]] !== false,
  getStartLightCalloutEnabled: (id: StartLightCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[START_LIGHT_CALLOUT_SETTING_KEYS[id]] !== false,
  getFuelCalloutEnabled: (id: FuelCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[FUEL_CALLOUT_SETTING_KEYS[id]] !== false,
  getCornerNameCalloutEnabled: (id: CornerNameCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[CORNER_NAME_CALLOUT_SETTING_KEYS[id]] !== false,
  getCornerNameSnapshot: () => lastCornerName,
  getOpponentPitCalloutEnabled: (id: OpponentPitCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_PIT_CALLOUT_SETTING_KEYS[id]] !== false,
  getOpponentPitLivePosition: resolvePendingCarLivePosition,
  getGapCalloutEnabled: (id: GapCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[GAP_CALLOUT_SETTING_KEYS[id]] !== false,
  getGapCooldownMs: () =>
    resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
  getLiveGaps: () => getLiveGaps(),
  getOpponentFlagCalloutEnabled: (id: OpponentFlagCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
  getOpponentFlagLivePosition: resolvePendingCarLivePosition,
  getPitSpeedingCalloutEnabled: (id: PitSpeedingCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_SPEEDING_CALLOUT_SETTING_KEYS[id]] !== false,
  getPitLimiterCalloutEnabled: (id: PitLimiterCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_LIMITER_CALLOUT_SETTING_KEYS[id]] !== false,
  getNoLimiterCalloutEnabled: (id: NoLimiterCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[NO_LIMITER_CALLOUT_SETTING_KEYS[id]] !== false,
  getRaceEngineerMasterEnabled: () =>
    (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
  getRadarMasterEnabled: () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
});

// Publish audio device list and apply saved device selection.
// See `iracing-plugin-stream-deck/src/plugin.ts` for the persistence
// contract (id-based; empty string = System Default; legacy values fall
// back to default without rewriting the persisted setting) and the
// recursion-safety note around the listener re-entry.
let initialDevicePushDone = false;
let startupDefaultsApplied = false;
let currentAudioDeviceId: string = "";
// Cache the last pushed payload so identical re-enumerations (the common
// case on repeated PI re-opens with no hardware change) don't churn the
// sdpi-components data source and force a full dropdown re-render.
let lastPushedDeviceListJson = "";

function pushAudioDevicesIfChanged(): void {
  const devices = getAudio().getAudioDevices();
  const json = JSON.stringify(devices);

  if (json === lastPushedDeviceListJson) return;

  lastPushedDeviceListJson = json;
  updateGlobalSettings({ _audioDeviceList: json });
}

// Push the Race Engineer voices + names lists to global settings. Both
// payloads are derived from the ACTIVE manifest, which changes whenever voice
// packs are rescanned (issue #1034), so each list is stringified per call
// rather than once at module scope. Re-pushed on every PI appear too (cheap;
// deduped below) so a PI opened before the first global-settings echo still
// gets populated.
let lastPushedVoiceListJson = "";
let lastPushedVoiceLabelsJson = "";

// The voice LIST and the voice LABELS go out in one write, always. The list is
// what exists — derived from the merged manifest's clip paths, and what
// `resolveActiveRaceEngineerVoice` consumes; the labels are what a pack chose to
// call those voices, and nothing resolves or persists them. Publishing them
// together is what stops a dropdown ever pairing one scan's voices with another
// scan's names.
function pushRaceEngineerVoicesIfChanged(): void {
  const json = JSON.stringify(raceEngineerVoices);
  const labelsJson = JSON.stringify(voiceLabels());

  if (json === lastPushedVoiceListJson && labelsJson === lastPushedVoiceLabelsJson) return;

  lastPushedVoiceListJson = json;
  lastPushedVoiceLabelsJson = labelsJson;
  updateGlobalSettings({ _raceEngineerVoices: json, [VOICE_LABELS_KEY]: labelsJson });
}

/**
 * Voice id -> what the dropdown should call it. The rule lives in deck-core
 * (`voiceDisplayLabels`) so all three plugins share one implementation and it is
 * tested once. Only voices a pack provides appear; the bundled voice has no
 * manifest and needs no entry, because the dropdown falls back to
 * `titleCase(id)`.
 */
function voiceLabels(): Record<string, string> {
  return voiceDisplayLabels(voicePacks.installed());
}

let lastPushedDriverNameListJson = "";

function pushDriverNamesIfChanged(): void {
  const json = JSON.stringify(driverNames);

  if (json === lastPushedDriverNameListJson) return;

  lastPushedDriverNameListJson = json;
  updateGlobalSettings({ _driverNames: json });
}

let lastPushedVoicePackListJson = "";

// One payload for the whole scan result, installed packs AND the reasons the
// rest were ignored (#1034). A hand-placed pack that silently does nothing is
// this feature's most likely support question, and the reason is the answer —
// so it belongs beside the list rather than only in the plugin log. Both halves
// travel in one key so they can never be published out of step, and a scan
// stays one global-settings write.
function pushVoicePackListIfChanged(): void {
  const json = JSON.stringify({
    packs: voicePacks.installed().map((pack) => ({
      id: pack.id,
      label: pack.label,
      version: pack.version,
      voices: pack.voices,
      // Where it came from, for the settings window's provenance badge
      // (#1100). Displayed, never enforced.
      provenance: pack.provenance,
    })),
    problems: voicePacks.problems().map((problem) => ({ pack: problem.pack, reason: problem.reason })),
  });

  if (json === lastPushedVoicePackListJson) return;

  lastPushedVoicePackListJson = json;
  updateGlobalSettings({ [VOICE_PACKS_KEY]: json });
}

const versionCheckLogger = adapter.createLogger("VersionCheck");

// Changelog version check (issues #680, #742, #870). Builds its inputs from
// the LIVE settings cache on every call, because it runs at two different
// moments: once ~15 s after the first global-settings arrival (the #870
// startup grace that lets the sim-running signals settle), and again whenever
// iRacing exits — a due changelog is never opened over a live session, it
// defers (nothing persisted) and stays pending until the sim is gone.
// `runVersionCheck` is naturally idempotent across these calls: once a
// version is persisted, later calls decide `skip`.
let startupNoticesInFlight: Promise<void> | undefined;

/**
 * Serialises the two entry points below. `runFirstRunCheck` persists only once
 * the window has opened, so its own "already resolved" guard is blind for the
 * whole browser-spawn duration — long enough for the startup-grace timer and an
 * iRacing exit to both decide "open" and spawn two windows.
 */
function runStartupNotices(): Promise<void> {
  startupNoticesInFlight ??= startupNotices().finally(() => {
    startupNoticesInFlight = undefined;
  });

  return startupNoticesInFlight;
}

async function startupNotices(): Promise<void> {
  // Nothing meaningful to compare before the first settings arrival.
  if (!startupDefaultsApplied) return;

  const settings = getGlobalSettings();
  const s = settings as Record<string, unknown>;

  // Reads the last-seen version from the passthrough `_lastSeenVersion` key
  // and persists the running version. No-op for pre-release builds and
  // same/older versions. The VSD Craft protocol exposes no device-type id,
  // so `type` is omitted; opening the browser is best-effort (harmless if
  // the Stream Dock host ignores it). The `changelogNotification` preference
  // (issue #742) decides whether a due changelog opens, is recorded
  // silently, or stays pending (monthly window, anchored on the passthrough
  // `_lastChangelogOpenedAt` key).
  // The first-run check runs FIRST and may consume the start (#1061). That
  // ordering is load-bearing rather than tidy: its evidence for "some build has
  // already started against this store" is the absence of `_lastSeenVersion`,
  // and the changelog check below is precisely what writes that key. It also
  // consumes the start while the settings migration is still pending, so the
  // key stays pristine until the store has settled.
  if (
    await runFirstRunCheck({
      currentVersion: getPluginVersion(),
      firstRunVersion: s[FIRST_RUN_VERSION_KEY],
      lastSeenVersion: s._lastSeenVersion,
      migrationPending: s[MIGRATION_PENDING_KEY],
      isSimRunning: isIRacingActive,
      persist: (partial) => updateGlobalSettings(partial),
      openGettingStarted: () => openSettingsWindow({ pane: GETTING_STARTED_PANE }),
      logger: versionCheckLogger,
    })
  ) {
    return;
  }

  await runVersionCheck({
    currentVersion: getPluginVersion(),
    lastSeenVersion: typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined,
    policy: settings.changelogNotification,
    lastOpenedAt: typeof s._lastChangelogOpenedAt === "number" ? s._lastChangelogOpenedAt : undefined,
    ecosystem: getPluginPlatform(),
    isSimRunning: isIRacingActive,
    persist: (version) => updateGlobalSettings({ _lastSeenVersion: version }),
    persistOpenedAt: (timestamp) => updateGlobalSettings({ _lastChangelogOpenedAt: timestamp }),
    openUrl: (url) => adapter.openUrl(url),
    logger: versionCheckLogger,
  });
}

// Re-run the check when iRacing exits so a changelog deferred mid-session
// opens right after the session ends (issue #870) — on hosts without
// app-monitoring events, via the app monitor's SDK-disconnect fallback. The
// app monitor notifies after the running flag and the SDK connection are
// already down, so the isSimRunning gate reads false here. Gated on an open
// actually being pending: once the version is persisted (or on a pre-release
// build) every later sim exit would otherwise re-run a dead check and log
// "Version up to date" for the whole process lifetime.
onIRacingTerminated(() => {
  const s = getGlobalSettings() as Record<string, unknown>;
  const lastSeen = typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined;

  // Also re-run while the Getting Started page is still unresolved (#1061):
  // on a pre-release build `shouldOpenChangelog` is always false, so without
  // this a first-run open deferred by the sim gate would never be retried.
  if (!s[FIRST_RUN_VERSION_KEY]) {
    void runStartupNotices();

    return;
  }

  if (!shouldOpenChangelog(getPluginVersion(), lastSeen)) return;

  void runStartupNotices();
});

// Plugin-owned global-settings store (issue #993). Declared here — above the
// settings-window controller below, whose command-handler deps read
// settingsStore.path eagerly (not from inside a deferred callback) — so it is
// already initialized wherever it's referenced.
const settingsStore = createFileSettingsStore({
  path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
  logger: adapter.createLogger("SettingsStore"),
});

// Land the last debounced save on the way out. Node runs "exit" handlers
// synchronously, which is exactly why the store has a SYNCHRONOUS flush — the
// async flush() would never get an event-loop turn here. This covers every
// orderly exit, including the Mirabox/Ulanzi clients' outright process.exit(0)
// when their host socket closes. A hard kill by the host can't be caught by
// anything, so a <=250 ms window remains there by construction.
process.on("exit", () => settingsStore.flushSync());

// Settings window (#992): the plugin serves ui/settings-window.html (compiled
// from settings-window.ejs, with settings-window-bridge.js injected before
// sdpi-components.js) over a loopback server started at plugin startup (#993 —
// see the ensureStarted() call below) and opens it as a chromeless app window.
// The page's sdpi-components talks to the server's fake host, which is bound
// here to the real global-settings singleton — so every write goes through
// updateGlobalSettings and lands in the plugin-owned settings store (#993),
// the one persistent copy. Declared here, above the onGlobalSettingsChange
// listener below, because that listener's store-ready block starts the server
// (ensureStarted()).
const settingsWindowLogger = adapter.createLogger("SettingsWindow");
// Mirrors the store + the loopback channel to the deck host once per start
// (#993 phase 2; the channel is never persisted in the store — a stale copy an
// older build left there is removed) — from wherever the server actually
// started (see the onStarted hook below and the store-ready block).
const settingsChannel = createSettingsChannelPublisher({ adapter, logger: settingsWindowLogger });
// Upstream update check (#1016). Asked only by the settings window's What's New
// tab, cached for an hour, and gated on the `updateCheck` setting read live —
// so a user who never opens the window, or who switches the setting off, makes
// no outbound request at all.
const updateCheck = createUpdateCheckService({
  isEnabled: () => getGlobalSettings().updateCheck !== false,
  getInstalledVersion: getPluginVersion,
  logger: adapter.createLogger("UpdateCheck"),
});

const settingsWindow = createSettingsWindowController({
  assetsDir: join(__binDir, "..", "ui"),
  pageFile: SETTINGS_WINDOW_HTML,
  settingsHost: {
    read: () => getGlobalSettings() as Record<string, unknown>,
    write: (partial) => updateGlobalSettings(partial),
    subscribe: (listener) => onGlobalSettingsChange((s) => listener(s as Record<string, unknown>)),
  },
  findBrowser: findChromiumBrowserOnThisMachine,
  spawnApp: spawnAppWindow,
  openUrl: (url) => adapter.openUrl(url),
  // Reopen where the user left it (the page reports bounds on resize).
  getWindowBounds: () =>
    parseSettingsWindowBounds((getGlobalSettings() as Record<string, unknown>)[SETTINGS_WINDOW_BOUNDS_KEY]),
  onSendToPlugin: createSettingsWindowCommandHandler({
    writeSettings: (partial) => updateGlobalSettings(partial),
    // The window's Race Engineer Test buttons — same runner as the Pit Crew action.
    previewAudio: (kind) => {
      if (isAudioPreviewKind(kind)) runAudioPreview(kind, adapter.createLogger("AudioPreview"));
    },
    // Storage card's Open folder button (#993) — the path is always the plugin's own.
    openFolder: openFolderInExplorer,
    storePath: settingsStore.path,
    // Race Engineer card's Rescan voices button (#1034). Like Open folder, the
    // page names no directory — which one is scanned is the plugin's decision.
    // Since #1100 a rescan re-asks the catalog too, so the card's Install /
    // Update / Installed verdicts follow a pack the user added or deleted by
    // hand: the service recomputes them on every call, and the fetch behind
    // them is cached, so this is rarely a second request.
    refreshVoicePacks: () => {
      voicePacks.refresh();
      void voicePackInstaller.refreshCatalog();
    },
    // Install / Remove by pack id (#1100). The handler has validated the id
    // against the manifest's kebab-case rule before it gets here; everything
    // else — the catalog it is looked up in, the URL, the destination — is the
    // plugin's. Neither ever rejects. An install's outcome reaches the card as
    // `_voicePackStatus`; a removal has no status of its own, so its reason is
    // kept in the log.
    installVoicePack: (id) => {
      void voicePackInstaller.install(id);
    },
    removeVoicePack: (id) => {
      void voicePackInstaller.remove(id).then((result) => {
        if (!result.ok) voicePacksLogger.warn(`Voice pack "${id}" was not removed: ${result.reason}`);
      });
    },
    // Same rule again for the Voices card's Open folder button (#1100). A
    // DIRECTORY opener, not the file-revealing one above: `/select` would show
    // the packs folder's parent with `Voices` merely highlighted, one level
    // above where the text beside the button says to drop a pack.
    openDirectory: openDirectoryInExplorer,
    voicePacksPath: voicePacksRoot,
  }),
  // The page can't probe SimHub itself (cross-origin, no CORS) — answer from the plugin's own view.
  simHub: { isReachable: isSimHubReachable, getRoles: () => getSimHub().getRoles() },
  // The page can't reach iracedeck.com itself (cross-origin, no CORS) — answer from the plugin's own check.
  updates: updateCheck,
  onStarted: (channel) => settingsChannel.publish(channel),
  // Surface a settings window the user cannot reach as a PI warning banner
  // instead of leaving them with a button that does nothing (#1005). The
  // controller is the only place that knows WHICH stage failed — a settings
  // service that never bound (error) vs. a machine where no browser would
  // open the page (warning) — and the banner clears as soon as one succeeds.
  onStatus: createSettingsWindowWarningReporter({ getStorePath: () => settingsStore.path }),
  logger: settingsWindowLogger,
});

// Every route that puts the settings window on screen goes through here and
// asks the voice catalog on the way (#1100). The Race Engineer card answers
// "what could I download?" from `_voicePackStatus`, and this is the moment
// that answer is wanted — a user-initiated fetch, which is what lets the
// catalog gate stay a constant (see `voicePackCatalog`). The service caches
// the fetch for an hour, so reopening the window is not a second request;
// the verdicts are recomputed either way. Fire-and-forget on purpose:
// `refreshCatalog` never rejects, and the window must not wait on the network
// to open.
function openSettingsWindow(options?: SettingsWindowOpenOptions): ReturnType<typeof settingsWindow.open> {
  void voicePackInstaller.refreshCatalog();

  return settingsWindow.open(options);
}

onGlobalSettingsChange((settings) => {
  const s = settings as Record<string, unknown>;

  // First time settings arrive, seed the device list so the PI sees the
  // initial enumeration without needing to be opened first. After this
  // the PI-appear hook drives refreshes — `initialDevicePushDone` is just
  // a one-shot gate, not a "never refresh" latch.
  if (!initialDevicePushDone) {
    initialDevicePushDone = true;
    pushAudioDevicesIfChanged();
  }

  // One-shot startup migrations and the per-feature startup policies
  // (issue #1007, replacing the "On startup" defaults of #482 — a policy of
  // `remember-last` now leaves the previous session's gate alone instead of
  // overriding it). The Pit Crew action's own onGlobalSettingsChange listener
  // picks up the echoed runtime keys and re-applies them to the audio buses /
  // radar engine, so no further wiring is needed here.
  //
  // First step is the issue #515 migration: drop the four pre-rename Pit
  // Crew enable keys from persisted storage. Idempotent — once they're
  // gone, subsequent startups skip the write. Runs BEFORE the on-startup
  // defaults below so the renamed `pitCrew*Enabled` keys take their
  // schema defaults (`false`) for everyone, regardless of what the
  // pre-rename keys held.
  // Also gate on the settings store: a write made before it has loaded still
  // notifies listeners (read-your-writes), and running the startup defaults
  // against schema defaults would layer those computed values over the
  // loaded/migrated settings (#993).
  if (!startupDefaultsApplied && isSettingsStoreReady()) {
    startupDefaultsApplied = true;

    deleteGlobalSettings([
      "raceEngineerEnabled",
      "radarEnabled",
      "raceEngineerEnabledOnStartup",
      "radarEnabledOnStartup",
    ]);

    // Issue #657 rename cleanup: the per-callout opt-in
    // `calloutEnabledFlagOneLapToGreen` was renamed to
    // `calloutEnabledFlagOnePaceLapToGo`. Drop the orphaned old key so the new
    // key takes its schema default (on) for everyone — the same "reset to
    // schema default on rename" convention as the #515 keys above. The cue was
    // also re-triggered and re-recorded (effectively new behaviour), so it
    // should default on per the Race Engineer "new functionality defaults on"
    // principle rather than inherit a disable of the old, broken cue.
    deleteGlobalSettings(["calloutEnabledFlagOneLapToGreen"]);

    // Issue #848: the Force Feedback LFE "intensity" modes were retired as
    // duplicates of Wheel/BassShaker LFE (iRacing has one control pair per
    // LFE device, labeled differently across its settings pages). Carry any
    // bindings stored under the retired keys over to the canonical
    // louder/quieter keys (never overwriting a configured one), then drop
    // the retired keys. Idempotent.
    migrateLfeIntensityBindingKeys();

    // Issue #1007: the retired `…EnabledOnStartup` booleans became startup
    // policies. Migrate first so the policies below are the user's real
    // choice, apply them to the live gates, then arm the gate sync — in that
    // order, because arming records the post-write values as already applied
    // and a startup write must never sound like a user toggle.
    migrateStartupPolicies(featureGateLogger);
    applyStartupFeatureGates(featureGateLogger);
    armFeatureGateSync();

    // Open the website changelog once when a newer stable version is
    // detected (issue #680) — via the shared runChangelogVersionCheck above,
    // delayed by the #870 startup grace so a mid-session plugin restart (the
    // deck-host auto-update case) can't run the check before the sim-running
    // signals are up and open the page over a live session.
    setTimeout(() => void runStartupNotices(), VERSION_CHECK_STARTUP_GRACE_MS);

    // #993: the Diagnostics "Storage" card's path is known synchronously (no
    // I/O at construction) — publish it unconditionally here, NOT inside the
    // ensureStarted().then() below, so a bind/firewall failure that rejects
    // the settings server still leaves the path visible for the rest of the
    // process life. That's exactly when a diagnostic aid matters most.
    updateGlobalSettings({ _settingsStorePath: settingsStore.path });

    // #993: the settings server is the channel every UI uses; publish where it
    // is (the ONE host mirror per start — full store + `_settingsChannel` —
    // that the PI bridge bootstraps from; the channel itself is never persisted
    // in the store — see createSettingsChannelPublisher). The
    // controller's onStarted hook publishes a server that starts LATER too (a
    // failed startup bind followed by a successful "Open Settings"), and the
    // publisher is idempotent, so calling it here as well only ensures a
    // server that came up before the store was ready still gets mirrored.
    // Two-arg then: a bind/firewall failure must not crash the plugin process
    // (Node throws on an unobserved rejection). The controller logs it and
    // raises the PI warning banner itself (#1005), so there is nothing left
    // to do here but observe it; publish() logs its own faults and never throws.
    void settingsWindow.ensureStarted().then(
      (channel) => settingsChannel.publish(channel),
      // Mirror the store to the host WITHOUT a channel (#1005). With no server
      // there is nothing for a Property Inspector to connect to, so every PI
      // falls back to reading the deck host's copy — and this is the only write
      // the plugin makes to it. Without this the warning banner the controller
      // just raised would never leave the plugin's own settings file.
      () => settingsChannel.publishUnavailable(),
    );

    // Voice packs (#1100), in this order: empty the installer's working
    // directories of whatever an interrupted run left behind, then seed the
    // bundled pack into an empty packs folder, then assert what this run
    // knows about downloadable packs — nothing asked yet, nothing in flight,
    // or the seed's own outcome — so `_voicePackStatus` exists in the cache
    // from the start rather than the moment something first happens. The
    // catalog is deliberately not fetched here; see `isEnabled` on
    // `voicePackCatalog` for why, and `openSettingsWindow` for where it is.
    // Every step is written never to reject; the catch is the last line of
    // that promise, and logs rather than lets Node see an unobserved
    // rejection on the startup path.
    void voicePackInstaller
      .sweep()
      .then(() => voicePackInstaller.seed())
      .then(() => voicePackInstaller.republishStatus())
      .catch((err: unknown) => voicePacksLogger.error(`Voice pack startup failed: ${String(err)}`));
  }

  pushRaceEngineerVoicesIfChanged();
  pushDriverNamesIfChanged();
  pushVoicePackListIfChanged();

  // Apply audio output device (on startup and when changed from PI)
  const saved = s.audioOutputDevice;
  const deviceId = typeof saved === "string" ? saved : "";

  if (deviceId === currentAudioDeviceId) return;

  currentAudioDeviceId = deviceId;

  if (deviceId === "") {
    getAudio().setAudioDevice(-1);
  } else {
    const ok = getAudio().setAudioDeviceById(deviceId);

    if (!ok) {
      getAudio().setAudioDevice(-1);
    }
  }
});

// Re-enumerate audio devices on every PI open so a headset plugged in
// after VSD Craft booted appears without a full restart. The
// `pushAudioDevicesIfChanged` guard short-circuits the common case (PI
// reopened, no hardware changed) so the sdpi-components data source
// doesn't churn.
adapter.onPropertyInspectorDidAppear(() => {
  pushAudioDevicesIfChanged();
  pushRaceEngineerVoicesIfChanged();
  pushDriverNamesIfChanged();
  pushVoicePackListIfChanged();
  // `_voicePackStatus` is run-scoped too, and owes the same re-assertion
  // (#1100). Deduped in publishStatus, so this is free when nothing moved.
  voicePackInstaller.republishStatus();
});

// Initialize window focus service for focusing iRacing before any action
initWindowFocus(adapter.createLogger("WindowFocus"), () => native.focusIRacingWindow());

// Initialize the mouse pointer service for the Mouse to Sim mode (#926)
initMousePointer(adapter.createLogger("MousePointer"), (x, y) => native.moveMouseToIRacingWindow(x, y));

// Focus iRacing window before any action executes (when enabled in global settings)
// MUST be registered BEFORE actions so the listener fires first.
adapter.onKeyDown(() => focusIRacingIfEnabled());
adapter.onDialDown(() => focusIRacingIfEnabled());
adapter.onDialRotate(() => focusIRacingIfEnabled());

// Register core actions via the platform adapter
adapter.registerAction(AI_SPOTTER_CONTROLS_UUID, new AiSpotterControls(adapter.createLogger("AiSpotterControls")));
adapter.registerAction(AUDIO_CONTROLS_UUID, new AudioControls(adapter.createLogger("AudioControls")));
adapter.registerAction(BLACK_BOX_SELECTOR_UUID, new BlackBoxSelector(adapter.createLogger("BlackBoxSelector")));
adapter.registerAction(CAMERA_CONTROLS_UUID, new CameraControls(adapter.createLogger("CameraControls")));
// Legacy UUID — existing Camera Cycle buttons continue to work after merge into Camera Controls
adapter.registerAction(
  "com.iracedeck.sd.core.camera-cycle",
  new CameraControls(adapter.createLogger("CameraControls")),
);
adapter.registerAction(
  CAMERA_EDITOR_ADJUSTMENTS_UUID,
  new CameraEditorAdjustments(adapter.createLogger("CameraEditorAdjustments")),
);
adapter.registerAction(
  CAMERA_EDITOR_CONTROLS_UUID,
  new CameraEditorControls(adapter.createLogger("CameraEditorControls")),
);
adapter.registerAction(CAR_CONTROL_UUID, new CarControl(adapter.createLogger("CarControl")));
adapter.registerAction(CHAT_UUID, new Chat(adapter.createLogger("Chat")));
adapter.registerAction(COCKPIT_MISC_UUID, new CockpitMisc(adapter.createLogger("CockpitMisc")));
adapter.registerAction(FORCE_FEEDBACK_UUID, new ForceFeedback(adapter.createLogger("ForceFeedback")));
adapter.registerAction(FUEL_SERVICE_UUID, new FuelService(adapter.createLogger("FuelService")));
adapter.registerAction(LOOK_DIRECTION_UUID, new LookDirection(adapter.createLogger("LookDirection")));
adapter.registerAction(MEDIA_CAPTURE_UUID, new MediaCapture(adapter.createLogger("MediaCapture")));
adapter.registerAction(PIT_CREW_UUID, new PitCrew(adapter.createLogger("PitCrew")));
adapter.registerAction(PIT_QUICK_ACTIONS_UUID, new PitQuickActions(adapter.createLogger("PitQuickActions")));
adapter.registerAction(RACE_ADMIN_UUID, new RaceAdmin(adapter.createLogger("RaceAdmin")));
adapter.registerAction(REPLAY_CONTROL_UUID, new ReplayControl(adapter.createLogger("ReplayControl")));
adapter.registerAction(REPLAY_NAVIGATION_UUID, new ReplayNavigation(adapter.createLogger("ReplayNavigation")));
adapter.registerAction(REPLAY_SPEED_UUID, new ReplaySpeed(adapter.createLogger("ReplaySpeed")));
adapter.registerAction(REPLAY_TRANSPORT_UUID, new ReplayTransport(adapter.createLogger("ReplayTransport")));
adapter.registerAction(SESSION_INFO_UUID, new SessionInfo(adapter.createLogger("SessionInfo")));
adapter.registerAction(SETUP_AERO_UUID, new SetupAero(adapter.createLogger("SetupAero")));
adapter.registerAction(SETUP_BRAKES_UUID, new SetupBrakes(adapter.createLogger("SetupBrakes")));
adapter.registerAction(SETUP_CHASSIS_UUID, new SetupChassis(adapter.createLogger("SetupChassis")));
adapter.registerAction(SETUP_ENGINE_UUID, new SetupEngine(adapter.createLogger("SetupEngine")));
adapter.registerAction(SETUP_FUEL_UUID, new SetupFuel(adapter.createLogger("SetupFuel")));
adapter.registerAction(SETUP_HYBRID_UUID, new SetupHybrid(adapter.createLogger("SetupHybrid")));
adapter.registerAction(SETUP_TRACTION_UUID, new SetupTraction(adapter.createLogger("SetupTraction")));
adapter.registerAction(SPLITS_DELTA_CYCLE_UUID, new SplitsDeltaCycle(adapter.createLogger("SplitsDeltaCycle")));
adapter.registerAction(TELEMETRY_CONTROL_UUID, new TelemetryControl(adapter.createLogger("TelemetryControl")));
adapter.registerAction(TELEMETRY_DISPLAY_UUID, new TelemetryDisplay(adapter.createLogger("TelemetryDisplay")));
adapter.registerAction(TIRE_SERVICE_UUID, new TireService(adapter.createLogger("TireService")));
adapter.registerAction(TOGGLE_UI_ELEMENTS_UUID, new ToggleUiElements(adapter.createLogger("ToggleUiElements")));
adapter.registerAction(VIEW_ADJUSTMENT_UUID, new ViewAdjustment(adapter.createLogger("ViewAdjustment")));

// Initialize global settings listener BEFORE connect - handlers must be registered first.
// settingsStore itself is declared earlier, above the settingsWindow controller.
// The running version lets an abandoned migration be re-asked once after
// an upgrade (#1047). Injected rather than read inside deck-core, which
// must not depend on initPluginConfig() having run.
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore, {
  pluginVersion: getPluginVersion(),
});

// Migrate the pre-#953 spring binding keys (Left/Right -> LR/RR) once real settings arrive
migrateGlobalSettingsKeys(SETUP_CHASSIS_BINDING_KEY_RENAMES, adapter.createLogger("SettingsMigration"));

adapter.onOpenSettingsRequest(() => {
  // Logged and surfaced as a PI warning banner by the controller itself
  // (#1005); observed here only so Node never sees an unobserved rejection.
  void openSettingsWindow().catch(() => undefined);
});

// Initialize SimHub AFTER global settings so health check uses configured host/port
initializeSimHub(adapter.createLogger("SimHub"));

// Initialize binding dispatcher AFTER SimHub so isReady can check reachability
initializeBindingDispatcher(adapter.createLogger("BindingDispatcher"));

// Initialize app monitor for iRacing process detection
initAppMonitor(adapter, adapter.createLogger("AppMonitor"));

// Detect an Administrator/integrity mismatch with iRacing and surface it as a
// PI warning banner (issue #610). Both outcomes are logged at the default log
// level so support logs always capture whether the check ran and what it found
// (issue #902) — see createElevationCheckSubscriber in deck-core.
getController().subscribe(
  "elevation-check",
  createElevationCheckSubscriber({
    getStatus: () => native.getElevationStatus(),
    logger: adapter.createLogger("Elevation"),
  }),
);

// Connect to VSD Craft
adapter.connect();
