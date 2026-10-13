import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner, claimReplayCursor } from "./replay-cursor.js";
import {
  isLandedOn,
  isPaused,
  isSeeking,
  type ReplaySeekSample,
  replaySeekWaitMs,
  seekReplayFrame,
  waitForReplay,
} from "./replay-seek.js";

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

  describe("replaySeekWaitMs (#1354)", () => {
    it("is the floor for a jump the sim finishes well inside it", () => {
      expect(replaySeekWaitMs(30_000, 1600)).toBe(1600);
      expect(replaySeekWaitMs(0, 1600)).toBe(1600);
    });

    it("grows with the distance: twice the time at 2048 frames a sim update", () => {
      // 400,000 frames is 196 updates, 3.27 s; measured landings sit on that slope.
      expect(replaySeekWaitMs(400_000, 1600)).toBe(6534);
      expect(replaySeekWaitMs(195_000, 1600)).toBeGreaterThan(2 * 1495);
    });

    it("keeps a floor the user raised", () => {
      expect(replaySeekWaitMs(400_000, 8000)).toBe(8000);
    });

    it("is the floor for a distance that is no number", () => {
      expect(replaySeekWaitMs(Number.NaN, 1600)).toBe(1600);
      expect(replaySeekWaitMs(-5, 1600)).toBe(1600);
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

  describe("isSeeking", () => {
    it("is a sample with no replay on screen and nobody driving", () => {
      expect(isSeeking({ IsReplayPlaying: false, ReplayFrameNum: 0 })).toBe(true);
      expect(isSeeking({ IsReplayPlaying: false, IsOnTrack: false })).toBe(true);
    });

    it("is not a replay on screen, a driver on track, or a sample that does not say", () => {
      expect(isSeeking({ IsReplayPlaying: true, ReplayFrameNum: 0 })).toBe(false);
      expect(isSeeking({ IsReplayPlaying: false, IsOnTrack: true })).toBe(false);
      expect(isSeeking({ ReplayFrameNum: 0 })).toBe(false);
      expect(isSeeking(null)).toBe(false);
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

  describe("waiting out a seek that shows (#1276)", () => {
    it("does not run the timeout while a read shows the seek, and runs it once none does", async () => {
      const sample: ReplaySeekSample = { ReplayFrameNum: 0, IsReplayPlaying: false };
      const claim = claimReplayCursor("test jump");
      let outcome: string | null = null;

      void waitForReplay(
        { claim, readTelemetry: () => ({ ...sample }), timeoutMs: 1000, pollMs: 50, seeking: isSeeking },
        (s): s is ReplaySeekSample => isLandedOn(s, 5_000, false),
      ).then((result) => (outcome = result.kind));

      // A flat frame for five timeouts' worth of waiting.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBeNull();

      // The seek ends short of the frame: one timeout after the last read that showed it.
      sample.IsReplayPlaying = true;
      sample.ReplayFrameNum = 4_000;
      await vi.advanceTimersByTimeAsync(900);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(outcome).toBe("timeout");
    });

    it("without seeking, gives up at the timeout whatever the sample reads", async () => {
      const claim = claimReplayCursor("test jump");
      let outcome: string | null = null;

      void waitForReplay(
        {
          claim,
          readTelemetry: (): ReplaySeekSample => ({ ReplayFrameNum: 0, IsReplayPlaying: false }),
          timeoutMs: 1000,
          pollMs: 50,
        },
        (s): s is ReplaySeekSample => isLandedOn(s, 5_000, false),
      ).then((result) => (outcome = result.kind));

      await vi.advanceTimersByTimeAsync(900);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(outcome).toBe("timeout");
    });

    it("stops at maxWaitMs while the seek still shows", async () => {
      const claim = claimReplayCursor("test jump");
      let outcome: string | null = null;

      void waitForReplay(
        {
          claim,
          readTelemetry: (): ReplaySeekSample => ({ ReplayFrameNum: 0, IsReplayPlaying: false }),
          timeoutMs: 1000,
          pollMs: 50,
          seeking: isSeeking,
          maxWaitMs: 5000,
        },
        (s): s is ReplaySeekSample => isLandedOn(s, 5_000, false),
      ).then((result) => (outcome = result.kind));

      await vi.advanceTimersByTimeAsync(4900);
      expect(outcome).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(outcome).toBe("timeout");
    });

    it("with requireReplay, the frame sent is no landing while no replay is on screen", async () => {
      // A jump to frame 0: the seek under way reads 0 too.
      const sample: ReplaySeekSample = { ReplayFrameNum: 0, IsReplayPlaying: false };
      const claim = claimReplayCursor("test jump");
      let outcome: string | null = null;

      void seekReplayFrame({
        frame: 0,
        claim,
        send: () => true,
        readTelemetry: () => ({ ...sample }),
        timeoutMs: 1000,
        pollMs: 50,
        requireSession: false,
        requireReplay: true,
        seeking: isSeeking,
      }).then((result) => (outcome = result.kind));

      await vi.advanceTimersByTimeAsync(400);
      expect(outcome).toBeNull();

      sample.IsReplayPlaying = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(outcome).toBe("reached");
    });

    it("without requireReplay, the frame alone lands it", async () => {
      const claim = claimReplayCursor("test jump");

      const result = seekReplayFrame({
        frame: 0,
        claim,
        send: () => true,
        readTelemetry: (): ReplaySeekSample => ({ ReplayFrameNum: 0, IsReplayPlaying: false }),
        timeoutMs: 1000,
        pollMs: 50,
        requireSession: false,
      });

      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toMatchObject({ kind: "reached" });
    });
  });

  describe("a refused jump (#1276)", () => {
    it("resolves refused at once, without waiting for a landing that is not coming", async () => {
      const claim = claimReplayCursor("test jump");
      const readTelemetry = vi.fn(() => ({ ReplayFrameNum: 90_000, SessionNum: 0 }));

      await expect(
        seekReplayFrame({ frame: 64_401, claim, send: () => false, readTelemetry, timeoutMs: 1600, pollMs: 50 }),
      ).resolves.toEqual({ kind: "refused" });
      expect(readTelemetry).not.toHaveBeenCalled();
    });
  });
});
