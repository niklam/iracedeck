import streamDeck from "@elgato/streamdeck";
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import { AudioNative } from "@iracedeck/audio-native";
import { initializeAudioScenarios, scanDriverNames, scanRaceEngineerVoices } from "@iracedeck/audio-scenarios";
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
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  type OpponentFlagCalloutId,
  type OpponentPitCalloutId,
  OVERTAKE_CALLOUT_SETTING_KEYS,
  type OvertakeCalloutId,
  type OvertakeGate,
  PIT_BOX_CALLOUT_SETTING_KEYS,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  PIT_STATUS_CALLOUT_SETTING_KEYS,
  PIT_WINDOW_CALLOUT_SETTING_KEYS,
  type PitBoxCalloutId,
  type PitReadbackCalloutId,
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
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import {
  createElevationCheckSubscriber,
  createFileSettingsStore,
  createSettingsWindowCommandHandler,
  createSettingsWindowController,
  deleteGlobalSettings,
  evaluateSetupWarning,
  findChromiumBrowserOnThisMachine,
  focusIRacingIfEnabled,
  getController,
  getGlobalSettings,
  getPluginPlatform,
  getPluginVersion,
  getSimHub,
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
  initProfileSwitcher,
  initWindowFocus,
  isIRacingActive,
  isSettingsStoreReady,
  isSimHubReachable,
  migrateGlobalSettingsKeys,
  onGlobalSettingsChange,
  onIRacingTerminated,
  parseSettingsWindowBounds,
  type PluginConfig,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  resolveSettingsStorePath,
  runVersionCheck,
  SETTINGS_WINDOW_BOUNDS_KEY,
  SETTINGS_WINDOW_HTML,
  shouldOpenChangelog,
  spawnAppWindow,
  updateGlobalSettings,
  validateSetupWarningPatterns,
  VERSION_CHECK_STARTUP_GRACE_MS,
} from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import {
  AI_SPOTTER_CONTROLS_UUID,
  AiSpotterControls,
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
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
  SWITCH_PROFILE_UUID,
  SwitchProfile,
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

// Create the Elgato platform adapter
const adapter = new ElgatoPlatformAdapter(streamDeck);

// Default to info-level logging in production; the user opts into verbose
// debug logging from the PI "Enable debug logging" toggle without a rebuild
// (issue #609). streamDeck.logger.setLevel is runtime-mutable, so re-apply on
// every settings change. The initial call reads the schema-default cache
// (debugLogging=false → info); the host echo re-fires the listener with the
// persisted value once global settings load.
const applyDebugLogging = (settings: ReturnType<typeof getGlobalSettings>): void => {
  streamDeck.logger.setLevel(settings.debugLogging ? "debug" : "info");
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
  // disabled subject must never feed the burst aggregation or redirect an
  // enabled subject into a collapsed aggregate. Same live-read pattern as
  // the audio-layer closure in registerPitCrew below; the map translates the
  // bus enum (the meatball is `Repair`) to the callout id's setting key.
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
initializeAudio(adapter.createLogger("Audio"), audioNative, join(__binDir, "..", "assets", "audio"));
getAudio().init();

// Plugin-level audio-state syncer (issue #515). The Pit Crew action also
// runs these helpers from its `onWillAppear` listener — but that path
// only fires when a Pit Crew button is mounted on some page. With no
// button placed, the audio buses stay at the audio-service default
// (1.0) and any voice scenario that slipped past the master gate would
// be audible. Subscribing here means the buses + radar engine state
// always track `pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled`
// regardless of whether a Pit Crew button is on the deck.
//
// `applyAudioState` reads `getGlobalSettings()` directly, so the initial
// invocation below uses the in-memory schema-default cache (master
// toggles `false`, buses muted to 0). When the host echo arrives later,
// the listener re-fires with the persisted values.
const applyAudioState = (): void => {
  applyRadarVolume();
  applyRadarEnabled();
  applyRaceEngineerAudio();
};

onGlobalSettingsChange(applyAudioState);
applyAudioState();

// Derive the available Race Engineer voices and driver-name keys from
// the manifest. Static for the lifetime of the plugin process — the
// manifest is bundled at build time, so these don't change at runtime.
const raceEngineerVoices = scanRaceEngineerVoices(audioAssetsManifest);
const driverNames = scanDriverNames(audioAssetsManifest);

// Initialize the scenario engine AFTER audio (so it can drive playback) but
// BEFORE actions register (so actions see a ready engine when they wire PI
// toggles and Test buttons to setEnabled / fire).
//
// `getActiveVoice` resolves at clip-resolution time, so a PI voice change
// takes effect on the next scenario fire without re-initialising the engine.
initializeAudioScenarios(eventBus, getAudio(), audioAssetsManifest, adapter.createLogger("AudioScenarios"), () =>
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

// Log overtake events for debugging (issue #574). The reaction scenarios read
// `isLeader` straight off the event payload, and the position readouts read
// LIVE telemetry at speak-time via `getLivePosition()` — so no per-event cache
// is needed here, just observability.
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
// for a swap caused by an incident (issue #574 follow-up). `null` until the
// first incident this session.
let lastIncidentAt: number | null = null;
eventBus.subscribe("incident.occurred", () => {
  lastIncidentAt = Date.now();
});

// Compose the overtake gate from live telemetry + the tracked incident time.
// Returns null when telemetry is unavailable (the scenario suppresses).
const getOvertakeGate = (): OvertakeGate | null => {
  const gate = getOvertakeTelemetryGate();

  if (!gate) return null;

  return { ...gate, msSinceIncident: lastIncidentAt === null ? null : Date.now() - lastIncidentAt };
};

// Live speak-time position resolver shared by the opponent-pit (#622) and
// opponent-flag (#936) callout families — one definition so the projection/
// fallback logic can never drift between the two: the car's canonical
// position at speak time, read in the projection the event was classified
// in (the pending stash's isMultiClass, so a transient session-info dropout
// can't flip a multi-class read to overall space). A null return falls back
// to the emit-time payload position.
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

// Pass a live-reading closure so per-flag opt-ins (issue #467) take
// effect mid-session without re-registering scenarios. The gate runs
// at event-arrival time inside the scenario engine, before fire/expand,
// so toggling a flag off does NOT cut a callout that is already
// playing — only future events of that color are suppressed.
registerPitCrew(
  eventBus,
  (id: FlagCalloutId) => (getGlobalSettings() as Record<string, unknown>)[FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
  adapter.createLogger("PitCrewScenarios"),
  // Pit-service readback opt-in (issue #476) — same live-read pattern as
  // flag callouts: gate at event arrival so disabling mid-readback only
  // suppresses future fires.
  (id: PitReadbackCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_READBACK_CALLOUT_SETTING_KEYS[id]] !== false,
  // Pit-action confirmation cooldown (issue #476). Suppresses per-toggle
  // callouts during the 4500 ms post-pit-exit window and the 5000 ms
  // pre-start grid window so phantom flag-cascade events don't surface.
  () => isPitActionsAllowed(),
  // User opt-in for the per-toggle pit-service request confirmations
  // (issue #468). Live read so the toggle takes effect mid-session.
  () => (getGlobalSettings() as Record<string, unknown>).calloutEnabledPitServiceRequests !== false,
  // Pit-readback queued-services snapshot (issue #481). Read fresh on
  // every readback fire so deferred replays speak the current queue,
  // not a snapshot frozen into the original event.
  () => getReadbackSnapshot(),
  // Damage callout opt-in (issue #489) — same live-read pattern as the
  // flag callouts: gate at event arrival so disabling mid-callout only
  // suppresses future fires.
  (id: DamageCalloutId) => (getGlobalSettings() as Record<string, unknown>)[DAMAGE_CALLOUT_SETTING_KEYS[id]] !== false,
  // Pit-service status callout opt-ins (issue #479) — one boolean per
  // non-`None` PlayerCarPitSvStatus. Same live-read pattern as the
  // other callout families.
  (id: PitStatusCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
  // Track-conditions callout opt-in (issue #526). Single subject today
  // (`wetness`); same live-read pattern as the other callout families
  // so toggling off mid-session takes effect on the next event.
  (id: TrackConditionsCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[TRACK_CONDITIONS_CALLOUT_SETTING_KEYS[id]] !== false,
  // Per-incident-type callout opt-ins (issue #530). One boolean per
  // IncidentType subject. Same live-read pattern as the other callout
  // families so toggling a category off mid-session takes effect on the
  // next event without cutting an in-flight clip.
  (id: IncidentCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[INCIDENT_CALLOUT_SETTING_KEYS[id]] !== false,
  // Session-start callout opt-in (issues #542, #668). Single subject; same
  // live-read pattern as the other callout families.
  (id: SessionStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SESSION_START_CALLOUT_SETTING_KEYS[id]] !== false,
  // Session-start conditions snapshot (issue #542). Composes the
  // telemetry-derived conditions from sim-events-iracing with the PI-picked
  // driver name. Returns null (scenario skipped) when conditions aren't
  // available or no driver-name clips exist.
  () => {
    const conditions = getSessionStartConditions();

    if (!conditions) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...conditions, driverName } : null;
  },
  // Lap-time best-lap callout opt-in (issue #555). Single subject; same
  // live-read pattern as the other callout families.
  (id: LapTimeCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[LAP_TIME_CALLOUT_SETTING_KEYS[id]] !== false,
  // Lap-time snapshot resolver (issue #555). Returns the cached
  // `lap.completed` payload populated by the subscription above. The var
  // resolvers read it at sequence-expansion time. Shared with the
  // position-change callout below — both scenarios read the same frozen
  // lap payload.
  () => lastLapCompleted,
  // Position-change callout opt-in (issue #566). Single subject; same
  // live-read pattern as the other callout families.
  (id: PositionCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[POSITION_CALLOUT_SETTING_KEYS[id]] !== false,
  // Qualifying lap-invalidation callout opt-in (issue #567). Single subject;
  // same live-read pattern as the other callout families.
  (id: QualifyingInvalidationCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[QUALIFYING_INVALIDATION_CALLOUT_SETTING_KEYS[id]] !== false,
  // Qualifying lap-invalidation snapshot resolver (issue #567). Built by
  // sim-events-iracing from the latest telemetry tick — same shape as
  // `getReadbackSnapshot` / `getSessionStartConditions`. The translator
  // owns the `lapStartedFromPits` flag and applies the `SessionLapsRemainEx
  // - 1` adjustment so the scenario reads a clean, semantic snapshot.
  () => getQualifyingInvalidationSnapshot(),
  // Race-status callout opt-in (issue #569). Single subject; same live-read
  // pattern as the other callout families.
  (id: RaceStatusCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_STATUS_CALLOUT_SETTING_KEYS[id]] !== false,
  // Race-finished latch resolver (issue #569). Reads the translator's
  // `state.raceFinishedFired`. The race-status scenario's `where:` consults
  // this so the periodic status callout is suppressed on the final lap —
  // race-end fires on the same `lap.completed` tick (the diff publishes
  // `race.finished` first into the pending queue, latch flips synchronously
  // before `lap.completed` publishes).
  () => isRaceFinished(),
  // Race-end callout opt-in (issue #569). Single subject.
  (id: RaceEndCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_END_CALLOUT_SETTING_KEYS[id]] !== false,
  // Race-end snapshot resolver (issue #569). Composes the cached
  // `race.finished` payload with the PI-picked driver name. Returns null
  // (scenario skipped) when the cache is empty or no driver-name clips exist.
  (): RaceFinishedSnapshot | null => {
    if (!lastRaceFinished) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...lastRaceFinished, driverName } : null;
  },
  // Race-start callout opt-in (issue #568). Single subject; same live-read
  // pattern as the other callout families.
  (id: RaceStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_START_CALLOUT_SETTING_KEYS[id]] !== false,
  // Race-start conditions snapshot (issue #568). Composes the telemetry-derived
  // conditions (track temp / air temp / wetness / grid position) from
  // sim-events-iracing with the PI-picked driver name. Returns null (scenario
  // skipped) when conditions aren't yet available or no driver-name clips
  // exist.
  () => {
    const conditions = getRaceStartConditions();

    if (!conditions) return null;

    const driverName = resolveActiveDriverName(driverNames, "driver");

    return driverName ? { ...conditions, driverName } : null;
  },
  // Overtake gain/loss callout opt-ins (issue #574). Per-direction live-read
  // — same gate-at-event-arrival pattern as the other callout families.
  (id: OvertakeCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OVERTAKE_CALLOUT_SETTING_KEYS[id]] !== false,
  // Driver-name resolver for the loss-line "Come on, <name>" composition
  // (issue #574). Reuses the same `resolveActiveDriverName` path as session-
  // start and race-end — falls back to the pre-recorded `"driver"` clip when
  // the user hasn't picked a name in the greeting pool.
  () => resolveActiveDriverName(driverNames, "driver"),
  // Live position resolver (issue #574 follow-up). Powers the "We're currently
  // P[n]" readouts (overtake, race position-change, race-status) — read at
  // speak-time so the spoken position is accurate to the moment it's said.
  () => getLivePosition(),
  // Overtake gate (issue #574 follow-up). Suppresses the whole overtake callout
  // when the swap wasn't a clean racing moment (cars alongside / off-track /
  // crawling / pit road / recent incident). Composed from live telemetry +
  // the tracked incident time above.
  getOvertakeGate,
  // Pit-box count-in opt-in (issue #600). Single subject (`count-in`) gating
  // all six distance-mark scenarios. Same live-read pattern as the other
  // callout families so toggling off mid-session takes effect on the next mark.
  (id: PitBoxCalloutId) => (getGlobalSettings() as Record<string, unknown>)[PIT_BOX_CALLOUT_SETTING_KEYS[id]] !== false,
  // Setup-mismatch warning resolver (issue #625). Live-read at fire time: the
  // opt-in plus the session-kind regex pattern from global settings, tested
  // against the loaded setup name. Consumed by the session-start / race-start
  // intros' `if` clauses, so a mid-session toggle or pattern edit takes effect
  // on the next intro without re-registering scenarios.
  (kind) => evaluateSetupWarning(kind, getGlobalSettings() as Record<string, unknown>, getDriverSetupName()),
  // Spotter per-callout opt-ins (issue #651). The spotter is a Race Engineer
  // callout family — no standalone master; it rides pitCrewRaceEngineerEnabled.
  // Placed before the master gates so the masters stay the last args.
  (id: SpotterCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SPOTTER_CALLOUT_SETTING_KEYS[id]] !== false,
  // Spotter road/oval terminology (issue #651)
  () => getTrackDirection(),
  // Spotter "still there" reminder cadence (issue #651) — 1–10 s, default 3.
  () => resolveStillThereIntervalMs((getGlobalSettings() as Record<string, unknown>)[SPOTTER_STILL_THERE_SECONDS_KEY]),
  // Spotter nearest-car gap for the → clear confirmation buffer (issue #651).
  () => getNearestCarGapMeters(),
  // Pit-window open/closed callout opt-in (issue #655). Single subject covering
  // both directions. Live-read like the other callout families so toggling off
  // mid-session takes effect on the next event. Placed before the rolling-start
  // opt-in so the masters stay last.
  (id: PitWindowCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[PIT_WINDOW_CALLOUT_SETTING_KEYS[id]] !== false,
  // Rolling-start pace-car callout opt-in (issue #660). Live-read like the
  // other callout families so toggling off mid-session takes effect on the
  // next event. Placed before the start-light opt-in so the masters stay last.
  (id: RollingStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[ROLLING_START_CALLOUT_SETTING_KEYS[id]] !== false,
  // Start-light callout opt-ins (issue #480). Two grouped subjects —
  // `lights` (the three gantry lines) and `countdown` (the five numeric
  // marks). Same live-read pattern as the other callout families so toggling
  // off mid-session takes effect on the next event. Placed before the master
  // gates so the masters stay the last args.
  (id: StartLightCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[START_LIGHT_CALLOUT_SETTING_KEYS[id]] !== false,
  // Laps-of-fuel-left callout opt-ins (issue #838). One boolean per spoken
  // count (10 → 1 plus the box call) with non-uniform schema defaults —
  // `!== false` reads the parsed cache, so the OFF-by-default counts resolve
  // through the schema default rather than this fallback. Same live-read
  // pattern as the other callout families. Placed before the master gates so
  // the masters stay the last args.
  (id: FuelCalloutId) => (getGlobalSettings() as Record<string, unknown>)[FUEL_CALLOUT_SETTING_KEYS[id]] !== false,
  // Corner-name callout opt-in (issue #888). Live-read, single subject.
  (id: CornerNameCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[CORNER_NAME_CALLOUT_SETTING_KEYS[id]] !== false,
  // Corner-name snapshot resolver (issue #888) — the cache populated above.
  () => lastCornerName,
  // Opponent-pit callout opt-ins (issue #622). Live-read, two subjects.
  (id: OpponentPitCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_PIT_CALLOUT_SETTING_KEYS[id]] !== false,
  // Opponent-pit live position resolver (issue #622) — shared with the
  // opponent-flag family below so the projection/fallback logic can never
  // drift between the two (#936 review).
  resolvePendingCarLivePosition,
  // Gap callout opt-ins (issue #933). Per-type live-read — same gate-at-
  // event-arrival pattern as the other callout families.
  (id: GapCalloutId) => (getGlobalSettings() as Record<string, unknown>)[GAP_CALLOUT_SETTING_KEYS[id]] !== false,
  // Shared gap-callout cooldown (issue #933) — 1–360 s, default 30 s.
  () => resolveGapCooldownMs((getGlobalSettings() as Record<string, unknown>).gapCalloutCooldownSeconds),
  // Live gaps resolver (issue #933) — the spoken gap number reads the live
  // crossing-time gap at speak time, not the event-time snapshot.
  () => getLiveGaps(),
  // Opponent-flag callout opt-ins (issue #936). Live-read, four subjects.
  (id: OpponentFlagCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[OPPONENT_FLAG_CALLOUT_SETTING_KEYS[id]] !== false,
  // Opponent-flag live position resolver (issue #936) — the same shared
  // resolver as the opponent-pit family above.
  resolvePendingCarLivePosition,
  // Race Engineer master gate (issue #515). Read live so a fresh install
  // (or a deck with no Pit Crew button mounted) suppresses every voice
  // scenario at dispatch time, independent of audio bus volumes.
  () => (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
  // Radar master gate (issue #515). Defense-in-depth alongside the
  // imperative `enabled` flag the radar engine maintains; consulted on
  // every `radar.changed` arrival and every scheduled tick so the
  // engine can't audibly fire when the global toggle is off.
  () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
);

// Publish audio device list and apply saved device selection.
//
// `audioOutputDevice` is persisted as the platform-stable `ma_device_id`
// (hex-encoded) — empty string means System Default. The enumeration index
// is volatile across replug / driver reset / OS audio-preference change, so
// we re-resolve by id every session.
//
// Legacy values from pre-#427 builds (numeric index strings, the literal
// "-1", malformed entries) are treated as unknown and silently fall back
// to System Default. The project is pre-v1 with a single user; no
// migration code is needed.
//
// `currentAudioDeviceId` starts as `""` (System Default) because
// `getAudio().init()` leaves the remembered selection at System Default
// without creating an engine/device (#849) — without this seed, the
// first arrival of `audioOutputDevice = ""` would look like a transition
// and fire a redundant `setAudioDevice(-1)`.
let initialDevicePushDone = false;
let startupDefaultsApplied = false;
// Previous-value trackers for the "On startup" PI checkboxes. Null until
// the first global-settings arrival; on subsequent arrivals a value
// change drives an immediate runtime-key sync (issue #482). Renamed
// from `lastSeenRaceEngineerEnabledOnStartup` /
// `lastSeenRadarEnabledOnStartup` for issue #515.
let lastSeenPitCrewRaceEngineerEnabledOnStartup: boolean | null = null;
let lastSeenPitCrewRadarEnabledOnStartup: boolean | null = null;
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
// payloads are derived from the bundled manifest and never change at
// runtime, but we still re-push on every PI appear (cheap; deduped via
// the caches below) so a PI opened before the first global-settings echo
// still gets populated.
const raceEngineerVoiceListJson = JSON.stringify(raceEngineerVoices);
let lastPushedVoiceListJson = "";

function pushRaceEngineerVoicesIfChanged(): void {
  if (raceEngineerVoiceListJson === lastPushedVoiceListJson) return;

  lastPushedVoiceListJson = raceEngineerVoiceListJson;
  updateGlobalSettings({ _raceEngineerVoices: raceEngineerVoiceListJson });
}

const driverNameListJson = JSON.stringify(driverNames);
let lastPushedDriverNameListJson = "";

function pushDriverNamesIfChanged(): void {
  if (driverNameListJson === lastPushedDriverNameListJson) return;

  lastPushedDriverNameListJson = driverNameListJson;
  updateGlobalSettings({ _driverNames: driverNameListJson });
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
function runChangelogVersionCheck(): void {
  // Nothing meaningful to compare before the first settings arrival.
  if (!startupDefaultsApplied) return;

  const settings = getGlobalSettings();
  const s = settings as Record<string, unknown>;

  // Reads the last-seen version from the passthrough `_lastSeenVersion` key
  // and persists the running version. No-op for pre-release builds and
  // same/older versions; opens the browser via the Elgato SDK. `type` is the
  // connected device's type id (best-effort), omitted when no device is
  // connected yet. The `changelogNotification` preference (issue #742)
  // decides whether a due changelog opens, is recorded silently, or stays
  // pending (monthly window, anchored on the passthrough
  // `_lastChangelogOpenedAt` key).
  void runVersionCheck({
    currentVersion: getPluginVersion(),
    lastSeenVersion: typeof s._lastSeenVersion === "string" ? s._lastSeenVersion : undefined,
    policy: settings.changelogNotification,
    lastOpenedAt: typeof s._lastChangelogOpenedAt === "number" ? s._lastChangelogOpenedAt : undefined,
    ecosystem: getPluginPlatform(),
    deviceType: [...streamDeck.devices].find((d) => d.isConnected)?.type,
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

  if (!shouldOpenChangelog(getPluginVersion(), lastSeen)) return;

  runChangelogVersionCheck();
});

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

  // Apply per-feature "On startup" defaults (issue #482). Overrides any
  // runtime value the previous session's button toggles persisted. The
  // Pit Crew action's own onGlobalSettingsChange listener picks up the
  // echoed runtime keys and re-applies them to the audio buses / radar
  // engine, so no further wiring is needed here.
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

    updateGlobalSettings({
      pitCrewRaceEngineerEnabled: settings.pitCrewRaceEngineerEnabledOnStartup,
      pitCrewRadarEnabled: settings.pitCrewRadarEnabledOnStartup,
    });

    // Open the website changelog once when a newer stable version is
    // detected (issue #680) — via the shared runChangelogVersionCheck above,
    // delayed by the #870 startup grace so a mid-session plugin restart (the
    // deck-host auto-update case) can't run the check before the sim-running
    // signals are up and open the page over a live session.
    setTimeout(runChangelogVersionCheck, VERSION_CHECK_STARTUP_GRACE_MS);
  }

  // Mirror "On startup" PI edits into the runtime toggles immediately so
  // checking the box has visible effect mid-session, not just at next
  // restart. The trackers MUST be updated before the recursive
  // `updateGlobalSettings` call: that call synchronously re-fires every
  // listener (including this one), and a stale tracker on re-entry would
  // diff "changed → changed" forever, blowing the stack and aborting the
  // listener chain in a partial state. Updating first means the re-entry
  // sees a fresh tracker, the diff comes up unchanged, and the recursion
  // unwinds cleanly. First-arrival is detected by the null sentinel and
  // skips the runtime sync — the startup one-shot above already wrote
  // both runtime keys.
  const previousPitCrewRaceEngineerEnabledOnStartup = lastSeenPitCrewRaceEngineerEnabledOnStartup;
  lastSeenPitCrewRaceEngineerEnabledOnStartup = settings.pitCrewRaceEngineerEnabledOnStartup;

  if (
    previousPitCrewRaceEngineerEnabledOnStartup !== null &&
    settings.pitCrewRaceEngineerEnabledOnStartup !== previousPitCrewRaceEngineerEnabledOnStartup
  ) {
    updateGlobalSettings({ pitCrewRaceEngineerEnabled: settings.pitCrewRaceEngineerEnabledOnStartup });
  }

  const previousPitCrewRadarEnabledOnStartup = lastSeenPitCrewRadarEnabledOnStartup;
  lastSeenPitCrewRadarEnabledOnStartup = settings.pitCrewRadarEnabledOnStartup;

  if (
    previousPitCrewRadarEnabledOnStartup !== null &&
    settings.pitCrewRadarEnabledOnStartup !== previousPitCrewRadarEnabledOnStartup
  ) {
    updateGlobalSettings({ pitCrewRadarEnabled: settings.pitCrewRadarEnabledOnStartup });
  }

  pushRaceEngineerVoicesIfChanged();
  pushDriverNamesIfChanged();

  // Apply audio output device (on startup and when changed from PI)
  const saved = s.audioOutputDevice;
  const deviceId = typeof saved === "string" ? saved : "";

  if (deviceId === currentAudioDeviceId) return;

  currentAudioDeviceId = deviceId;

  if (deviceId === "") {
    getAudio().setAudioDevice(-1);
  } else {
    const ok = getAudio().setAudioDeviceById(deviceId);

    // Stale or unknown id (legacy index, unplugged device): fall back to
    // System Default. We do NOT rewrite the persisted setting — the user
    // may replug their device next session and we want it to re-bind
    // automatically when the id reappears in the enumeration.
    if (!ok) {
      getAudio().setAudioDevice(-1);
    }
  }
});

// Re-enumerate audio devices on every PI open so a headset plugged in
// after Stream Deck booted appears without a full restart. The
// `pushAudioDevicesIfChanged` guard short-circuits the common case (PI
// reopened, no hardware changed) so the sdpi-components data source
// doesn't churn.
adapter.onPropertyInspectorDidAppear(() => {
  pushAudioDevicesIfChanged();
  pushRaceEngineerVoicesIfChanged();
  pushDriverNamesIfChanged();
});

// Initialize window focus service for focusing iRacing before any action
initWindowFocus(adapter.createLogger("WindowFocus"), () => native.focusIRacingWindow());

// Initialize the mouse pointer service for the Mouse to Sim mode (#926)
initMousePointer(adapter.createLogger("MousePointer"), (x, y) => native.moveMouseToIRacingWindow(x, y));

// Focus iRacing window before any action executes (when enabled in global settings)
// MUST be registered BEFORE actions so the listener fires first in the EventEmitter chain.
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
adapter.registerAction(SWITCH_PROFILE_UUID, new SwitchProfile(adapter.createLogger("SwitchProfile")));
adapter.registerAction(TELEMETRY_CONTROL_UUID, new TelemetryControl(adapter.createLogger("TelemetryControl")));
adapter.registerAction(TELEMETRY_DISPLAY_UUID, new TelemetryDisplay(adapter.createLogger("TelemetryDisplay")));
adapter.registerAction(TIRE_SERVICE_UUID, new TireService(adapter.createLogger("TireService")));
adapter.registerAction(TOGGLE_UI_ELEMENTS_UUID, new ToggleUiElements(adapter.createLogger("ToggleUiElements")));
adapter.registerAction(VIEW_ADJUSTMENT_UUID, new ViewAdjustment(adapter.createLogger("ViewAdjustment")));

// Initialize global settings listener BEFORE connect - handlers must be registered first
const settingsStore = createFileSettingsStore({
  path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
  logger: adapter.createLogger("SettingsStore"),
});
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore);

// Migrate the pre-#953 spring binding keys (Left/Right -> LR/RR) once real settings arrive
migrateGlobalSettingsKeys(SETUP_CHASSIS_BINDING_KEY_RENAMES, adapter.createLogger("SettingsMigration"));

// Wire profile switching (Elgato-only) for the Switch Profile action and the
// "Stream Deck Profiles" settings buttons (#736)
initProfileSwitcher(
  (deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page),
  adapter.createLogger("ProfileSwitcher"),
);

// Settings window (#992): the plugin serves ui/settings-window.html (compiled
// from settings-window.ejs, with settings-window-bridge.js injected before
// sdpi-components.js) over a loopback server started lazily on the PI's "Open
// iRaceDeck Settings" request, and opens it as a chromeless app window. The
// page's sdpi-components talks to the server's fake host, which is bound here
// to the real global-settings singleton — so every write goes through
// updateGlobalSettings and the #896 single-writer guarantees hold.
const settingsWindowLogger = adapter.createLogger("SettingsWindow");
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
    // Unlike a PI, the window has no implicit device: it names one. Same
    // dispatch as the PI's accordion buttons (suffix per #753, history per #762).
    switchProfile: (deviceId, profile, page) => adapter.switchToBundledProfile(deviceId, profile, page),
  }),
  // The page can't probe SimHub itself (cross-origin, no CORS) — answer from the plugin's own view.
  simHub: { isReachable: isSimHubReachable, getRoles: () => getSimHub().getRoles() },
  logger: settingsWindowLogger,
});

// Publish the connected decks for the settings window's profile device picker,
// the same way `_audioDeviceList` is published for the audio device picker:
// a passthrough global setting, deduped by content, refreshed on every device
// change and whenever the window opens.
let lastPushedDeckDevicesJson = "";

function pushDeckDevicesIfChanged(): void {
  const devices = [...streamDeck.devices]
    .filter((d) => d.isConnected)
    .map((d) => ({ id: d.id, name: d.name, type: d.type }));
  const json = JSON.stringify(devices);

  if (json === lastPushedDeckDevicesJson) return;

  lastPushedDeckDevicesJson = json;
  updateGlobalSettings({ _deckDevices: json });
}

streamDeck.devices.onDeviceDidConnect(() => pushDeckDevicesIfChanged());
streamDeck.devices.onDeviceDidDisconnect(() => pushDeckDevicesIfChanged());

adapter.onOpenSettingsRequest(() => {
  pushDeckDevicesIfChanged();
  void settingsWindow.open().catch((error: unknown) => {
    settingsWindowLogger.error(`Failed to open settings window: ${String(error)}`);
  });
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

// Connect to the Stream Deck
adapter.connect();
