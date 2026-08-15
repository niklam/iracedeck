/**
 * Window Service Singleton
 *
 * Owns every OS-level interaction with the iRacing window: bringing it to the
 * foreground, and placing the mouse pointer inside it. The platform calls are
 * supplied at init time by the plugin entry point (typically the
 * `@iracedeck/iracing-native` implementations), keeping deck-core
 * platform-agnostic.
 *
 * Replaces the three byte-identical per-plugin `shared/window-focus.ts` modules
 * (issue #926): the pointer feature has to be reachable from action code, which
 * those modules were not, and one implementation beats three copies.
 *
 * Usage:
 * 1. Call initializeWindowService() once at plugin startup
 * 2. Register focusIRacingIfEnabled() on the adapter's key/dial events
 * 3. Use getWindowService() in action code for explicit window/pointer control
 *
 * @example
 * // In plugin.ts (entry point)
 * import { initializeWindowService, focusIRacingIfEnabled } from "@iracedeck/deck-core";
 * import { IRacingNative } from "@iracedeck/iracing-native";
 *
 * const native = new IRacingNative();
 * initializeWindowService(logger, {
 *   focuser: () => native.focusIRacingWindow(),
 *   pointerMover: (x, y) => native.moveMouseToIRacingWindow(x, y),
 * });
 * adapter.onKeyDown(() => focusIRacingIfEnabled());
 *
 * // In action files
 * import { getWindowService } from "@iracedeck/deck-core";
 *
 * getWindowService().focus();
 * getWindowService().movePointerToSim();
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";

/**
 * Result codes returned by the window focuser.
 *
 * Declared here rather than imported from `@iracedeck/iracing-native` so
 * deck-core stays platform-agnostic — the same reason `ScanKeySender` and
 * friends are declared locally. The numbering is the cross-package contract and
 * is asserted by tests on both sides, so a drift breaks a test rather than a user.
 */
export enum WindowFocusResult {
  /**
   * The call could not be attempted at all: no focuser was injected, or it threw.
   * A deck-core-only sentinel — the native layer never returns it, which is why it
   * sits outside the 0..3 contract range. Distinct from {@link WindowFocusResult.WindowNotFound},
   * which means we DID look and iRacing was not running.
   */
  Unavailable = -1,
  /** Window was already in the foreground */
  AlreadyFocused = 0,
  /** Window was found and successfully focused */
  Focused = 1,
  /** No window with the expected title exists */
  WindowNotFound = 2,
  /** Window was found but focus did not transfer within the native timeout */
  FocusTimedOut = 3,
}

/**
 * Result codes returned by the pointer mover.
 * See {@link WindowFocusResult} on why the numbering is duplicated here.
 */
export enum PointerMoveResult {
  /** The call could not be attempted: no pointer mover was injected, or it threw. See {@link WindowFocusResult.Unavailable}. */
  Unavailable = -1,
  /** The cursor was placed inside the sim's client area */
  Moved = 0,
  /** No window with the expected title exists */
  WindowNotFound = 1,
  /** The window was found but the move failed (including a minimized window) */
  Failed = 2,
}

/** Brings the iRacing window to the foreground. Returns a {@link WindowFocusResult} code. */
export type WindowFocuser = () => number;

/**
 * Moves the OS mouse pointer into the iRacing window's client area.
 * Both arguments are fractions of the client area (0 = left/top, 1 = right/bottom).
 * Returns a {@link PointerMoveResult} code.
 */
export type SimPointerMover = (xFraction: number, yFraction: number) => number;

/** Horizontally centered in the sim's client area. */
export const DEFAULT_POINTER_X_FRACTION = 0.5;

/**
 * One eighth down from the top of the client area. This lands on iRacing's own
 * top-of-screen UI band rather than the middle of the track view, so the pointer
 * arrives where there is actually something to click.
 */
export const DEFAULT_POINTER_Y_FRACTION = 0.125;

/** Platform calls injected by the plugin entry point. */
export interface WindowServiceDelegates {
  focuser?: WindowFocuser;
  pointerMover?: SimPointerMover;
}

/**
 * Interface for the window service.
 */
export interface IWindowService {
  /**
   * Bring the iRacing window to the foreground, regardless of the
   * `focusIRacingWindow` global setting. For explicit user intent.
   */
  focus(): WindowFocusResult;

  /**
   * Bring the iRacing window to the foreground only when the
   * `focusIRacingWindow` global setting is enabled. For the plugin-level
   * before-every-action listeners.
   */
  focusIfEnabled(): void;

  /**
   * Move the OS mouse pointer into the iRacing window's client area.
   *
   * @param xFraction - horizontal position, defaults to {@link DEFAULT_POINTER_X_FRACTION}
   * @param yFraction - vertical position, defaults to {@link DEFAULT_POINTER_Y_FRACTION}
   */
  movePointerToSim(xFraction?: number, yFraction?: number): PointerMoveResult;
}

class WindowService implements IWindowService {
  /** Delegate names already reported as missing, so the warning fires once per service. */
  private readonly warnedMissing = new Set<string>();

