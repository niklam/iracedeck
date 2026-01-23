import streamDeck from "@elgato/streamdeck";
import {
  createSDLogger,
  initAppMonitor,
  initGlobalSettings,
  initializeKeyboard,
  initializeSDK,
} from "@iracedeck/stream-deck-shared";

import { BlackBoxSelector } from "./actions/black-box-selector.js";
import { FpsNetworkDisplay } from "./actions/fps-network-display.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Initialize keyboard for hotkey actions
initializeKeyboard(createSDLogger(streamDeck.logger.createScope("Keyboard")));

// Register core actions
streamDeck.actions.registerAction(new BlackBoxSelector());
streamDeck.actions.registerAction(new FpsNetworkDisplay());

// Initialize global settings listener BEFORE connect - handlers must be registered first
// Pass the SDK instance to ensure we use the same instance as the plugin
initGlobalSettings(streamDeck, createSDLogger(streamDeck.logger.createScope("GlobalSettings")));

// Initialize app monitor for iRacing process detection
initAppMonitor(streamDeck, createSDLogger(streamDeck.logger.createScope("AppMonitor")));

// Connect to the Stream Deck
streamDeck.connect();
