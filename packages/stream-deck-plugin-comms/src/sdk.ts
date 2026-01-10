/**
 * SDK Setup
 *
 * Creates and exports the iRacing SDK controller and commands.
 * Separated from plugin.ts to avoid circular dependencies.
 */
import streamDeck from "@elgato/streamdeck";
import { createSDK } from "@iracedeck/iracing-sdk";
import { createSDLogger } from "@iracedeck/stream-deck-utils";

// Create SDK with all components wired together
const { controller, commands } = createSDK(createSDLogger(streamDeck.logger.createScope("iRacingSDK")));

// Export for use in actions
export { controller, commands };
