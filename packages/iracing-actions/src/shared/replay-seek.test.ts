import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner, claimReplayCursor } from "./replay-cursor.js";
import { isLandedOn, isPaused, type ReplaySeekSample, seekReplayFrame, waitForReplay } from "./replay-seek.js";

describe("replay-seek", () => {
  beforeEach(() => {
    _resetReplayCursor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isLandedOn", () => {
    it("needs the frame and, by default, a session out of the -1 transient", () => {
      expect(isLandedOn({ ReplayFrameNum: 100, SessionNum: 2 }, 100)).toBe(true);
      expect(isLandedOn({ ReplayFrameNum: 100, SessionNum: -1 }, 100)).toBe(false);
      expect(isLandedOn({ ReplayFrameNum: 99, SessionNum: 2 }, 100)).toBe(false);
      expect(isLandedOn({ ReplayFrameNum: 100 }, 100)).toBe(false);
      expect(isLandedOn(null, 100)).toBe(false);
    });

    it("without requireSession, the frame alone decides", () => {
      expect(isLandedOn({ ReplayFrameNum: 100, SessionNum: -1 }, 100, false)).toBe(true);
      expect(isLandedOn({ ReplayFrameNum: 100 }, 100, false)).toBe(true);
      expect(isLandedOn({ ReplayFrameNum: 99, SessionNum: 2 }, 100, false)).toBe(false);
    });
  });

  describe("isPaused", () => {
    it("is true only for a speed that reads 0; an unknown speed is not paused", () => {
      expect(isPaused({ ReplayPlaySpeed: 0 })).toBe(true);
      expect(isPaused({ ReplayPlaySpeed: 1 })).toBe(false);
      expect(isPaused({ ReplayPlaySpeed: -8 })).toBe(false);
      expect(isPaused({})).toBe(false);
      expect(isPaused(null)).toBe(false);
    });
  });

  describe("waitForReplay", () => {
    it("sends nothing and resolves reached once the predicate holds", async () => {
      const sample: ReplaySeekSample = { ReplayPlaySpeed: 1 };
      const claim = claimReplayCursor("test");
      const result = waitForReplay(
        { claim, readTelemetry: () => ({ ...sample }), timeoutMs: 1000, pollMs: 50 },
        (s): s is ReplaySeekSample => isPaused(s),
      );

      await vi.advanceTimersByTimeAsync(100);
      sample.ReplayPlaySpeed = 0;
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({ kind: "reached", telemetry: { ReplayPlaySpeed: 0 } });
    });
  });

  describe("seekReplayFrame", () => {
    function fixture(initialFrame: number, sessionNum = 0) {
      const sample: ReplaySeekSample = { ReplayFrameNum: initialFrame, SessionNum: sessionNum };
      const send = vi.fn(() => true);
      const readTelemetry = vi.fn(() => ({ ...sample }));

      return { sample, send, readTelemetry };
    }

    it("sends the jump once and resolves reached once the frame reads the target", async () => {
      const { sample, send, readTelemetry } = fixture(90_000);
      const claim = claimReplayCursor("test jump");
      const result = seekReplayFrame({ frame: 64_401, claim, send, readTelemetry, timeoutMs: 1600, pollMs: 50 });

      expect(send).toHaveBeenCalledExactlyOnceWith(64_401);

      await vi.advanceTimersByTimeAsync(300);
      sample.ReplayFrameNum = 64_401;
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({
        kind: "reached",
        telemetry: { ReplayFrameNum: 64_401, SessionNum: 0 },
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("waits out the SessionNum transient by default, and not with requireSession: false", async () => {
      const strict = fixture(64_401, -1);
      const loose = fixture(64_401, -1);
      const strictResult = seekReplayFrame({
        frame: 64_401,
        claim: claimReplayCursor("strict"),
        send: strict.send,
        readTelemetry: strict.readTelemetry,
        timeoutMs: 400,
        pollMs: 50,
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(strictResult).resolves.toMatchObject({ kind: "timeout" });

      const looseResult = seekReplayFrame({
        frame: 64_401,
        claim: claimReplayCursor("loose"),
        send: loose.send,
        readTelemetry: loose.readTelemetry,
        timeoutMs: 400,
        pollMs: 50,
        requireSession: false,
      });

      await vi.advanceTimersByTimeAsync(50);
      await expect(looseResult).resolves.toMatchObject({ kind: "reached" });
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
