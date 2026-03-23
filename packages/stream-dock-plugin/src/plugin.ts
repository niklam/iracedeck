/**
 * iRaceDeck VSDinside Stream Dock Plugin
 *
 * Entry point for the VSD Craft plugin. Registers all iRaceDeck actions
 * via the VSDPlatformAdapter, enabling them on VSDinside Stream Dock devices.
 *
 * Mirrors the Elgato Stream Deck plugin initialization order.
 */
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
  FUEL_SERVICE_UUID,
  FuelService,
  LOOK_DIRECTION_UUID,
  LookDirection,
  MEDIA_CAPTURE_UUID,
  MediaCapture,
  PIT_QUICK_ACTIONS_UUID,
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
} from "@iracedeck/actions";
import { VSDPlatformAdapter } from "@iracedeck/deck-adapter-vsd";
import { initAppMonitor, initGlobalSettings, initializeKeyboard, initializeSDK } from "@iracedeck/deck-core";
import { IRacingNative } from "@iracedeck/iracing-native";

import { focusIRacingIfEnabled, initWindowFocus } from "./shared/window-focus.js";

// Create the VSDinside platform adapter
const adapter = new VSDPlatformAdapter();

// Initialize the SDK singleton
initializeSDK(adapter.createLogger("iRacingSDK"));

// Initialize keyboard for hotkey actions with scan code support for non-US layouts
const native = new IRacingNative();
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
);

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
adapter.registerAction(FUEL_SERVICE_UUID, new FuelService(adapter.createLogger("FuelService")));
adapter.registerAction(LOOK_DIRECTION_UUID, new LookDirection(adapter.createLogger("LookDirection")));
adapter.registerAction(MEDIA_CAPTURE_UUID, new MediaCapture(adapter.createLogger("MediaCapture")));
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

// Initialize app monitor for iRacing process detection
initAppMonitor(adapter, adapter.createLogger("AppMonitor"));

// Connect to VSD Craft
adapter.connect();
