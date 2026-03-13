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
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";

/**
 * Function type for focusing the iRacing window.
 * Returns true if the window was found and focused (or already focused).
 */
export type WindowFocuser = () => boolean;

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

  let success = false;

  try {
    success = focuser();
  } catch (error) {
    logger.warn(`Failed to focus iRacing window: ${error}`);

    return;
  }

  if (!success) {
    logger.warn("Failed to focus iRacing window (window not found or timed out)");
  } else {
    logger.debug("Focused iRacing window before sending key");
  }
}
