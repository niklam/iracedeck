/**
 * Shared elevation-check subscriber (issues #610, #902).
 *
 * Wraps the once-per-connection Administrator/integrity probe that every plugin
 * runs on SDK connect: when iRacing runs elevated and the plugin does not,
 * Windows UIPI silently drops every outbound command while telemetry keeps
 * flowing — so nothing else signals the cause. The probe is purely diagnostic:
 * it never gates or disables the plugin.
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

      return;
    }

    if (checked) return;

    checked = true;

    const status = getStatus();
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
