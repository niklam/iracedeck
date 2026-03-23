/**
 * Window Focus Service
 *
 * Provides a centralized function to focus the iRacing window before
 * sending inputs. Called from the plugin-level event handlers to ensure
 * it runs for all actions regardless of whether they use keyboard
 * shortcuts or SDK commands.
 *
 * The focuser callback is provided during initialization and typically
 * wraps the native focusIRacingWindow() function.
 */
import { getGlobalSettings, isGlobalSettingsInitialized } from "@iracedeck/deck-core";
import { FocusResult } from "@iracedeck/iracing-native";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

/**
 * Function type for focusing the iRacing window.
 * Returns a FocusResult status code.
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
 * Focus the iRacing window if the global setting is enabled.
 * Best-effort: logs a warning on failure but does not throw.
 *
 * Called from plugin-level onKeyDown/onDialDown/onDialRotate handlers
 * so it runs before every action, regardless of whether the action
 * uses keyboard shortcuts or SDK commands.
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
      logger.warn("iRacing window not found — is iRacing running?");
      break;
    case FocusResult.FocusTimedOut:
      logger.warn("iRacing window found but focus timed out (1000ms)");
      break;
    default:
      logger.warn(`Unexpected focus result: ${result}`);
      break;
  }
}
