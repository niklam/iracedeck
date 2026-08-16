/**
 * Mouse Pointer Service
 *
 * Places the OS mouse pointer inside the iRacing window (issue #926). Motivated
 * by VR: from inside a headset the pointer is invisible, so on a multi-monitor
 * desktop it has to be hunted blind before anything in the sim can be clicked.
 *
 * Sibling of `window-focus-service.ts`, deliberately kept separate: that module
 * owns getting iRacing to the FOREGROUND (and the `focusIRacingWindow` opt-out
 * gating around it), this one owns where the POINTER goes. Neither needs the
 * other to work, and the composition of the two — focus, then move — is feature
 * policy that lives with the feature, in `@iracedeck/iracing-actions`.
 *
 * The mover itself is injected at startup (the same dependency-injection shape
 * as `keyboard-service` and `window-focus-service`): the actual pointer handling
 * lives in the native addon, and deck-core must stay platform-agnostic, so this
 * module never imports `@iracedeck/iracing-native`.
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

/**
 * Status codes a {@link SimPointerMover} may return.
 *
 * MIRROR of the `PointerMoveResult` enum in `@iracedeck/iracing-native` — for the
 * same reason `FocusResult` is mirrored in `window-focus-service.ts`: importing
 * that package loads the native addon as a module side effect, which a
 * platform-agnostic, heavily unit-tested package must not do. The values are part
 * of the native contract: keep them in sync with
 * `packages/iracing-native/src/index.ts`. `pointer-move-result.test.ts` in the
 * Stream Deck plugin — which depends on both packages — asserts the two stay
 * identical.
 */
export const PointerMoveResult = {
  /** The cursor was placed inside the sim's client area */
  Moved: 0,
  /** No window with the expected title exists */
  WindowNotFound: 1,
  /** The window was found but the move failed (including a minimized window) */
  Failed: 2,
} as const;

export type PointerMoveResult = (typeof PointerMoveResult)[keyof typeof PointerMoveResult];

/**
 * Function that moves the OS mouse pointer into the iRacing window's client area.
 * Both arguments are fractions of the client area (0 = left/top, 1 = right/bottom).
 * Returns a {@link PointerMoveResult} status code.
 */
export type SimPointerMover = (xFraction: number, yFraction: number) => PointerMoveResult;

/** Horizontally centered in the sim's client area. */
export const DEFAULT_POINTER_X_FRACTION = 0.5;

/**
 * One eighth down from the top of the client area. This lands on iRacing's own
 * top-of-screen UI band rather than the middle of the track view, so the pointer
 * arrives where there is actually something to click.
 *
 * The target is expressed as a fraction, and passed through to the native call as
 * one, so the placement policy lives here rather than in the addon — the same
 * split as the caller-supplied chat delays and `sendScanKeySequence`'s `holdMs`.
 */
export const DEFAULT_POINTER_Y_FRACTION = 0.125;

let mover: SimPointerMover | null = null;
let logger: ILogger = silentLogger;

/**
 * Initialize the mouse pointer service.
 * Should be called once at plugin startup.
 *
 * @param log - Logger instance
 * @param pointerMover - Function that moves the pointer into the iRacing window
 */
export function initMousePointer(log: ILogger, pointerMover: SimPointerMover): void {
  if (mover) {
    throw new Error("Mouse pointer service already initialized. initMousePointer() should only be called once.");
  }

  logger = log;
  mover = pointerMover;
}

/**
 * Move the OS mouse pointer into the iRacing window's client area.
 *
 * Best-effort: logs on failure but never throws, so a pointer problem can't stop
 * the action the user actually pressed. Deliberately NOT gated on the
 * `focusIRacingWindow` setting — that setting governs the implicit
 * before-every-action focus, while this only ever runs from an explicit press.
 *
 * @param xFraction - horizontal position, defaults to {@link DEFAULT_POINTER_X_FRACTION}
 * @param yFraction - vertical position, defaults to {@link DEFAULT_POINTER_Y_FRACTION}
 * @returns the {@link PointerMoveResult}, or `null` when the call could not be
 *   made at all (no mover injected, or it threw). `null` says nothing about the
 *   window — callers must not read it as "iRacing is not running".
 */
export function movePointerToSim(
  xFraction: number = DEFAULT_POINTER_X_FRACTION,
  yFraction: number = DEFAULT_POINTER_Y_FRACTION,
): PointerMoveResult | null {
  // Silent, like the focus service's own uninitialized path: before init there is
  // no injected logger to warn through, so a message here would go nowhere.
  if (!mover) return null;

  let result: PointerMoveResult;

  try {
    result = mover(xFraction, yFraction);
  } catch (error) {
    logger.warn(`Failed to move pointer to iRacing window: ${error}`);

    return null;
  }

  switch (result) {
    case PointerMoveResult.Moved:
      logger.debug("Mouse pointer moved into the iRacing window");
      break;
    case PointerMoveResult.WindowNotFound:
      // Unlike the before-every-action focus, this only runs on an explicit
      // press, so the user is actively expecting something to happen — a missing
      // window is worth a warn rather than a debug even when iRacing is closed.
      logger.warn("iRacing window not found — is iRacing running?");
      break;
    case PointerMoveResult.Failed:
      logger.warn("iRacing window found but the pointer could not be moved (is it minimized?)");
      break;
    default:
      logger.warn(`Unexpected pointer move result: ${result}`);
      break;
  }

  return result;
}

/**
 * Reset the service to its uninitialized state.
 *
 * @internal Exported for testing
 */
export function _resetMousePointer(): void {
  mover = null;
  logger = silentLogger;
}
