/**
 * App Monitor
 *
 * Monitors iRacing application state via the platform adapter's app monitoring feature.
 * Controls SDKController reconnection based on whether iRacing is running.
 *
 * Usage:
 * 1. Ensure the platform supports app monitoring (e.g., ApplicationsToMonitor in manifest)
 * 2. Call initAppMonitor(adapter, logger) at plugin startup, before adapter.connect()
 */
import type { ILogger } from "@iracedeck/logger";

import { getController } from "./sdk-singleton.js";
import type { IDeckPlatformAdapter } from "./types.js";

/** The iRacing executable name on Windows */
const IRACING_EXE = "iRacingSim64DX11.exe";

/** Whether initAppMonitor has been called */
let initialized = false;

/** Tracks whether iRacing is currently running */
let iRacingRunning = false;

/** Logger instance for this module */
let logger: ILogger | null = null;

/** Listeners notified after iRacing terminates (issue #870) */
const terminatedListeners = new Set<() => void>();

/**
 * Initialize the app monitor.
 * Sets up listeners for iRacing launch/terminate events.
 * Should be called once at plugin startup, before adapter.connect().
 *
 * PREREQUISITES:
 * - initializeSDK() must be called before initAppMonitor()
 * - The SDK controller must be available via getController()
 *
 * @param adapter - The platform adapter instance
 * @param log - Logger instance for this module
 * @throws Error if SDK hasn't been initialized
 */
export function initAppMonitor(adapter: IDeckPlatformAdapter, log: ILogger): void {
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
  adapter.onApplicationDidLaunch((application: string) => {
    logger?.debug(`Application launched: ${application}`);

    if (application.toLowerCase() === IRACING_EXE.toLowerCase()) {
      logger?.info("iRacing launched");
      iRacingRunning = true;
      getController().setReconnectEnabled(true);
    }
  });

  // Listen for iRacing termination
  adapter.onApplicationDidTerminate((application: string) => {
    logger?.debug(`Application terminated: ${application}`);

    if (application.toLowerCase() === IRACING_EXE.toLowerCase()) {
      logger?.info("iRacing terminated");
      iRacingRunning = false;
      // setReconnectEnabled(false) actively disconnects the SDK, so by the
      // time the terminated listeners below run, both isIRacingRunning() and
      // the controller's connection status already read false — a listener
      // consulting isIRacingActive() (the #870 version-check re-run) sees the
      // sim as gone without any settle delay.
      getController().setReconnectEnabled(false);

      for (const listener of terminatedListeners) {
        try {
          listener();
        } catch (error) {
          logger?.error("iRacing-terminated listener failed");
          logger?.debug(`Listener error: ${String(error)}`);
        }
      }
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
    // The platform will fire applicationDidLaunch immediately if iRacing is already running
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
 * Check if iRacing is active by ANY available signal (issue #870): the app
 * monitor's launch/terminate tracking OR a live SDK shared-memory connection.
 * The two signals cover each other's gaps — the launch event can lag plugin
 * startup (or never arrive on hosts with unproven app monitoring), while the
 * SDK connects to iRacing directly regardless of the deck host. Returns false
 * when the SDK singleton isn't initialized yet.
 *
 * @returns true if iRacing is running or the SDK reports a connection
 */
export function isIRacingActive(): boolean {
  if (iRacingRunning) {
    return true;
  }

  try {
    return getController().getConnectionStatus();
  } catch {
    return false;
  }
}

/**
 * Subscribe to iRacing termination (issue #870). Listeners run after the
 * running flag is cleared and the SDK has been disconnected, so
 * `isIRacingActive()` already reads false inside a listener. Listeners may be
 * registered before `initAppMonitor` — the registry is module-scoped. A
 * throwing listener is logged and skipped; the rest still run.
 *
 * @param listener - Called once per iRacing exit
 * @returns Unsubscribe function
 */
export function onIRacingTerminated(listener: () => void): () => void {
  terminatedListeners.add(listener);

  return () => {
    terminatedListeners.delete(listener);
  };
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
  terminatedListeners.clear();
}
