import streamDeck from "@elgato/streamdeck";
import { createSDLogger, initializeSDK } from "@iracedeck/stream-deck-shared";

// Comms actions
import { DoChatMacro } from "./actions/do-chat-macro.js";
import { DoChatMessage } from "./actions/do-chat-message.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Register iRacing actions
streamDeck.actions.registerAction(new DoChatMacro());
streamDeck.actions.registerAction(new DoChatMessage());

// Connect to the Stream Deck
streamDeck.connect();