  constructor(
    private readonly logger: ILogger,
    private readonly delegates: WindowServiceDelegates,
  ) {}

  focus(): WindowFocusResult {
    const focuser = this.delegates.focuser;

    if (!focuser) {
      // Warn once per service, not once per call: focusIfEnabled() runs before
      // EVERY key press, so a per-call warning would flood the log.
      this.warnOnce("focuser", "Window service has no focuser configured");

      return WindowFocusResult.Unavailable;
    }

    let result: number;

    try {
      result = focuser();
    } catch (error) {
      this.logger.warn(`Failed to focus iRacing window: ${error instanceof Error ? error.message : error}`);

      return WindowFocusResult.Unavailable;
    }

    this.logFocusResult(result);

    return result as WindowFocusResult;
  }

  focusIfEnabled(): void {
    if (!isGlobalSettingsInitialized()) return;

    if (!getGlobalSettings().focusIRacingWindow) return;

    this.focus();
  }

  movePointerToSim(
    xFraction: number = DEFAULT_POINTER_X_FRACTION,
    yFraction: number = DEFAULT_POINTER_Y_FRACTION,
  ): PointerMoveResult {
    const pointerMover = this.delegates.pointerMover;

    if (!pointerMover) {
      this.warnOnce("pointerMover", "Window service has no pointer mover configured");

      return PointerMoveResult.Unavailable;
    }

    let result: number;

    try {
      result = pointerMover(xFraction, yFraction);
    } catch (error) {
      this.logger.warn(`Failed to move pointer to iRacing window: ${error instanceof Error ? error.message : error}`);

      return PointerMoveResult.Unavailable;
    }

    this.logPointerResult(result);

    return result as PointerMoveResult;
  }

  /** Warns about a missing delegate the first time only — these run per key press. */
  private warnOnce(key: string, message: string): void {
    if (this.warnedMissing.has(key)) return;

    this.warnedMissing.add(key);
    this.logger.warn(message);
  }

  private logFocusResult(result: number): void {
    switch (result) {
      case WindowFocusResult.AlreadyFocused:
        this.logger.debug("iRacing window already focused");
        break;
      case WindowFocusResult.Focused:
        this.logger.debug("iRacing window focused successfully");
        break;
      case WindowFocusResult.WindowNotFound:
        this.logger.warn("iRacing window not found — is iRacing running?");
        break;
      case WindowFocusResult.FocusTimedOut:
        this.logger.warn("iRacing window found but focus timed out (1000ms)");
        break;
      default:
        this.logger.warn(`Unexpected focus result: ${result}`);
        break;
    }
  }

  private logPointerResult(result: number): void {
    switch (result) {
      case PointerMoveResult.Moved:
        this.logger.debug("Mouse pointer moved into the iRacing window");
        break;
      case PointerMoveResult.WindowNotFound:
        this.logger.warn("iRacing window not found — is iRacing running?");
        break;
      case PointerMoveResult.Failed:
        this.logger.warn("iRacing window found but the pointer could not be moved (is it minimized?)");
        break;
      default:
        this.logger.warn(`Unexpected pointer move result: ${result}`);
        break;
    }
  }
}

let windowService: WindowService | null = null;

/**
 * Initialize the window service singleton.
 * Should be called once at plugin startup.
 *
 * @param logger - Optional logger for window service logging
 * @param delegates - Optional platform calls. A missing delegate degrades that
 *   operation to a logged no-op rather than throwing, so a plugin on a platform
 *   without the native addon still starts.
 * @returns The initialized window service
 * @throws Error if called more than once
 */
export function initializeWindowService(
  logger: ILogger = silentLogger,
  delegates: WindowServiceDelegates = {},
): IWindowService {
  if (windowService) {
    throw new Error("Window service already initialized. initializeWindowService() should only be called once.");
  }

  windowService = new WindowService(logger, delegates);

  return windowService;
}

/**
 * Get the window service for focusing iRacing and placing the mouse pointer.
 *
 * @returns The window service instance
 * @throws Error if the window service hasn't been initialized
 */
export function getWindowService(): IWindowService {
  if (!windowService) {
    throw new Error("Window service not initialized. Call initializeWindowService() first in your plugin entry point.");
  }

  return windowService;
}

/**
 * Check if the window service has been initialized.
 */
export function isWindowServiceInitialized(): boolean {
  return windowService !== null;
}

/**
 * Focus the iRacing window if the `focusIRacingWindow` global setting is enabled.
 *
 * A free function rather than a bare `getWindowService()` call because the
 * plugin-level onKeyDown/onDialDown/onDialRotate listeners run before every
 * action and must never throw: this is a silent no-op when the service has not
 * been initialized.
 */
export function focusIRacingIfEnabled(): void {
  windowService?.focusIfEnabled();
}

/**
 * Reset the window service singleton (for testing purposes only).
 * @internal
 */
export function _resetWindowService(): void {
  windowService = null;
}
