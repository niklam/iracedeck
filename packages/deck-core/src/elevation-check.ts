/**
 * Shared elevation-check subscriber (issues #610, #902).
 *
 * Wraps the once-per-connection Administrator/integrity probe that every plugin
 * runs on SDK connect: when iRacing runs elevated and the plugin does not,
 * Windows UIPI silently drops every outbound command while telemetry keeps
 * flowing — so nothing else signals the cause. The probe never gates or
 * disables an action. Its one other reader is the implicit window focus
 * (#976): `hasElevationMismatch()` lets the focus service skip a focus that
 * cannot succeed (`SetForegroundWindow` across the mismatch always times out,
 * costing the native focuser's full wait and a stray ALT tap) and would not
 * help if it did, since UIPI drops input sent to the higher-integrity window.
 *
 * Both outcomes are captured at the default (info) log threshold so a support
 * log always records that the check ran and what it found (#902): a mismatch
 * logs at warn, a pass at info. The raw status detail stays at debug.
 *
 * `getStatus` is injected (structurally typed on `mismatch`, like
 * `evaluateElevationWarning`) so deck-core needs no dependency on
 * `@iracedeck/iracing-native`.
 */
import type { ILogger } from "@iracedeck/logger";

import { ELEVATION_WARNING_ID, evaluateElevationWarning } from "./elevation-warning.js";
import { clearWarning, setWarning } from "./pi-warnings.js";

/**
 * The last probe's verdict on the current connection, or `null` when none has
 * answered: before the first connection, after a disconnect, and after a probe
 * that threw. Module state rather than per-subscriber because the focus
 * service reads it without a handle on the subscriber; every plugin creates
 * exactly one.
 */
let lastMismatch: boolean | null = null;

/**
 * Whether the probe on the current connection reported an integrity-level
 * mismatch (#976). `false` whenever the answer is unknown, so a reader that
 * gates on it falls back to its ungated behaviour until a probe has said
 * otherwise.
 */
export function hasElevationMismatch(): boolean {
  return lastMismatch === true;
}

export interface ElevationCheckOptions {
  /** Runs the native probe, e.g. `() => native.getElevationStatus()`. */
  getStatus: () => { mismatch: boolean };
  logger: ILogger;
}

/**
 * Create the `sdkController.subscribe` callback. The probe runs once per
 * connection and re-arms on disconnect, so a reconnect (e.g. after an iRacing
 * restart at a different elevation) is probed again.
 */
export function createElevationCheckSubscriber(
  options: ElevationCheckOptions,
): (telemetry: unknown, isConnected: boolean) => void {
  const { getStatus, logger } = options;
  let checked = false;

  return (_telemetry, isConnected) => {
    if (!isConnected) {
      checked = false;
      lastMismatch = null;

      return;
    }

    if (checked) return;

    checked = true;

    // A throwing probe must not escape into the SDK controller's dispatch loop
    // (it iterates subscribers unguarded — a throw would starve the rest). The
    // check stays latched until the next connection: retrying every tick would
    // hammer a persistently failing probe at telemetry rate, and the failure is
    // logged at warn so the skipped check still shows up in support logs. The
    // PI warning is left as-is — an unknown status shouldn't clear a banner
    // that may still be accurate.
    let status: { mismatch: boolean };

    try {
      status = getStatus();
    } catch (error) {
      logger.warn("Elevation check failed; skipping until the next connection");
      logger.debug(`Elevation check error: ${error instanceof Error ? error.message : String(error)}`);
      lastMismatch = null;

      return;
    }

    lastMismatch = status.mismatch;

    const warning = evaluateElevationWarning(status);

    if (warning) {
      logger.warn(
        "iRacing appears to run at a higher integrity level than the plugin; outbound commands will be silently dropped",
      );
      setWarning(warning.id, warning.level, warning.message);
    } else {
      logger.info("Elevation check passed; no integrity mismatch detected");
      clearWarning(ELEVATION_WARNING_ID);
    }

    logger.debug(`Elevation status: ${JSON.stringify(status)}`);
  };
}

/**
 * Forget the last probe result.
 *
 * @internal Exported for testing
 */
export function _resetElevationCheck(): void {
  lastMismatch = null;
}
