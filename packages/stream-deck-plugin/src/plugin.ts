import streamDeck from "@elgato/streamdeck";
import { IRacingSDK, Logger } from "@iracedeck/iracing-sdk";

// Comms actions
import { DoChatMessage } from "./actions/comms/do-chat-message.js";
import { TestAction } from "./actions/comms/test-action.js";
// Environment actions
import { DisplaySky } from "./actions/environment/display-sky.js";
// Pit actions
import { DisplayFuelToAdd } from "./actions/pit/display-fuel-to-add.js";
import { DoChangeTires } from "./actions/pit/do-change-tires.js";
import { DoFastRepair } from "./actions/pit/do-fast-repair.js";
import { DoFuelAdd } from "./actions/pit/do-fuel-add.js";
import { DoFuelReduce } from "./actions/pit/do-fuel-reduce.js";
import { DoTireCompound } from "./actions/pit/do-tire-compound.js";
import { DisplayGear } from "./actions/vehicle/display-gear.js";
// Vehicle actions
import { DisplaySpeed } from "./actions/vehicle/display-speed.js";

// Enable trace logging
streamDeck.logger.setLevel("trace");

// Create a wrapper to adapt Stream Deck logger to our Logger interface
function createSDLogger(sdLogger: ReturnType<typeof streamDeck.logger.createScope>): Logger {
  const logger: Logger = {
    trace: (msg) => sdLogger.trace(msg),
    debug: (msg) => sdLogger.debug(msg),
    info: (msg) => sdLogger.info(msg),
    warn: (msg) => sdLogger.warn(msg),
    error: (msg) => sdLogger.error(msg),
    setLevel: () => {
      // Stream Deck logger level is controlled via streamDeck.logger.setLevel()
    },
    createScope: (scope) => createSDLogger(sdLogger.createScope(scope)),
  };

  return logger;
}

// Set up loggers for all SDK singletons
IRacingSDK.setLoggers(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Register iRacing actions
streamDeck.actions.registerAction(new TestAction());
streamDeck.actions.registerAction(new DisplaySpeed());
streamDeck.actions.registerAction(new DisplayGear());
streamDeck.actions.registerAction(new DisplaySky());
streamDeck.actions.registerAction(new DisplayFuelToAdd());
streamDeck.actions.registerAction(new DoFuelAdd());
streamDeck.actions.registerAction(new DoFuelReduce());
streamDeck.actions.registerAction(new DoTireCompound());
streamDeck.actions.registerAction(new DoChangeTires());
streamDeck.actions.registerAction(new DoFastRepair());
streamDeck.actions.registerAction(new DoChatMessage());

// Connect to the Stream Deck
streamDeck.connect();
