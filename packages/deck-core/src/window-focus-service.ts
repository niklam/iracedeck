/**
 * Window Focus Service
 *
 * Focuses the iRacing window before inputs are sent. Plugins call
 * `focusIRacingIfEnabled()` from their platform-level key/dial handlers, so it
 * runs before every action regardless of whether that action sends keystrokes
 * or an SDK broadcast — both are dropped by Windows UIPI when iRacing is not
 * the foreground window.
 *
 * The focuser itself is injected at startup (same dependency-injection shape as
 * `keyboard-service`): the actual window handling lives in the native addon,
 * and deck-core must stay platform-agnostic, so this module never imports
 * `@iracedeck/iracing-native`.
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { isIRacingActive } from "./app-monitor.js";
import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";

/**
 * Status codes a {@link WindowFocuser} may return.
 *
 * MIRROR of the `FocusResult` enum in `@iracedeck/iracing-native` — deck-core
 * deliberately does not depend on that package (importing it loads the native
 * addon as a module side effect, which a platform-agnostic, heavily
 * unit-tested package must not do). The values are part of the native
 * contract: keep them in sync with `packages/iracing-native/src/index.ts`.
 * `focus-result.test.ts` in the Stream Deck plugin — which depends on both
 * packages — asserts the two stay identical.
 */
export const FocusResult = {
  /** Window was already in the foreground */
  AlreadyFocused: 0,
  /** Window was found and successfully focused */
  Focused: 1,
  /** No window with the expected title exists */
  WindowNotFound: 2,
  /** Window was found but focus did not transfer within timeout */
  FocusTimedOut: 3,
} as const;

export type FocusResult = (typeof FocusResult)[keyof typeof FocusResult];

/**
 * Function that focuses the iRacing window.
 * Returns a {@link FocusResult} status code.
 */
export type WindowFocuser = () => number;

let focuser: WindowFocuser | null = null;
let logger: ILogger = silentLogger;

/**
 * Initialize the window focus service.
 * Should be called once at plugin startup.
 *
 * @param log - Logger instance
 * @param windowFocuser - Function that focuses the iRacing window
 */
export function initWindowFocus(log: ILogger, windowFocuser: WindowFocuser): void {
  logger = log;
  focuser = windowFocuser;
}

/**
 * Focus the iRacing window if the `focusIRacingWindow` global setting is
 * enabled. Best-effort: logs on failure but never throws, so a focus problem
 * can't stop the action the user actually pressed.
 */
export function focusIRacingIfEnabled(): void {
  if (!focuser) return;

  if (!isGlobalSettingsInitialized()) return;

  const settings = getGlobalSettings();

  if (!settings.focusIRacingWindow) return;

  let result: number;

  try {
    result = focuser();
  } catch (error) {
    logger.warn(`Failed to focus iRacing window: ${error}`);

    return;
  }

  switch (result) {
    case FocusResult.AlreadyFocused:
      logger.debug("iRacing window already focused");
      break;
    case FocusResult.Focused:
      logger.debug("iRacing window focused successfully");
      break;
    case FocusResult.WindowNotFound:
      // The setting is on by default (#930), so this runs before every key and
      // dial press — including every press made while iRacing is closed, where
      // a missing window is the expected outcome rather than a fault. Log by
      // expectation: debug when nothing says iRacing is running, warn when the
      // app monitor or a live SDK connection says it IS, because then the
      // window really should have been found and the log line is a genuine
      // diagnostic worth having in a support log.
      if (isIRacingActive()) {
        logger.warn("iRacing window not found — is iRacing running?");
      } else {
        logger.debug("iRacing window not found (iRacing is not running)");
      }

      break;
    case FocusResult.FocusTimedOut:
      logger.warn("iRacing window found but focus timed out (1000ms)");
      break;
    default:
      logger.warn(`Unexpected focus result: ${result}`);
      break;
  }
}

/**
 * Reset the service to its uninitialized state.
 *
 * @internal Exported for testing
 */
export function _resetWindowFocus(): void {
  focuser = null;
  logger = silentLogger;
}
