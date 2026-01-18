import streamDeck from "@elgato/streamdeck";
import { createSDLogger, initializeSDK } from "@iracedeck/stream-deck-shared";

// Environment actions
import { DisplaySky } from "./actions/environment/display-sky.js";
// Vehicle actions
import { DisplayGear } from "./actions/vehicle/display-gear.js";
import { DisplaySpeed } from "./actions/vehicle/display-speed.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Register iRacing actions
streamDeck.actions.registerAction(new DisplaySpeed());
streamDeck.actions.registerAction(new DisplayGear());
streamDeck.actions.registerAction(new DisplaySky());

// Connect to the Stream Deck
streamDeck.connect();
