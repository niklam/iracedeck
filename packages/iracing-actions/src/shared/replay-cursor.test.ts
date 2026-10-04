import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  clearReplayLanding,
  currentReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
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

  describe("the pending landing (#1230)", () => {
    it("is null until a jump records one, and then names its frame and send time", () => {
      expect(pendingReplayLanding()).toBeNull();

      recordReplayLanding(4_000, 10_000);

      expect(pendingReplayLanding()).toEqual({ frame: 4_000, sentAt: 10_000 });
    });

    it("one value, process-wide: a later jump replaces the earlier one", () => {
      recordReplayLanding(4_000, 10_000);
      recordReplayLanding(6_000, 10_050);

      expect(pendingReplayLanding()).toEqual({ frame: 6_000, sentAt: 10_050 });
    });

    it("anything else taking the cursor clears it — a one-shot command or a new claim", () => {
      recordReplayLanding(4_000, 10_000);
      cancelReplayCursorOwner("play-pause");
      expect(pendingReplayLanding()).toBeNull();

      recordReplayLanding(4_000, 10_000);
      claimReplayCursor("jump-to-fastest-lap");
      expect(pendingReplayLanding()).toBeNull();
    });

    it("clears even with no claim in flight, and on an explicit clear and a reset", () => {
      recordReplayLanding(4_000, 10_000);
      expect(cancelReplayCursorOwner("rewind")).toBeNull();
      expect(pendingReplayLanding()).toBeNull();

      recordReplayLanding(4_000, 10_000);
      clearReplayLanding();
      expect(pendingReplayLanding()).toBeNull();

      recordReplayLanding(4_000, 10_000);
      _resetReplayCursor();
      expect(pendingReplayLanding()).toBeNull();
    });
  });
});
