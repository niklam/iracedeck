/**
 * App Monitor
 *
 * Monitors iRacing application state via Stream Deck's app monitoring feature.
 * Controls SDKController reconnection based on whether iRacing is running.
 *
 * Usage:
 * 1. Add ApplicationsToMonitor to manifest.json:
 *    "ApplicationsToMonitor": { "windows": ["iRacingSim64DX11.exe"] }
 * 2. Call initAppMonitor(streamDeck, logger) at plugin startup, before streamDeck.connect()
 *
 * @example
 * // In plugin.ts
 * import streamDeck from "@elgato/streamdeck";
 * import { createSDLogger, initAppMonitor } from "./shared/index.js";
 * initAppMonitor(streamDeck, createSDLogger(streamDeck.logger.createScope("AppMonitor")));
 * streamDeck.connect();
 */
import type StreamDeck from "@elgato/streamdeck";
import type { ILogger } from "@iracedeck/logger";

import { getController } from "./sdk-singleton.js";

/** The iRacing executable name on Windows */
const IRACING_EXE = "iRacingSim64DX11.exe";

/** Whether initAppMonitor has been called */
let initialized = false;

/** Tracks whether iRacing is currently running */
let iRacingRunning = false;

/** Logger instance for this module */
let logger: ILogger | null = null;

/**
 * Initialize the app monitor.
 * Sets up listeners for iRacing launch/terminate events.
 * Should be called once at plugin startup, before streamDeck.connect().
 *
 * PREREQUISITES:
 * - initializeSDK() must be called before initAppMonitor()
 * - The SDK controller must be available via getController()
 *
 * @param sd - The Stream Deck SDK instance from the plugin
 * @param log - Logger instance for this module
 * @throws Error if SDK hasn't been initialized
 */
export function initAppMonitor(sd: typeof StreamDeck, log: ILogger): void {
  logger = log;

  if (initialized) {
    logger.debug("Already initialized");

    return;
  }

  logger.info("Initializing");

  // Validate SDK is initialized before proceeding
  let controller;

  try {
    controller = getController();
  } catch {
    logger.error("Cannot initialize: SDK not initialized");
    throw new Error("initAppMonitor requires SDK to be initialized first (call initializeSDK())");
  }

  // Listen for iRacing launch
  sd.system.onApplicationDidLaunch((ev) => {
    logger?.debug(`Application launched: ${ev.application}`);

    if (ev.application.toLowerCase() === IRACING_EXE.toLowerCase()) {
      logger?.info("iRacing launched");
      iRacingRunning = true;
      getController().setReconnectEnabled(true);
    }
  });

  // Listen for iRacing termination
  sd.system.onApplicationDidTerminate((ev) => {
    logger?.debug(`Application terminated: ${ev.application}`);

    if (ev.application.toLowerCase() === IRACING_EXE.toLowerCase()) {
      logger?.info("iRacing terminated");
      iRacingRunning = false;
      getController().setReconnectEnabled(false);
    }
  });

  initialized = true;

  // Check if SDK is already connected (iRacing was running before plugin loaded)
  // If so, assume iRacing is running and keep reconnect enabled
  if (controller.getConnectionStatus()) {
    iRacingRunning = true;
    logger.info("Initialized (already connected)");
  } else {
    // Not connected - disable reconnection until iRacing launches
    // Stream Deck will fire applicationDidLaunch immediately if iRacing is already running
    controller.setReconnectEnabled(false);
    logger.info("Initialized (reconnect paused)");
  }
}

/**
 * Check if iRacing is currently running (as known to the app monitor).
 *
 * @returns true if iRacing is running, false otherwise
 */
export function isIRacingRunning(): boolean {
  return iRacingRunning;
}

/**
 * Check if the app monitor has been initialized.
 *
 * @returns true if initialized, false otherwise
 */
export function isAppMonitorInitialized(): boolean {
  return initialized;
}

/**
 * Reset app monitor state (for testing purposes only).
 * @internal
 */
export function _resetAppMonitor(): void {
  initialized = false;
  iRacingRunning = false;
}
