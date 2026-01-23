import streamDeck from "@elgato/streamdeck";
import { createSDLogger, initGlobalSettings, initializeSDK } from "@iracedeck/stream-deck-shared";

// Pit actions
import { DisplayFuelToAdd } from "./actions/display-fuel-to-add.js";
import { DoChangeTires } from "./actions/do-change-tires.js";
import { DoFastRepair } from "./actions/do-fast-repair.js";
import { DoFuelAdd } from "./actions/do-fuel-add.js";
import { DoFuelReduce } from "./actions/do-fuel-reduce.js";
import { DoTireCompound } from "./actions/do-tire-compound.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Initialize the SDK singleton
initializeSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Register pit actions
streamDeck.actions.registerAction(new DisplayFuelToAdd());
streamDeck.actions.registerAction(new DoFuelAdd());
streamDeck.actions.registerAction(new DoFuelReduce());
streamDeck.actions.registerAction(new DoTireCompound());
streamDeck.actions.registerAction(new DoChangeTires());
streamDeck.actions.registerAction(new DoFastRepair());

// Initialize global settings listener BEFORE connect - handlers must be registered first
// Pass the SDK instance to ensure we use the same instance as the plugin
initGlobalSettings(streamDeck);

// Connect to the Stream Deck
streamDeck.connect();
