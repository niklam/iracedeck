/**
 * SDK Singleton
 *
 * Provides a lazy-initialized singleton for the iRacing SDK bundle.
 * Each Stream Deck plugin process has its own instance since they have
 * separate node_modules.
 *
 * Usage:
 * 1. Call initializeSDK() once at plugin startup with your logger
 * 2. Import getController()/getCommands() in your actions
 *
 * @example
 * // At startup (the shared bootstrap: plugin-runtime's phases/core.ts)
 * import { initializeSDK } from "@iracedeck/deck-iracing";
 *
 * initializeSDK(adapter.createLogger("iRacingSDK"));
 *
 * // In action files
 * import { getController, getCommands } from "@iracedeck/deck-iracing";
 *
 * const controller = getController();
 * const { pit, camera } = getCommands();
 */
import {
  _resetSimConnection,
  focusIRacingBeforeInput,
  initializeSimConnection,
  isSimConnectionInitialized,
} from "@iracedeck/deck-core";
import { type Commands, createSDK, type SDKBundle, SDKController } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { IRacingSimConnection } from "./iracing-sim-connection.js";

let sdkBundle: SDKBundle | null = null;

/**
 * Initialize the SDK singleton with a logger.
 * Should be called once at plugin startup.
 *
 * @param logger - Logger instance for SDK logging
 * @returns The initialized SDK bundle
 * @throws Error if called more than once, or if another sim connection is
 *   already installed (checked before anything is created, so a refused call
 *   leaves the SDK uninitialised rather than half-initialised)
 */
export function initializeSDK(logger: ILogger = silentLogger): SDKBundle {
  if (sdkBundle) {
    throw new Error("SDK already initialized. initializeSDK() should only be called once.");
  }

  if (isSimConnectionInitialized()) {
    throw new Error(
      "A sim connection is already initialized. initializeSDK() installs iRacing's and cannot replace it.",
    );
  }

  // The chat command types text; every other command broadcasts. Focus before
  // the paste, under the user's focus mode (#977). This package owns the focus
  // service and the SDK package cannot import it, hence the injection.
  sdkBundle = createSDK(logger, { beforeKeystrokes: focusIRacingBeforeInput });
  initializeSimConnection(new IRacingSimConnection(sdkBundle.controller));

  return sdkBundle;
}

/**
 * Get the SDK bundle.
 *
 * @returns The SDK bundle
 * @throws Error if SDK hasn't been initialized
 */
export function getSDK(): SDKBundle {
  if (!sdkBundle) {
    throw new Error("SDK not initialized. Call initializeSDK() first in your plugin entry point.");
  }

  return sdkBundle;
}

/**
 * Get the SDK controller for telemetry subscriptions and connection status.
 *
 * @returns The SDKController instance
 * @throws Error if SDK hasn't been initialized
 */
export function getController(): SDKController {
  return getSDK().controller;
}

/**
 * Get all command instances for iRacing interactions.
 *
 * @returns Object containing all command instances (camera, chat, pit, etc.)
 * @throws Error if SDK hasn't been initialized
 */
export function getCommands(): Commands {
  return getSDK().commands;
}

/**
 * Check if the SDK has been initialized.
 *
 * @returns true if SDK is initialized, false otherwise
 */
export function isSDKInitialized(): boolean {
  return sdkBundle !== null;
}

/**
 * Reset the SDK singleton (for testing purposes only).
 * @internal
 */
export function _resetSDK(): void {
  sdkBundle = null;
  _resetSimConnection();
}
