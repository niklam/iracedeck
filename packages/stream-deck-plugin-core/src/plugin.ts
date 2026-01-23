import streamDeck from "@elgato/streamdeck";
import { createSDLogger, initGlobalSettings, initializeKeyboard, initializeSDK } from "@iracedeck/stream-deck-shared";

import { BlackBoxSelector } from "./actions/black-box-selector.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Initialize keyboard for hotkey actions
initializeKeyboard(createSDLogger(streamDeck.logger.createScope("Keyboard")));

// Register core actions
streamDeck.actions.registerAction(new BlackBoxSelector());

// Initialize global settings listener BEFORE connect - handlers must be registered first
// Pass the SDK instance to ensure we use the same instance as the plugin
initGlobalSettings(streamDeck);

// Connect to the Stream Deck
streamDeck.connect();
