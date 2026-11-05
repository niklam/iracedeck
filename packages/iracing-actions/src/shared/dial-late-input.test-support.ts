/**
 * The late-input cases every dial surface shares (#1329, #1589), run from each
 * surface's own test file so they use that file's mocks against the real
 * surface.
 *
 * A host may deliver a dial input event after the context's `willDisappear`.
 * Every surface's `rotate`, `down` and `touchTap` reach their context only
 * through the base's `inputContext`, which drops such an event before any side
 * effect: no entry comes back, no timer is armed (a hold preview, a render
 * throttle) and nothing is sent (a binding tap, a frame). These cases pin that
 * for one surface, and a live case pins that the same drivers do reach a
 * surface that has appeared, so the suite cannot pass on drivers that never
 * arrive.
 *
 * The suite runs under fake timers (it turns them on for its own cases when the
 * file has not) and with the extended gestures compiled in, so a touch's
 * prelude passes and the gate is what drops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Anything whose calls can be counted: a `vi.fn()` or a `vi.spyOn()`. */
export interface CallRecorder {
  readonly mock: { readonly calls: readonly unknown[] };
}

interface LateInputDrivers<C extends { id: string }> {
  /**
   * Put a dial with this id on the deck through the surface's lifecycle path
   * (the action's `onWillAppear`, or the surface's `willAppear`) and return
   * its context. Its settings must make every driven input act: a press and
   * long press, a tap and a long touch that fire something.
   */
  appear(id: string): Promise<C>;
  /** Take the dial off the deck (`onWillDisappear` / `willDisappear`), with any teardown awaited. */
  disappear(ctx: C): Promise<void>;
  /** One detent of rotation on `ctx`, with acting settings. */
  rotate(ctx: C): Promise<void>;
  /** A dial-down on `ctx`, with acting settings. */
  down(ctx: C): Promise<void>;
  /** The surface's per-context map, read as `surface["contextsState"]`. */
  contexts(): ReadonlyMap<string, unknown>;
  /**
   * Every spy on what the surface sends for `ctx`, by name: the context's own
   * (`setDialCanvas`, `setTriggerDescription`, …) and the file's host spies
   * (`tapBinding`, …). Calls made before an event do not count; the suite
   * compares counts across it.
   */
  sent(ctx: C): Record<string, CallRecorder>;
}

/**
 * The release that completes a `down`: with it the live case proves a down
 * arrived (its release fires the press gesture), and the late case proves a
 * release after a dropped down fires nothing. Omitted only with the reason,
 * for a surface whose press gestures fire nothing; such a surface says instead
 * how to tell that a down landed (its context recorded the press), so the live
 * case still proves the down driver reaches it.
 */
type UpDriver<C> =
  | { up(ctx: C): Promise<void>; noUp?: never; downLanded?: never }
  | { up?: never; noUp: string; downLanded(ctx: C): boolean };

/**
 * A touch on `ctx` (`hold` for a long touch), with acting settings. Omitted
 * only with the reason, for a surface that has no touch gesture to drive
 * (Audio Controls).
 */
type TouchTapDriver<C> =
  { touchTap(ctx: C, hold: boolean): Promise<void>; noTouchTap?: never } | { touchTap?: never; noTouchTap: string };

export type LateInputSuite<C extends { id: string }> = LateInputDrivers<C> & UpDriver<C> & TouchTapDriver<C>;

