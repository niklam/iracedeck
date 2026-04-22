import streamDeck from "@elgato/streamdeck";
import audioAssetsManifest from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import { AudioNative } from "@iracedeck/audio-native";
import { initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { registerPitEngineer } from "@iracedeck/audio-scenarios/pit-engineer";
import { getAudio, initializeAudio } from "@iracedeck/audio-service";
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import {
  getController,
  initAppMonitor,
  initGlobalSettings,
  initializeBindingDispatcher,
  initializeKeyboard,
  initializeSDK,
  initializeSimHub,
  initPluginConfig,
  onGlobalSettingsChange,
  type PluginConfig,
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
  PIT_ENGINEER_UUID,
  PIT_QUICK_ACTIONS_UUID,
  PitEngineer,
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
import { initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";
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

// Initialize audio engine for pit engineer voice playback.
// Base path lets scenarios emit manifest-relative clip paths (e.g.
// "sfx/IRD-tick-open.mp3") that audio-service prepends with the plugin's
// assets/audio directory before passing them to the native engine.
// Resolved from __binDir (→ <sdPlugin>/bin/) so lookup is stable
// regardless of the launching process's cwd.
const audioNative = new AudioNative();
initializeAudio(adapter.createLogger("Audio"), audioNative, join(__binDir, "..", "assets", "audio"));
getAudio().init();

// Initialize the scenario engine AFTER audio (so it can drive playback) but
// BEFORE actions register (so actions see a ready engine when they wire PI
// toggles and Test buttons to setEnabled / fire).
initializeAudioScenarios(eventBus, getAudio(), audioAssetsManifest, adapter.createLogger("AudioScenarios"));
registerPitEngineer(eventBus);

// Publish audio device list and apply saved device selection
let audioDeviceInitialized = false;
let currentAudioDevice = -1;
onGlobalSettingsChange((settings) => {
  const s = settings as Record<string, unknown>;

  // Publish device list for PI consumption (once, on first settings receipt)
  if (!audioDeviceInitialized) {
    const devices = getAudio().getAudioDevices();
    updateGlobalSettings({ _audioDeviceList: JSON.stringify(devices) });
  }

  // Apply audio output device (on startup and when changed from PI)
  const saved = s.audioOutputDevice;
  const deviceIndex = saved !== undefined && saved !== null && saved !== "" ? Number(saved) : -1;

  if (deviceIndex !== currentAudioDevice) {
    currentAudioDevice = deviceIndex;

    if (deviceIndex !== -1 || audioDeviceInitialized) {
      getAudio().setAudioDevice(deviceIndex);
    }
  }

  audioDeviceInitialized = true;
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
adapter.registerAction(PIT_ENGINEER_UUID, new PitEngineer(adapter.createLogger("PitEngineer")));
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
