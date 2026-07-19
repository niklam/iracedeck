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

/**
 * How long a lost SDK connection must stay lost before it counts as an
 * iRacing exit (issue #870). Some hosts never deliver applicationDidTerminate
 * (Ulanzi maps no app-monitoring events at all; Mirabox delivery is
 * unproven), so a sustained SDK disconnect is the only exit signal there.
 * The window is well above the controller's 2 s reconnect poll, so a
 * transient shared-memory blip reconnects and cancels the confirmation
 * instead of mis-reading as an exit.
 */
export const IRACING_EXIT_SDK_CONFIRM_MS = 5000;

/** Whether initAppMonitor has been called */
let initialized = false;

/** Tracks whether iRacing is currently running */
let iRacingRunning = false;

/**
 * Whether `iRacingRunning` was set by a host applicationDidLaunch event
 * (issue #870). The init-already-connected path also sets the flag, but its
 * only evidence is the SDK connection — so when that connection is
 * confirmed lost, a connection-derived flag is cleared while an
 * event-derived one is trusted until applicationDidTerminate says otherwise.
 */
let runningSetByEvent = false;

/** Logger instance for this module */
let logger: ILogger | null = null;

/** Listeners notified after iRacing terminates (issue #870) */
const terminatedListeners = new Set<() => void>();

/**
 * Whether the terminated listeners have already been notified for the
 * current exit episode (issue #870). The terminate event and the
 * SDK-disconnect fallback can both observe the same exit; whichever runs
 * first wins, and the flag re-arms when the sim becomes active again.
 */
let simExitNotified = false;

/** Last SDK connection state seen by the fallback's connection ticks */
let lastSdkConnected: boolean | null = null;

/** Pending SDK-disconnect confirmation timer (issue #870) */
let sdkExitConfirmTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSdkExitConfirm(): void {
  if (sdkExitConfirmTimer !== null) {
    clearTimeout(sdkExitConfirmTimer);
    sdkExitConfirmTimer = null;
  }
}

/** Notify the terminated listeners once per exit episode. */
function notifyIRacingExit(): void {
  if (simExitNotified) {
    return;
  }

  simExitNotified = true;

  for (const listener of terminatedListeners) {
    try {
      listener();
    } catch (error) {
      logger?.error("iRacing-terminated listener failed");
      logger?.debug(`Listener error: ${String(error)}`);
    }
  }
}

/**
 * SDK connection tick from the controller subscription (issue #870). A
 * connection coming up marks the sim active again (cancelling any pending
 * exit confirmation and re-arming the exit notification); a fresh
 * true→false transition arms the confirmation window.
 */
function handleSdkConnectionTick(isConnected: boolean): void {
  const was = lastSdkConnected;
  lastSdkConnected = isConnected;

  if (isConnected) {
    cancelSdkExitConfirm();
    simExitNotified = false;

    return;
  }

  if (was !== true || sdkExitConfirmTimer !== null) {
    return;
  }

  sdkExitConfirmTimer = setTimeout(() => {
    sdkExitConfirmTimer = null;

    // The terminate event already handled this exit, or the connection came
    // back (ticks cancel the timer, this is a belt-and-suspenders re-check).
    if (simExitNotified || lastSdkConnected === true) {
      return;
    }

    // The host affirmatively says iRacing is running (launch event, no
    // terminate yet) — treat the disconnect as a transient SDK blip.
    if (iRacingRunning && runningSetByEvent) {
      return;
    }

    // The connection was the only evidence iRacing was up, and it stayed
    // gone for the whole window: clear the connection-derived running flag
    // and treat this as the sim exit no terminate event will ever report.
    iRacingRunning = false;
    logger?.info("iRacing exit detected via SDK disconnect");
    notifyIRacingExit();
  }, IRACING_EXIT_SDK_CONFIRM_MS);
}

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
      runningSetByEvent = true;
      cancelSdkExitConfirm();
      simExitNotified = false;
      getController().setReconnectEnabled(true);
    }
  });

  // Listen for iRacing termination
  adapter.onApplicationDidTerminate((application: string) => {
    logger?.debug(`Application terminated: ${application}`);

    if (application.toLowerCase() === IRACING_EXE.toLowerCase()) {
      logger?.info("iRacing terminated");
      iRacingRunning = false;
      runningSetByEvent = false;

      // setReconnectEnabled(false) actively disconnects the SDK, so by the
      // time the terminated listeners below run, both isIRacingRunning() and
      // the controller's connection status already read false — a listener
      // consulting isIRacingActive() (the #870 version-check re-run) sees the
      // sim as gone without any settle delay. Its synchronous null-telemetry
      // fan-out runs every SDK subscriber, so a throwing subscriber must not
      // abort this handler before the exit notification below.
      try {
        getController().setReconnectEnabled(false);
      } catch (error) {
        logger?.error("Disabling reconnect on iRacing exit failed");
        logger?.debug(`setReconnectEnabled error: ${String(error)}`);
      }

      notifyIRacingExit();
    }
  });

  // SDK-disconnect exit fallback (issue #870): on hosts that never deliver
  // applicationDidTerminate, a sustained loss of the SDK's shared-memory
  // connection is the only signal that iRacing exited. The subscription is
  // never the controller's first subscriber in production (the sim-events
  // translator subscribes at plugin init), so it doesn't change the
  // controller's lifecycle.
  controller.subscribe("appMonitor", (_telemetry, isConnected) => {
    handleSdkConnectionTick(isConnected);
  });

  initialized = true;

  // Check if SDK is already connected (iRacing was running before plugin loaded)
  // If so, assume iRacing is running and keep reconnect enabled
  if (controller.getConnectionStatus()) {
    iRacingRunning = true;
    logger.info("Initialized (already connected)");
  } else if (adapter.supportsApplicationMonitoring === false) {
    // This host never delivers applicationDidLaunch, so pausing reconnect
    // here would leave the SDK permanently disconnected whenever iRacing
    // starts after the plugin (issue #870 review). Keep polling — the
    // resulting connection is also the exit signal the SDK-disconnect
    // fallback relies on.
    logger.info("Initialized (no app-monitor events, reconnect polling stays on)");
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
  runningSetByEvent = false;
  simExitNotified = false;
  lastSdkConnected = null;
  cancelSdkExitConfirm();
  terminatedListeners.clear();
}
