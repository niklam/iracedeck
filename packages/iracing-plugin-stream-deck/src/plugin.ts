import streamDeck from "@elgato/streamdeck";
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import { AudioNative } from "@iracedeck/audio-native";
import { initializeAudioScenarios, scanDriverNames, scanRaceEngineerVoices } from "@iracedeck/audio-scenarios";
import {
  DAMAGE_CALLOUT_SETTING_KEYS,
  type DamageCalloutId,
  FLAG_CALLOUT_SETTING_KEYS,
  type FlagCalloutId,
  PIT_READBACK_CALLOUT_SETTING_KEYS,
  type PitReadbackCalloutId,
  registerPitCrew,
} from "@iracedeck/audio-scenarios/pit-crew";
import { getAudio, initializeAudio } from "@iracedeck/audio-service";
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import {
  getController,
  getGlobalSettings,
  initAppMonitor,
  initGlobalSettings,
  initializeBindingDispatcher,
  initializeClipboard,
  initializeKeyboard,
  initializeSDK,
  initializeSimHub,
  initPluginConfig,
  onGlobalSettingsChange,
  type PluginConfig,
  resolveActiveRaceEngineerVoice,
  updateGlobalSettings,
} from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import {
  AI_SPOTTER_CONTROLS_UUID,
  AiSpotterControls,
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
import { getReadbackSnapshot, initializeSimEventsIracing, isPitActionsAllowed } from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { focusIRacingIfEnabled, initWindowFocus } from "./shared/index.js";

// Load build-time config (version, platform)
const __binDir = dirname(fileURLToPath(import.meta.url));
const pluginConfig: PluginConfig = JSON.parse(readFileSync(join(__binDir, "config.json"), "utf-8"));
initPluginConfig(pluginConfig);

// Create the Elgato platform adapter
const adapter = new ElgatoPlatformAdapter(streamDeck);

// Enable debug logging
streamDeck.logger.setLevel("debug");

// Initialize the SDK singleton
initializeSDK(adapter.createLogger("iRacingSDK"));

// Initialize the event bus BEFORE any publisher (sim-events-iracing) or
// subscriber (actions) exist. Must land before sdk translator + actions so
// both sides can see the bus.
const eventBus = initializeEventBus(adapter.createLogger("EventBus"));

// Translate sdkController ticks → semantic events on the bus. The only
// package allowed to read `@iracedeck/iracing-sdk` for telemetry.
initializeSimEventsIracing(eventBus, getController(), adapter.createLogger("SimEventsIracing"));

// Initialize keyboard for hotkey actions with scan code support for non-US layouts
const native = new IRacingNative();
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
);

// Initialize clipboard for paste-based action flows (e.g. race-admin "Type in Chat").
// Pasting itself uses the keyboard service above (Ctrl+V).
initializeClipboard(adapter.createLogger("Clipboard"), (text) => native.setClipboardText(text));

// Initialize audio engine for pit crew voice playback.
// Base path lets scenarios emit manifest-relative clip paths (e.g.
// "sfx/IRD-tick-open.mp3") that audio-service prepends with the plugin's
// assets/audio directory before passing them to the native engine.
// Resolved from __binDir (→ <sdPlugin>/bin/) so lookup is stable
// regardless of the launching process's cwd.
const audioNative = new AudioNative();
initializeAudio(adapter.createLogger("Audio"), audioNative, join(__binDir, "..", "assets", "audio"));
getAudio().init();

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
// `currentAudioDeviceId` starts as `""` (System Default) because that is
// what `getAudio().init()` opened above — without this seed, the first
// arrival of `audioOutputDevice = ""` would look like a transition and
// fire a redundant `setAudioDevice(-1)` (an engine teardown + reopen).
let initialDevicePushDone = false;
let startupDefaultsApplied = false;
// Previous-value trackers for the "On startup" PI checkboxes. Null until
// the first global-settings arrival; on subsequent arrivals a value
// change drives an immediate runtime-key sync (issue #482).
let lastSeenRaceEngineerEnabledOnStartup: boolean | null = null;
let lastSeenRadarEnabledOnStartup: boolean | null = null;
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
  if (!startupDefaultsApplied) {
    startupDefaultsApplied = true;
    updateGlobalSettings({
      raceEngineerEnabled: settings.raceEngineerEnabledOnStartup,
      radarEnabled: settings.radarEnabledOnStartup,
    });
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
  const previousRaceEngineerEnabledOnStartup = lastSeenRaceEngineerEnabledOnStartup;
  lastSeenRaceEngineerEnabledOnStartup = settings.raceEngineerEnabledOnStartup;

  if (
    previousRaceEngineerEnabledOnStartup !== null &&
    settings.raceEngineerEnabledOnStartup !== previousRaceEngineerEnabledOnStartup
  ) {
    updateGlobalSettings({ raceEngineerEnabled: settings.raceEngineerEnabledOnStartup });
  }

  const previousRadarEnabledOnStartup = lastSeenRadarEnabledOnStartup;
  lastSeenRadarEnabledOnStartup = settings.radarEnabledOnStartup;

  if (previousRadarEnabledOnStartup !== null && settings.radarEnabledOnStartup !== previousRadarEnabledOnStartup) {
    updateGlobalSettings({ radarEnabled: settings.radarEnabledOnStartup });
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

// Connect to the Stream Deck
adapter.connect();
