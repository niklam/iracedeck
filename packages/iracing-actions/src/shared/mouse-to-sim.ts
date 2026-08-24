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
 * deck-core: `window-focus-service` and `mouse-pointer-service` are deliberately
 * independent, and this is the only place that says the two belong together.
 * Since #1029 the composition has a third step — resolving the user's configured
 * pointer target — and the same reasoning applies: `sim-pointer-target` owns the
 * arithmetic and `GlobalSettingsSchema` owns the persistence, while knowing that
 * this feature is what those two describe stays here.
 * `focusIRacingNow()` rather than `focusIRacingIfEnabled()` because pressing this
 * key is explicit user intent, so it ignores the `focusIRacingWindow` opt-out that
 * gates the implicit before-every-action focus.
 *
 * Best-effort throughout: every failure is logged and swallowed. Moving a pointer
 * has no effect on the car, so degrading to a no-op is always safe.
 *
 * Note: the focus call blocks the JS main thread for up to 1000 ms while Windows
 * confirms the foreground change. This is not new — the plugin-level
 * `focusIRacingIfEnabled()` already does exactly this before every key press when
 * the global setting is on.
 */
import {
  focusIRacingNow,
  FocusResult,
  getGlobalSettings,
  movePointerToSim,
  PointerMoveResult,
  resolveSimPointerTarget,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

/**
 * Focus the iRacing window and park the mouse pointer inside it.
 *
 * @param logger - Logger for the outcome line
 */
export function bringPointerToSim(logger: ILogger): void {
  try {
    const focusResult = focusIRacingNow();

    // Nothing to point at — we looked and iRacing is not running. The focus
    // service already logged it, so a second message here would only be noise.
    // ONLY this code short-circuits: a `null` result means the focus call could
    // not be made at all (no focuser injected, or it threw), which says nothing
    // about the window and must not suppress an independent pointer move.
    if (focusResult === FocusResult.WindowNotFound) {
      return;
    }

    // A focus timeout is not fatal here either: the window exists, so its client
    // area is still a valid pointer target even if the foreground swap lagged.
    // Where the pointer goes is the user's choice (#1029). Read on every press
    // rather than caching: the settings window can change it between two presses.
    // No `isSettingsStoreReady()` gate — the schema defaults ARE the pre-#1029
    // placement, so a press before the store loads lands exactly where it always
    // did, whereas gating would make it do nothing at all.
    const settings = getGlobalSettings();
    const target = resolveSimPointerTarget({
      anchorX: settings.mouseToSimAnchorX,
      anchorY: settings.mouseToSimAnchorY,
      offsetX: settings.mouseToSimOffsetX,
      offsetY: settings.mouseToSimOffsetY,
    });

    if (movePointerToSim(target.xFraction, target.yFraction) === PointerMoveResult.Moved) {
      logger.info("Mouse pointer brought to the iRacing window");
    }
  } catch (error) {
    logger.warn(`Failed to bring the mouse pointer to the sim: ${error instanceof Error ? error.message : error}`);
  }
}
