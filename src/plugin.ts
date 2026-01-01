import streamDeck from "@elgato/streamdeck";

// Vehicle actions
import { DisplaySpeed } from "./actions/vehicle/display-speed";
import { DisplayGear } from "./actions/vehicle/display-gear";

// Environment actions
import { DisplaySky } from "./actions/environment/display-sky";

// Pit actions
import { DisplayFuelToAdd } from "./actions/pit/display-fuel-to-add";

// Comms actions
import { DoChatMessage } from "./actions/comms/do-chat-message";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register iRacing actions
streamDeck.actions.registerAction(new DisplaySpeed());
streamDeck.actions.registerAction(new DisplayGear());
streamDeck.actions.registerAction(new DisplaySky());
streamDeck.actions.registerAction(new DisplayFuelToAdd());
streamDeck.actions.registerAction(new DoChatMessage());

// Finally, connect to the Stream Deck.
streamDeck.connect();
