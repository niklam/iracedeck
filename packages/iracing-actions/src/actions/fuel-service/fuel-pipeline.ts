/**
 * Shared iRacing fuel-request pipeline (issue #759).
 *
 * Both Fuel Service surfaces (keypad buttons and the dial) drive the SAME
 * single iRacing pit fuel request, so the request-level bookkeeping — "was the
 * last pit command a deliberate clear?" — is action-wide, not per-surface or
 * per-context. One pipeline instance per FuelService action instance.
 */
import { getCommands } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

export class FuelPipeline {
  /**
   * Whether the last pit command this action sent was a clear (dedup guard,
   * and the fill-to monitor's "deliberately cleared" signal — see the dial
   * surface's continuous-monitoring comments).
   */
  private lastClear = false;
  /**
   * Last observed fuel-fill state, to detect the OFF→ON edge in
   * {@link observeFuelFill}. When fuel becomes armed (by us OR anything
   * external — the in-sim checkbox, another deck button), the dedup guard is
   * released so a later clear isn't wrongly skipped.
   */
  private lastFuelFillObserved = false;

  constructor(private readonly logger: ILogger) {}

  /** Whether the last pit command this pipeline sent was a clear. */
  get lastPitWasClear(): boolean {
    return this.lastClear;
  }

  /** Sends a `pit.fuel` request and records that the last pit command was not a clear. */
  fuel(liters: number): boolean {
    const success = getCommands().pit.fuel(liters);
    this.lastClear = false;

    return success;
  }

  /** Arms the fuel-fill checkbox keeping the existing banked amount (`pit.fuel(0)`). */
  arm(): boolean {
    return this.fuel(0);
  }

  /**
   * Clears the fuel checkbox — but never twice in a row. A redundant repeat
   * (e.g. a throttle's trailing flush landing on an already-cleared request) is
   * skipped so iRacing isn't sent back-to-back clears.
   */
  clearFuel(): boolean {
    if (this.lastClear) return true;

    return this.forceClearFuel();
  }

  /**
   * Clears the fuel checkbox unconditionally. For paths where the arming
   * happened OUTSIDE this pipeline — an explicit Clear Fuel press, or the
   * follow-up clear after a lap-margin black-box tap armed fueling — the dedup
   * guard must not suppress the send.
   */
  forceClearFuel(): boolean {
    const success = getCommands().pit.clearFuel();
    this.lastClear = true;

    return success;
  }

  /**
   * Sends a fuel request through the single entry point, mapping a resolved
   * add of 0 (or less) to a clear instead of `pit.fuel(0)`. The iRacing SDK
   * treats `pit.fuel(0)` as "keep the existing amount", NOT "request zero", so
   * a computed add of 0 must clear the request to mean "don't add anything"
   * (issue #681). Any non-zero add goes through `pit.fuel`, which arms the
   * fuel-fill checkbox per iRacing's default behaviour.
   */
  sendFuel(addLtr: number): void {
    if (addLtr <= 0) {
      this.clearFuel();
      this.logger.debug("Resolved add is 0 — cleared fueling instead of requesting 0 L");

      return;
    }

    this.fuel(addLtr);
  }

  /**
   * Empties the pit fuel request: set a minimal 1 L, then clear the checkbox. The
   * pit fuel broadcast is an UNSIGNED int, so a negative wraps to a huge positive
   * (e.g. −120 → 65416), and `pit.fuel(0)` means "keep existing" — so 1 L is the
   * smallest value that actually resets the requested amount, after which
   * `pit.clearFuel` unchecks the box.
   */
  sendNoFuel(): void {
    this.fuel(1);
    this.clearFuel();
    this.logger.debug("No fuel — set 1 L then cleared");
  }

  /**
   * Feeds the live fuel-fill checkbox state on every telemetry tick. Releases
   * the no-double-clear guard on the OFF→ON edge: once fuel is armed again (by
   * us OR anything external — the in-sim checkbox, a lap-margin black-box tap),
   * a later clear is meaningful and must not be skipped. Edge-triggered so it
   * never fires during the lag after our own clear (fuel reads ON→OFF there,
   * not OFF→ON).
   */
  observeFuelFill(on: boolean): void {
    if (on && !this.lastFuelFillObserved) this.lastClear = false;

    this.lastFuelFillObserved = on;
  }
}
