import streamDeck from "@elgato/streamdeck";
import { IRacingNative } from "@iracedeck/iracing-native";
import { createSDLogger, initAppMonitor, initializeKeyboard, initializeSDK } from "@iracedeck/stream-deck-shared";

import { DoHotkey } from "./actions/do-hotkey.js";
import { DoIRacingHotkey } from "./actions/do-iracing-hotkey.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Initialize keyboard with scan code support for non-US layouts
const native = new IRacingNative();
initializeKeyboard(createSDLogger(streamDeck.logger.createScope("Keyboard")), (scanCodes) =>
  native.sendScanKeys(scanCodes),
);

// Register hotkey actions
streamDeck.actions.registerAction(new DoHotkey());
streamDeck.actions.registerAction(new DoIRacingHotkey());

// Initialize app monitor for iRacing process detection
initAppMonitor(streamDeck, createSDLogger(streamDeck.logger.createScope("AppMonitor")));

// Connect to the Stream Deck
streamDeck.connect();
