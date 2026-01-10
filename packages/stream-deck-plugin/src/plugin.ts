import streamDeck from "@elgato/streamdeck";
import { IRacingSDK, ILogger, LogLevel } from "@iracedeck/iracing-sdk";

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

// Create a wrapper to adapt Stream Deck logger to our ILogger interface
function createSDLogger(
  sdLogger: ReturnType<typeof streamDeck.logger.createScope>,
  level: LogLevel = LogLevel.Info,
): ILogger {
  return {
    trace: (msg: string) => {
      if (level <= LogLevel.Trace) sdLogger.trace(msg);
    },
    debug: (msg: string) => {
      if (level <= LogLevel.Debug) sdLogger.debug(msg);
    },
    info: (msg: string) => {
      if (level <= LogLevel.Info) sdLogger.info(msg);
    },
    warn: (msg: string) => {
      if (level <= LogLevel.Warn) sdLogger.warn(msg);
    },
    error: (msg: string) => {
      if (level <= LogLevel.Error) sdLogger.error(msg);
    },
    withLevel: (newLevel: LogLevel) => createSDLogger(sdLogger, newLevel),
    createScope: (scope: string) => createSDLogger(sdLogger.createScope(scope), level),
  };
}

// Set up loggers for all SDK singletons
IRacingSDK.setLoggers(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Register iRacing actions
streamDeck.actions.registerAction(new DisplaySpeed());
streamDeck.actions.registerAction(new DisplayGear());
streamDeck.actions.registerAction(new DisplaySky());
streamDeck.actions.registerAction(new DisplayFuelToAdd());
streamDeck.actions.registerAction(new DoFuelAdd());
streamDeck.actions.registerAction(new DoFuelReduce());
streamDeck.actions.registerAction(new DoTireCompound());
streamDeck.actions.registerAction(new DoChangeTires());
streamDeck.actions.registerAction(new DoFastRepair());

// Connect to the Stream Deck
streamDeck.connect();