/** Let any fire-and-forget work an event started settle, without running a timer. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function callCounts(spies: Record<string, CallRecorder>): Record<string, number> {
  return Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));
}

export function describeLateInput<C extends { id: string }>(suite: LateInputSuite<C>): void {
  describe("a late input event never re-creates a disappeared context (shared, #1589)", () => {
    let ownsFakeTimers = false;

    beforeEach(() => {
      ownsFakeTimers = !vi.isFakeTimers();

      if (ownsFakeTimers) vi.useFakeTimers();

      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", true);
    });

    afterEach(() => {
      vi.unstubAllGlobals();

      if (ownsFakeTimers) vi.useRealTimers();
    });

    /** Appear, then disappear, then let what the lifecycle armed run out, so the event alone is measured. */
    async function disappeared(id: string): Promise<C> {
      const ctx = await suite.appear(id);
      await suite.disappear(ctx);
      await vi.runOnlyPendingTimersAsync();

      return ctx;
    }

    /** A context on the deck, with what its appear armed run out. */
    async function appeared(id: string): Promise<C> {
      const ctx = await suite.appear(id);
      await vi.runOnlyPendingTimersAsync();

      return ctx;
    }

    /** Run one dropped event: no entry, no new timer, and nothing sent. */
    async function expectDropped(ctx: C, event: () => Promise<void>, after?: () => Promise<void>): Promise<void> {
      const spies = suite.sent(ctx);
      const before = callCounts(spies);
      const timersBefore = vi.getTimerCount();

      await event();
      await settleMicrotasks();

      expect(suite.contexts().has(ctx.id), "the event re-created the context").toBe(false);
      expect(vi.getTimerCount(), "the event armed a timer").toBe(timersBefore);

      if (after) {
        await after();
        await settleMicrotasks();

        expect(suite.contexts().has(ctx.id), "the follow-up re-created the context").toBe(false);
      }

      expect(callCounts(spies), "the event sent something").toEqual(before);
    }

    /** Run one event on a live context: it is still there and the surface sent something for it. */
    async function expectReached(ctx: C, event: () => Promise<void>): Promise<void> {
      const spies = suite.sent(ctx);
      const before = callCounts(spies);

      await event();
      await settleMicrotasks();

      expect(suite.contexts().has(ctx.id)).toBe(true);

      const after = callCounts(spies);
      const hit = Object.keys(after).filter((name) => after[name] > before[name]);

      expect(hit, "the driver never reached the surface: no spy was called").not.toEqual([]);
    }

    it("drops a rotate: no entry, no timer, nothing sent", async () => {
      const ctx = await disappeared("late-input-rotate");

      await expectDropped(ctx, () => suite.rotate(ctx));
    });

    it(`drops a down: no entry, no timer, nothing sent${suite.up ? ", and its release fires nothing" : ""}`, async () => {
      const ctx = await disappeared("late-input-down");
      const up = suite.up;

      await expectDropped(
        ctx,
        () => suite.down(ctx),
        up
          ? async () => {
              await vi.advanceTimersByTimeAsync(1000);
              await up(ctx);
            }
          : undefined,
      );
    });

    const touchTap = suite.touchTap;

    if (touchTap) {
      it.each([false, true])("drops a touchTap (hold %s): no entry, no timer, nothing sent", async (hold) => {
        const ctx = await disappeared(`late-input-touch-${hold}`);

        await expectDropped(ctx, () => touchTap(ctx, hold));
      });
    }

    describe("the same drivers reach a dial that has appeared", () => {
      it("a rotate", async () => {
        const ctx = await appeared("live-input-rotate");

        await expectReached(ctx, () => suite.rotate(ctx));
      });

      const up = suite.up;

      if (up) {
        it("a down, which its release completes", async () => {
          const ctx = await appeared("live-input-down");

          await expectReached(ctx, async () => {
            await suite.down(ctx);
            await up(ctx);
          });
        });
      } else {
        it("a down", async () => {
          const ctx = await appeared("live-input-down");

          await suite.down(ctx);

          expect(suite.contexts().has(ctx.id)).toBe(true);
          expect(suite.downLanded?.(ctx), "the down driver never reached the surface").toBe(true);
        });
      }

      if (touchTap) {
        it.each([false, true])("a touchTap (hold %s)", async (hold) => {
          const ctx = await appeared(`live-input-touch-${hold}`);

          await expectReached(ctx, () => touchTap(ctx, hold));
        });
      }
    });
  });
}
