import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner, claimReplayCursor } from "./replay-cursor.js";
import { isLandedOn, type ReplaySeekSample, seekReplayFrame } from "./replay-seek.js";

describe("replay-seek", () => {
  beforeEach(() => {
    _resetReplayCursor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isLandedOn", () => {
    it("needs the frame and a session out of the -1 transient", () => {
      expect(isLandedOn({ ReplayFrameNum: 100, SessionNum: 2 }, 100)).toBe(true);
      expect(isLandedOn({ ReplayFrameNum: 100, SessionNum: -1 }, 100)).toBe(false);
      expect(isLandedOn({ ReplayFrameNum: 99, SessionNum: 2 }, 100)).toBe(false);
      expect(isLandedOn({ ReplayFrameNum: 100 }, 100)).toBe(false);
      expect(isLandedOn(null, 100)).toBe(false);
    });
  });

  describe("seekReplayFrame", () => {
    function fixture(initialFrame: number) {
      const sample: ReplaySeekSample = { ReplayFrameNum: initialFrame, SessionNum: 0 };
      const send = vi.fn(() => true);
      const readTelemetry = vi.fn(() => ({ ...sample }));

      return { sample, send, readTelemetry };
    }

    it("sends the jump once and resolves landed once the frame reads the target", async () => {
      const { sample, send, readTelemetry } = fixture(90_000);
      const claim = claimReplayCursor("test jump");
      const result = seekReplayFrame({ frame: 64_401, claim, send, readTelemetry, timeoutMs: 1600, pollMs: 50 });

      expect(send).toHaveBeenCalledExactlyOnceWith(64_401);

      await vi.advanceTimersByTimeAsync(300);
      sample.ReplayFrameNum = 64_401;
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({
        kind: "landed",
        telemetry: { ReplayFrameNum: 64_401, SessionNum: 0 },
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("times out with the last sample when the frame never reads the target", async () => {
      const { send, readTelemetry } = fixture(70_545);
      const claim = claimReplayCursor("test jump");
      const result = seekReplayFrame({ frame: 64_401, claim, send, readTelemetry, timeoutMs: 400, pollMs: 50 });

      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toEqual({
        kind: "timeout",
        telemetry: { ReplayFrameNum: 70_545, SessionNum: 0 },
      });
    });

    it("reports cancelled at the next poll once another command takes the cursor", async () => {
      const { sample, send, readTelemetry } = fixture(90_000);
      const claim = claimReplayCursor("test jump");
      const result = seekReplayFrame({ frame: 64_401, claim, send, readTelemetry, timeoutMs: 1600, pollMs: 50 });

      await vi.advanceTimersByTimeAsync(100);
      cancelReplayCursorOwner("next marker");
      // Even a landing in the same window is not reported: the cursor is no longer ours.
      sample.ReplayFrameNum = 64_401;
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({ kind: "cancelled", by: "next marker" });
    });

    it("sends nothing when the claim is already cancelled", async () => {
      const { send, readTelemetry } = fixture(90_000);
      const claim = claimReplayCursor("test jump");

      cancelReplayCursorOwner("play-pause");

      await expect(
        seekReplayFrame({ frame: 64_401, claim, send, readTelemetry, timeoutMs: 1600, pollMs: 50 }),
      ).resolves.toEqual({ kind: "cancelled", by: "play-pause" });
      expect(send).not.toHaveBeenCalled();
    });
  });
});
