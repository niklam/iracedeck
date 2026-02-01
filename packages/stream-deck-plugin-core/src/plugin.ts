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
import { CarControl } from "./actions/car-control.js";
import { Chat } from "./actions/chat.js";
import { CockpitMisc } from "./actions/cockpit-misc.js";
import { FuelService } from "./actions/fuel-service.js";
import { LookDirection } from "./actions/look-direction.js";
import { PitQuickActions } from "./actions/pit-quick-actions.js";
import { SplitsDeltaCycle } from "./actions/splits-delta-cycle.js";
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
streamDeck.actions.registerAction(new CarControl());
streamDeck.actions.registerAction(new Chat());
streamDeck.actions.registerAction(new CockpitMisc());
streamDeck.actions.registerAction(new FuelService());
streamDeck.actions.registerAction(new LookDirection());
streamDeck.actions.registerAction(new PitQuickActions());
streamDeck.actions.registerAction(new SplitsDeltaCycle());
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
