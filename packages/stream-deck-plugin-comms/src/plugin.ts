import streamDeck from "@elgato/streamdeck";

// Comms actions
import { DoChatMessage } from "./actions/comms/do-chat-message.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Register iRacing actions
streamDeck.actions.registerAction(new DoChatMessage());

// Connect to the Stream Deck
streamDeck.connect();
