/**
 * iRaceDeck Mirabox Plugin
 *
 * Entry point for the VSD Craft plugin. Registers all iRaceDeck actions
 * via the VSDPlatformAdapter, enabling them on Mirabox devices.
 *
 * Mirrors the Elgato Stream Deck plugin initialization order.
 */
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
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  type OpponentFlagCalloutId,
  type OpponentFlagPending,
  type OpponentPitCalloutId,
  type OpponentPitPending,
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
import { VSDPlatformAdapter } from "@iracedeck/deck-adapter-mirabox";
import {
  createElevationCheckSubscriber,
  deleteGlobalSettings,
  evaluateSetupWarning,
  getController,
  getGlobalSettings,
  getPluginPlatform,
  getPluginVersion,
  initAppMonitor,
  initGlobalSettings,
  initializeBindingDispatcher,
  initializeClipboard,
  initializeKeyboard,
  initializeRasterizer,
  initializeSDK,
  initializeSimHub,
  initPluginConfig,
  isIRacingActive,
  onGlobalSettingsChange,
  onIRacingTerminated,
  type PluginConfig,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  runVersionCheck,
  shouldOpenChangelog,
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
  SESSION_INFO_UUID,
  SessionInfo,
  SETUP_AERO_UUID,
  SETUP_BRAKES_UUID,
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

import { focusIRacingIfEnabled, initWindowFocus } from "./shared/window-focus.js";

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
applyAudioState();

// Derive the available Race Engineer voices and driver-name keys from
// the manifest. Static for the lifetime of the plugin process.
const raceEngineerVoices = scanRaceEngineerVoices(audioAssetsManifest);
const driverNames = scanDriverNames(audioAssetsManifest);

// Initialize the scenario engine AFTER audio (so it can drive playback) but
// BEFORE actions register (so actions see a ready engine when they wire PI
// toggles and Test buttons to setEnabled / fire).
//
// `getActiveVoice` resolves at clip-resolution time so a PI voice change
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
  // (`wetness`); same live-read pattern as the other callout families.
  (id: TrackConditionsCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[TRACK_CONDITIONS_CALLOUT_SETTING_KEYS[id]] !== false,
  // Per-incident-type callout opt-ins (issue #530). One boolean per
  // IncidentType subject. Same live-read pattern as the other callout
  // families.
  (id: IncidentCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[INCIDENT_CALLOUT_SETTING_KEYS[id]] !== false,
  // Session-start callout opt-in (issues #542, #668). Single subject; same
  // live-read pattern as the other callout families.
  (id: SessionStartCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SESSION_START_CALLOUT_SETTING_KEYS[id]] !== false,
  // Session-start conditions snapshot (issue #542). Composes the
  // telemetry-derived conditions with the PI-picked driver name; null when
  // conditions aren't available or no driver-name clips exist.
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
  // position-change callout below.
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
  // `state.raceFinishedFired` so race-status's `where:` suppresses the
  // periodic status callout on the final lap (race-end fires on the same
  // `lap.completed` tick — race.finished is emitted first into the pending
  // queue, latch flips synchronously before lap.completed publishes).
  () => isRaceFinished(),
  // Race-end callout opt-in (issue #569). Single subject.
  (id: RaceEndCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[RACE_END_CALLOUT_SETTING_KEYS[id]] !== false,
  // Race-end snapshot resolver (issue #569). Composes the cached
  // `race.finished` payload with the PI-picked driver name; null when the
  // cache is empty or no driver-name clips exist.
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
  // start and race-end.
  () => resolveActiveDriverName(driverNames, "driver"),
  // Live position resolver (issue #574 follow-up). Powers the "We're currently
  // P[n]" readouts (overtake, race position-change, race-status) — read at
  // speak-time so the spoken position is accurate to the moment it's said.
  () => getLivePosition(),
  // Overtake gate (issue #574 follow-up). Suppresses the whole overtake callout
  // when the swap wasn't a clean racing moment (cars alongside / off-track /
  // crawling / pit road / recent incident).
  getOvertakeGate,
  // Pit-box count-in opt-in (issue #600). Single subject (`count-in`) gating
  // all six distance-mark scenarios; live-read like the other callout families.
  (id: PitBoxCalloutId) => (getGlobalSettings() as Record<string, unknown>)[PIT_BOX_CALLOUT_SETTING_KEYS[id]] !== false,
  // Setup-mismatch warning resolver (issue #625). Live-read at fire time: the
  // opt-in plus the session-kind regex pattern from global settings, tested
  // against the loaded setup name. Consumed by the session-start / race-start
  // intros' `if` clauses.
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
  // Opponent-pit live position resolver (issue #622) — the pitting car's
  // canonical position at speak time, read in the projection the event was
  // classified in (the pending stash's isMultiClass, so a transient
  // session-info dropout can't flip a multi-class read to overall space).
  // A null return falls back to the emit-time payload position.
  (pending: OpponentPitPending): number | null => {
    const live = getLiveCarPosition(pending.carIdx);

    if (!live) return null;

    const n = pending.isMultiClass ? live.classPosition : live.position;

    return n > 0 ? n : null;
  },
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
  // Opponent-flag live position resolver (issue #936).
  (pending: OpponentFlagPending): number | null => {
    const live = getLiveCarPosition(pending.carIdx);

    if (!live) return null;

    const n = pending.isMultiClass ? live.classPosition : live.position;

    return n > 0 ? n : null;
  },
  // Race Engineer master gate (issue #515).
  () => (getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled === true,
  // Radar master gate (issue #515).
  () => (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true,
);

// Publish audio device list and apply saved device selection.
// See `iracing-plugin-stream-deck/src/plugin.ts` for the persistence
// contract (id-based; empty string = System Default; legacy values fall
// back to default without rewriting the persisted setting) and the
// recursion-safety note around the listener re-entry.
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
  // same/older versions. The VSD Craft protocol exposes no device-type id,
  // so `type` is omitted; opening the browser is best-effort (harmless if
  // the Stream Dock host ignores it). The `changelogNotification` preference
  // (issue #742) decides whether a due changelog opens, is recorded
  // silently, or stays pending (monthly window, anchored on the passthrough
  // `_lastChangelogOpenedAt` key).
  void runVersionCheck({
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
  if (!startupDefaultsApplied) {
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
});

// Initialize window focus service for focusing iRacing before any action
initWindowFocus(adapter.createLogger("WindowFocus"), () => native.focusIRacingWindow());

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

// Initialize global settings listener BEFORE connect - handlers must be registered first
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"));

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
