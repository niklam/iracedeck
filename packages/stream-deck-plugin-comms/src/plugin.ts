import streamDeck from "@elgato/streamdeck";
import { createSDK } from "@iracedeck/iracing-sdk";

// Comms actions
import { DoChatMessage } from "./actions/comms/do-chat-message.js";
import { createSDLogger } from "./sd-logger.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Create SDK with all components wired together
const { controller, commands } = createSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Export for use in actions
export { controller, commands };

// Register iRacing actions
streamDeck.actions.registerAction(new DoChatMessage());

// Connect to the Stream Deck
streamDeck.connect();
