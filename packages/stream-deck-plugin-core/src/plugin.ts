import streamDeck from "@elgato/streamdeck";
import { IRacingNative } from "@iracedeck/iracing-native";
import {
  createSDLogger,
  initAppMonitor,
  initGlobalSettings,
  initializeKeyboard,
  initializeSDK,
} from "@iracedeck/stream-deck-shared";

import { AudioControls } from "./actions/audio-controls.js";
import { BlackBoxSelector } from "./actions/black-box-selector.js";
import { CameraCycle } from "./actions/camera-cycle.js";
import { CameraEditorAdjustments } from "./actions/camera-editor-adjustments.js";
import { CameraEditorControls } from "./actions/camera-editor-controls.js";
import { CameraFocus } from "./actions/camera-focus.js";
import { CarControl } from "./actions/car-control.js";
import { Chat } from "./actions/chat.js";
import { CockpitMisc } from "./actions/cockpit-misc.js";
import { FuelService } from "./actions/fuel-service.js";
import { LookDirection } from "./actions/look-direction.js";
import { MediaCapture } from "./actions/media-capture.js";
import { PitQuickActions } from "./actions/pit-quick-actions.js";
import { ReplayNavigation } from "./actions/replay-navigation.js";
import { ReplaySpeed } from "./actions/replay-speed.js";
import { ReplayTransport } from "./actions/replay-transport.js";
import { SetupBrakes } from "./actions/setup-brakes.js";
import { SetupEngine } from "./actions/setup-engine.js";
import { SplitsDeltaCycle } from "./actions/splits-delta-cycle.js";
import { TelemetryControl } from "./actions/telemetry-control.js";
import { TireService } from "./actions/tire-service.js";
import { ToggleUiElements } from "./actions/toggle-ui-elements.js";
import { ViewAdjustment } from "./actions/view-adjustment.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Initialize keyboard for hotkey actions with scan code support for non-US layouts
const native = new IRacingNative();
initializeKeyboard(
  createSDLogger(streamDeck.logger.createScope("Keyboard")),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
);

// Register core actions
streamDeck.actions.registerAction(new AudioControls());
streamDeck.actions.registerAction(new BlackBoxSelector());
streamDeck.actions.registerAction(new CameraCycle());
streamDeck.actions.registerAction(new CameraEditorAdjustments());
streamDeck.actions.registerAction(new CameraEditorControls());
streamDeck.actions.registerAction(new CameraFocus());
streamDeck.actions.registerAction(new CarControl());
streamDeck.actions.registerAction(new Chat());
streamDeck.actions.registerAction(new CockpitMisc());
streamDeck.actions.registerAction(new FuelService());
streamDeck.actions.registerAction(new LookDirection());
streamDeck.actions.registerAction(new MediaCapture());
streamDeck.actions.registerAction(new PitQuickActions());
streamDeck.actions.registerAction(new ReplayNavigation());
streamDeck.actions.registerAction(new ReplaySpeed());
streamDeck.actions.registerAction(new ReplayTransport());
streamDeck.actions.registerAction(new SetupBrakes());
streamDeck.actions.registerAction(new SetupEngine());
streamDeck.actions.registerAction(new SplitsDeltaCycle());
streamDeck.actions.registerAction(new TelemetryControl());
streamDeck.actions.registerAction(new TireService());
streamDeck.actions.registerAction(new ToggleUiElements());
streamDeck.actions.registerAction(new ViewAdjustment());

// Initialize global settings listener BEFORE connect - handlers must be registered first
// Pass the SDK instance to ensure we use the same instance as the plugin
initGlobalSettings(streamDeck, createSDLogger(streamDeck.logger.createScope("GlobalSettings")));

// Initialize app monitor for iRacing process detection
initAppMonitor(streamDeck, createSDLogger(streamDeck.logger.createScope("AppMonitor")));

// Connect to the Stream Deck
streamDeck.connect();
