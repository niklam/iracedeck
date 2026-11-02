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
 * `evaluateElevationWarning`) so deck-iracing needs no dependency on
 * `@iracedeck/iracing-native`.
 */
import type { ILogger } from "@iracedeck/logger";
import { clearWarning, setWarning } from "@iracedeck/settings";

import { ELEVATION_WARNING_ID, evaluateElevationWarning } from "./elevation-warning.js";

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
 *
 * The probe and the banner are latched separately (#1558). The probe and its
 * log lines run once per connection. The PI warning is posted or cleared on
 * that tick and, if `setWarning` / `clearWarning` throws, again on each later
 * tick of the connection until one call succeeds, rather than staying wrong
 * for the rest of the connection. That throw is left to propagate: the SDK
 * controller isolates and reports a subscriber's throw, so it neither starves
 * the other subscribers nor floods the log. A retry never re-runs the probe; it
 * costs a read of the cached `_warnings` setting, plus a write only while the
 * record is still missing (both calls skip an unchanged one), so it is cheap at
 * telemetry rate and stops as soon as the store holds the banner.
 */
export function createElevationCheckSubscriber(
  options: ElevationCheckOptions,
): (telemetry: unknown, isConnected: boolean) => void {
  const { getStatus, logger } = options;
  /** Whether the probe has run on this connection, whether it answered or threw. */
  let probed = false;
  /** This connection's probe answer; null until it answers, and after it threw. */
  let status: { mismatch: boolean } | null = null;
  /** Whether the PI warning has been brought in line with `status` on this connection. */
  let published = false;

  return (_telemetry, isConnected) => {
    if (!isConnected) {
      probed = false;
      status = null;
      published = false;
      lastMismatch = null;

      return;
    }

    if (!probed) {
      probed = true;

      // A failing probe stays latched until the next connection rather than
      // being left to the controller's boundary: retrying every tick would
      // hammer a persistently failing native probe at telemetry rate. The
      // failure is logged at warn so the skipped check still shows up in
      // support logs. The PI warning is left as-is — an unknown status
      // shouldn't clear a banner that may still be accurate.
      try {
        status = getStatus();
      } catch (error) {
        logger.warn("Elevation check failed; skipping until the next connection");
        logger.debug(`Elevation check error: ${error instanceof Error ? error.message : String(error)}`);
        lastMismatch = null;

        return;
      }

      lastMismatch = status.mismatch;

      if (evaluateElevationWarning(status)) {
        logger.warn(
          "iRacing appears to run at a higher integrity level than the plugin; outbound commands will be silently dropped",
        );
      } else {
        logger.info("Elevation check passed; no integrity mismatch detected");
      }

      logger.debug(`Elevation status: ${JSON.stringify(status)}`);
    }

    if (published || status === null) return;

    const warning = evaluateElevationWarning(status);

    if (warning) {
      setWarning(warning.id, warning.level, warning.message);
    } else {
      clearWarning(ELEVATION_WARNING_ID);
    }

    // Set only once the store has taken it, so a throw above leaves the banner
    // to be posted again on the next tick.
    published = true;
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
