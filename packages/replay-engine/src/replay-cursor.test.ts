import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  cancelReplayCursorOwnerIf,
  claimReplayCursor,
  clearReplayJumpSpeed,
  currentReplayCursorOwner,
  interruptReplayCursorOwnerIf,
  onReplayCursorTaken,
  pendingReplayJumpSpeed,
  recordReplayJumpSpeed,
} from "./replay-cursor.js";

describe("replay-cursor", () => {
  beforeEach(() => {
    _resetReplayCursor();
  });

  it("a claim stands until something takes the cursor", () => {
    const claim = claimReplayCursor("fastest-lap walk");

    expect(claim.owner).toBe("fastest-lap walk");
    expect(claim.cancelledBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe("fastest-lap walk");
  });

  it("a one-shot jump cancels the in-flight claim, names itself, and reports whom it cancelled", () => {
    const onCancelled = vi.fn();
    const claim = claimReplayCursor("fastest-lap walk", onCancelled);

    expect(cancelReplayCursorOwner("next marker")).toBe("fastest-lap walk");
    expect(claim.cancelledBy).toBe("next marker");
    expect(onCancelled).toHaveBeenCalledExactlyOnceWith("next marker");
    expect(currentReplayCursorOwner()).toBeNull();
  });

  it("cancelling with nothing in flight is a no-op that returns null", () => {
    expect(cancelReplayCursorOwner("play-pause")).toBeNull();
  });

  it("a second cancel does not rename the first, and reports nothing cancelled", () => {
    const onCancelled = vi.fn();
    const claim = claimReplayCursor("walk", onCancelled);

    cancelReplayCursorOwner("first");

    expect(cancelReplayCursorOwner("second")).toBeNull();
    expect(claim.cancelledBy).toBe("first");
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("a new claim cancels an earlier one still standing, naming the new owner", () => {
    const onCancelled = vi.fn();
    const first = claimReplayCursor("walk A", onCancelled);
    const second = claimReplayCursor("walk B");

    expect(first.cancelledBy).toBe("walk B");
    expect(onCancelled).toHaveBeenCalledExactlyOnceWith("walk B");
    expect(second.cancelledBy).toBeNull();
    expect(currentReplayCursorOwner()).toBe("walk B");
  });

  it("release hands the cursor back, and is a no-op for a superseded claim", () => {
    const first = claimReplayCursor("walk A");

    first.release();
    expect(currentReplayCursorOwner()).toBeNull();

    const second = claimReplayCursor("walk B");
    const third = claimReplayCursor("walk C");

    // Releasing the superseded claim must not drop the standing one.
    second.release();
    expect(currentReplayCursorOwner()).toBe("walk C");

    third.release();
    expect(currentReplayCursorOwner()).toBeNull();
  });

  it("a released claim was never cancelled: its owner sees no cancelledBy", () => {
    const onCancelled = vi.fn();
    const claim = claimReplayCursor("walk", onCancelled);

    claim.release();

    expect(claim.cancelledBy).toBeNull();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(cancelReplayCursorOwner("later jump")).toBeNull();
  });

  describe("cancelReplayCursorOwnerIf (#801)", () => {
    const WALKS = ["fastest-lap walk", "race-start walk"];

    it.each(WALKS)("cancels a claim held by %s, naming the command", (owner) => {
      const onCancelled = vi.fn();
      const claim = claimReplayCursor(owner, onCancelled);

      expect(cancelReplayCursorOwnerIf(WALKS, "dial-track-order")).toBe(owner);
      expect(claim.cancelledBy).toBe("dial-track-order");
      expect(onCancelled).toHaveBeenCalledExactlyOnceWith("dial-track-order");
      expect(currentReplayCursorOwner()).toBeNull();
    });

    it("leaves any other owner standing, its jump speed kept and no listener told", () => {
      const listener = vi.fn();
      const claim = claimReplayCursor("dial-lap");

      recordReplayJumpSpeed({ speed: 2, slowMotion: false, appliedAt: null });
      const unsubscribe = onReplayCursorTaken(listener);

      expect(cancelReplayCursorOwnerIf(WALKS, "dial-track-order")).toBeNull();
      expect(claim.cancelledBy).toBeNull();
      expect(currentReplayCursorOwner()).toBe("dial-lap");
      expect(pendingReplayJumpSpeed()).not.toBeNull();
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("is a no-op that returns null with nothing in flight, or a claim already cancelled", () => {
      expect(cancelReplayCursorOwnerIf(WALKS, "dial-track-order")).toBeNull();

      claimReplayCursor("fastest-lap walk");
      cancelReplayCursorOwner("play-pause");

      expect(cancelReplayCursorOwnerIf(WALKS, "dial-track-order")).toBeNull();
    });
  });

  describe("interruptReplayCursorOwnerIf (#1428 / #1435)", () => {
    const WALKS = ["fastest-lap walk", "race-start walk"];

    it.each(WALKS)("interrupts a claim held by %s without taking the cursor", (owner) => {
      const onCancelled = vi.fn();
      const claim = claimReplayCursor(owner, onCancelled);

      expect(claim.interruptedBy).toBeNull();
      expect(interruptReplayCursorOwnerIf(WALKS, "next-car")).toBe(owner);
      expect(claim.interruptedBy).toBe("next-car");
      // Still the current claim: not cancelled, its owner still standing, its holder told nothing.
      expect(claim.cancelledBy).toBeNull();
      expect(currentReplayCursorOwner()).toBe(owner);
      expect(onCancelled).not.toHaveBeenCalled();
    });

    it("leaves the pending jump speed and the cursor-taken listeners alone", () => {
      const listener = vi.fn();

      claimReplayCursor("fastest-lap walk");
      recordReplayJumpSpeed({ speed: 4, slowMotion: true, appliedAt: null });
      const unsubscribe = onReplayCursorTaken(listener);

      interruptReplayCursorOwnerIf(WALKS, "next-car");

      expect(pendingReplayJumpSpeed()).toEqual({ speed: 4, slowMotion: true, appliedAt: null });
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("touches no owner outside the list", () => {
      const claim = claimReplayCursor("replay-markers jump");

      expect(interruptReplayCursorOwnerIf(WALKS, "next-car")).toBeNull();
      expect(claim.interruptedBy).toBeNull();
      expect(claim.cancelledBy).toBeNull();
    });

    it("is a no-op that returns null with nothing in flight, a claim already cancelled, or one already interrupted", () => {
      expect(interruptReplayCursorOwnerIf(WALKS, "next-car")).toBeNull();

      const cancelled = claimReplayCursor("fastest-lap walk");

      cancelReplayCursorOwner("play-pause");
      expect(interruptReplayCursorOwnerIf(WALKS, "next-car")).toBeNull();
      expect(cancelled.interruptedBy).toBeNull();

      const walk = claimReplayCursor("race-start walk");

      interruptReplayCursorOwnerIf(WALKS, "next-car");
      // A second interrupt does not rename the first.
      expect(interruptReplayCursorOwnerIf(WALKS, "jump-to-my-car")).toBeNull();
      expect(walk.interruptedBy).toBe("next-car");
    });

    it("an interrupted claim is still cancelled by a take, which names the command", () => {
      const onCancelled = vi.fn();
      const claim = claimReplayCursor("fastest-lap walk", onCancelled);

      interruptReplayCursorOwnerIf(WALKS, "next-car");

      expect(cancelReplayCursorOwner("frame-forward")).toBe("fastest-lap walk");
      expect(claim.cancelledBy).toBe("frame-forward");
      expect(onCancelled).toHaveBeenCalledExactlyOnceWith("frame-forward");
      expect(currentReplayCursorOwner()).toBeNull();
    });
  });

  describe("onReplayCursorTaken (#1316)", () => {
    it("tells a listener on every one-shot command, claim in flight or not", () => {
      const taken = vi.fn();
      const stop = onReplayCursorTaken(taken);

      cancelReplayCursorOwner("play-pause");
      expect(taken).toHaveBeenCalledTimes(1);

      claimReplayCursor("fastest-lap walk");
      taken.mockClear();
      cancelReplayCursorOwner("next marker");
      expect(taken).toHaveBeenCalledTimes(1);
      stop();
    });

    it("tells a listener on a claim", () => {
      const taken = vi.fn();
      const stop = onReplayCursorTaken(taken);

      claimReplayCursor("fastest-lap walk");

      expect(taken).toHaveBeenCalledTimes(1);
      stop();
    });

    it("says nothing for what does not take the cursor: a release, a read", () => {
      const taken = vi.fn();
      const claim = claimReplayCursor("fastest-lap walk");
      const stop = onReplayCursorTaken(taken);

      currentReplayCursorOwner();
      claim.release();

      expect(taken).not.toHaveBeenCalled();
      stop();
    });

    it("stops telling a listener that unsubscribed, and only that one", () => {
      const first = vi.fn();
      const second = vi.fn();
      const stopFirst = onReplayCursorTaken(first);
      const stopSecond = onReplayCursorTaken(second);

      stopFirst();
      cancelReplayCursorOwner("play-pause");

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      stopSecond();
    });

    it("keeps its listeners through a reset: they are wiring, not state", () => {
      const taken = vi.fn();
      const stop = onReplayCursorTaken(taken);

      _resetReplayCursor();
      expect(taken).not.toHaveBeenCalled();

      cancelReplayCursorOwner("play-pause");
      expect(taken).toHaveBeenCalledTimes(1);
      stop();
    });
  });

  describe("the pending jump speed (#1276)", () => {
    const rewinding = { speed: -8, slowMotion: false, appliedAt: null };

    it("is null until a jump records one, and one value process-wide", () => {
      expect(pendingReplayJumpSpeed()).toBeNull();

      recordReplayJumpSpeed(rewinding);
      expect(pendingReplayJumpSpeed()).toBe(rewinding);

      const applied = { speed: 1, slowMotion: false, appliedAt: 10_000 };

      recordReplayJumpSpeed(applied);
      expect(pendingReplayJumpSpeed()).toBe(applied);
    });

    it("anything else taking the cursor clears it — a one-shot command or a new claim", () => {
      recordReplayJumpSpeed(rewinding);
      cancelReplayCursorOwner("play-pause");
      expect(pendingReplayJumpSpeed()).toBeNull();

      recordReplayJumpSpeed(rewinding);
      claimReplayCursor("jump-to-fastest-lap");
      expect(pendingReplayJumpSpeed()).toBeNull();
    });

    it("clears even with no claim in flight, and on an explicit clear and a reset", () => {
      recordReplayJumpSpeed(rewinding);
      expect(cancelReplayCursorOwner("slow-motion")).toBeNull();
      expect(pendingReplayJumpSpeed()).toBeNull();

      recordReplayJumpSpeed(rewinding);
      clearReplayJumpSpeed();
      expect(pendingReplayJumpSpeed()).toBeNull();

      recordReplayJumpSpeed(rewinding);
      _resetReplayCursor();
      expect(pendingReplayJumpSpeed()).toBeNull();
    });
  });
});
