/**
 * Test support for "this action takes the replay cursor before it sends"
 * (#1334). Shared by the tests of every action that sends replay commands
 * outside Replay Control, so the cursor contract they assert lives once.
 * Imported only by tests; nothing in the plugin bundle reaches it.
 */
import { expect, type Mock, vi } from "vitest";

import {
  _resetReplayCursor,
  claimReplayCursor,
  currentReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
} from "./replay-cursor.js";

export interface ReplayCursorProbe<C extends string> {
  /** Stand-in replay commands; each records its name when sent and returns `true`. */
  readonly replay: Record<C, Mock<() => boolean>>;
  /**
   * The walk was cancelled by `owner` before anything was sent, `sentCommand`
   * was the one command sent, and the cursor and the marker landing are free.
   */
  expectTakenBefore(owner: string, sentCommand: C): void;
  /** Nothing was sent, and the walk and the marker landing both stand. */
  expectUntouched(): void;
}

/**
 * Resets the replay cursor, then stages a Jump to Fastest Lap walk in flight
 * and a pending marker landing. Call it in `beforeEach` and hand `replay` to
 * the mocked `getCommands()`.
 */
export function stageReplayCursorProbe<C extends string>(commands: readonly C[]): ReplayCursorProbe<C> {
  _resetReplayCursor();
  const sent: string[] = [];
  let cancelledBy: string | null = null;
  let sentAtCancel: number | null = null;

  const replay = Object.fromEntries(
    commands.map((name) => [
      name,
      vi.fn(() => {
        sent.push(name);

        return true;
      }),
    ]),
  ) as Record<C, Mock<() => boolean>>;

  claimReplayCursor("jump-to-fastest-lap", (by) => {
    cancelledBy = by;
    sentAtCancel = sent.length;
  });
  recordReplayLanding(4_000, 10_000);

  return {
    replay,
    expectTakenBefore(owner, sentCommand) {
      expect(cancelledBy).toBe(owner);
      expect(sentAtCancel).toBe(0);
      expect(sent).toEqual([sentCommand]);
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayLanding()).toBeNull();
    },
    expectUntouched() {
      expect(sent).toEqual([]);
      expect(cancelledBy).toBeNull();
      expect(currentReplayCursorOwner()).toBe("jump-to-fastest-lap");
      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: 10_000 });
    },
  };
}

/** The parts of a key or dial event the replay actions read. */
export interface CursorTestEvent {
  readonly action: { readonly id: string; readonly setTitle: Mock; readonly setImage: Mock };
  readonly payload: { readonly settings: Record<string, unknown>; readonly ticks: number };
}

/** A key or dial event carrying `settings`, and `ticks` for a dial turn. */
export function cursorTestEvent(settings: Record<string, unknown>, ticks = 0): CursorTestEvent {
  return { action: { id: "ctx-cursor", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings, ticks } };
}
