/**
 * Mouse to Sim (issue #926) — the single definition of the "bring the pointer
 * into iRacing" behavior, shared by the View Adjustment keypad mode and its dial
 * gesture so neither surface reimplements the policy.
 *
 * Motivated by VR: from inside a headset the mouse pointer is invisible, so a
 * driver on a multi-monitor desktop cannot find it to click anything in the sim.
 *
 * The composition order (focus first, then move) and the decision to focus
 * unconditionally are FEATURE policy, which is why they live here rather than in
 * deck-core's window service: pressing this key is explicit user intent, so it
 * deliberately ignores the `focusIRacingWindow` global setting that gates the
 * plugin-level before-every-action focus.
 *
 * Best-effort throughout: every failure is logged and swallowed. Moving a pointer
 * has no effect on the car, so degrading to a no-op is always safe.
 *
 * Note: the focus call blocks the JS main thread for up to 1000 ms while Windows
 * confirms the foreground change. This is not new — the plugin-level
 * `focusIRacingIfEnabled()` already does exactly this before every key press when
 * the global setting is on.
 */
import { getWindowService, PointerMoveResult, WindowFocusResult } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

/**
 * Focus the iRacing window and park the mouse pointer inside it.
 *
 * @param logger - Logger for the outcome line
 */
export function bringPointerToSim(logger: ILogger): void {
  try {
    const windowService = getWindowService();
    const focusResult = windowService.focus();

    // Nothing to point at. The window service already warned about the missing
    // window, so a second warning for the same cause would only be noise.
    if (focusResult === WindowFocusResult.WindowNotFound) {
      return;
    }

    // A focus timeout is not fatal here: the window exists, so its client area
    // is still a valid pointer target even if the foreground swap lagged.
    const moveResult = windowService.movePointerToSim();

    if (moveResult === PointerMoveResult.Moved) {
      logger.info("Mouse pointer brought to the iRacing window");
    }
  } catch (error) {
    logger.warn(`Failed to bring the mouse pointer to the sim: ${error instanceof Error ? error.message : error}`);
  }
}
