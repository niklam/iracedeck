import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplaySettledOutcome } from "../../shared/replay-command-gate.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { _isTrackOrderTapWaiting, _resetTrackOrderTap, trackOrderMode } from "./replay-control-track-order-mode.js";
import { fakeStepIo, type FakeStepIo } from "./replay-dial-step-io.test-support.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a mode sends nothing but through its io");
  }),
  getController: vi.fn(() => {
    throw new Error("a mode reads nothing but through its io");
  }),
}));

const dial = ReplayControlDialSettings.parse({ mode: "track-order" });

const NEXT = "replayControlNextCar";
const PREVIOUS = "replayControlPrevCar";

/** A jump wait the test ends: `land` resolves it settled, `giveUp` at the ceiling. */
function jumpUnderWay(io: FakeStepIo) {
  let end!: (outcome: ReplaySettledOutcome) => void;

  io.isJumpUnderWay.mockReturnValue(true);
  io.waitForJumpsToSettle.mockReturnValue(new Promise<ReplaySettledOutcome>((resolve) => (end = resolve)));

  return { land: () => end("settled"), giveUp: () => end("gave-up") };
}

describe("trackOrderMode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTrackOrderTap();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("on a quiet replay", () => {
    it.each<[number, string]>([
      [1, NEXT],
      [5, NEXT],
      [-1, PREVIOUS],
      [-12, PREVIOUS],
    ])("taps one binding per event whatever the ticks: %i → %s", async (ticks, key) => {
      const io = fakeStepIo();

      await trackOrderMode.rotate(ticks, dial, io);

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(key);
      expect(io.waitForJumpsToSettle).not.toHaveBeenCalled();
    });

    it("cancels a camera walk before it taps, and sends no replay command", async () => {
      const io = fakeStepIo();

      await trackOrderMode.rotate(1, dial, io);

      expect(io.cancelCameraWalks).toHaveBeenCalledWith("dial-track-order");
      expect(io.cancelCameraWalks.mock.invocationCallOrder[0]).toBeLessThan(
        io.tapBinding.mock.invocationCallOrder[0] ?? 0,
      );
      expect(io.recordJump).not.toHaveBeenCalled();
      expect(io.queueSearch).not.toHaveBeenCalled();
      expect(io.jumpTo).not.toHaveBeenCalled();
      expect(io.setSpeed).not.toHaveBeenCalled();
      expect(io.pause).not.toHaveBeenCalled();
    });

    it("with the binding unset warns and sends nothing", async () => {
      const io = fakeStepIo();

      io.isBindingMissing.mockImplementation((keys) => keys === PREVIOUS);
      await trackOrderMode.rotate(-1, dial, io);

      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(io.logger.warn).toHaveBeenCalledWith("Dial track order: binding not configured, nothing sent");
    });
  });

  describe("during a position jump", () => {
    it("sends nothing until the jump has settled, then one tap", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const turn = trackOrderMode.rotate(1, dial, io);
      await vi.advanceTimersByTimeAsync(500);
      expect(io.tapBinding).not.toHaveBeenCalled();
      // The walk is stopped at the turn, not when the tap goes out.
      expect(io.cancelCameraWalks).toHaveBeenCalledTimes(1);

      jump.land();
      await turn;

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(NEXT);
    });

    it("a second turn while one waits replaces it: one tap, in the newer direction", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const first = trackOrderMode.rotate(1, dial, io);
      const second = trackOrderMode.rotate(-1, dial, io);
      const third = trackOrderMode.rotate(-3, dial, io);

      expect(io.waitForJumpsToSettle).toHaveBeenCalledTimes(1);

      jump.land();
      await Promise.all([first, second, third]);

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
    });

    it("a turn on another dial replaces the tap too, and goes out through that dial", async () => {
      const a = fakeStepIo();
      const b = fakeStepIo();
      const jump = jumpUnderWay(a);

      const first = trackOrderMode.rotate(1, dial, a);
      const second = trackOrderMode.rotate(-1, dial, b);

      jump.land();
      await Promise.all([first, second]);

      expect(a.tapBinding).not.toHaveBeenCalled();
      expect(b.tapBinding).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
    });

    it.each([3_000, 30_000])("a tap still waiting after %i ms is sent when the jump lands", async (ms) => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const turn = trackOrderMode.rotate(1, dial, io);
      await vi.advanceTimersByTimeAsync(ms);
      expect(io.tapBinding).not.toHaveBeenCalled();

      jump.land();
      await turn;

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(NEXT);
    });

    it("is dropped with nothing sent at the ceiling of the jump wait", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const turn = trackOrderMode.rotate(1, dial, io);

      jump.giveUp();
      await turn;

      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(io.logger.debug).toHaveBeenCalledWith(expect.stringContaining("tap dropped"));
    });

    it("is dropped with nothing sent when the dial left the screen or the replay was left", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const turn = trackOrderMode.rotate(1, dial, io);

      io.isStillOnScreen.mockReturnValue(false);
      jump.land();
      await turn;

      expect(io.tapBinding).not.toHaveBeenCalled();
    });

    it("a jump wait that rejects drops the tap, logs why, and leaves no turn waiting", async () => {
      const io = fakeStepIo();
      let fail!: (error: Error) => void;

      io.isJumpUnderWay.mockReturnValue(true);
      io.waitForJumpsToSettle.mockReturnValueOnce(
        new Promise<ReplaySettledOutcome>((_resolve, reject) => (fail = reject)),
      );

      const first = trackOrderMode.rotate(1, dial, io);
      const second = trackOrderMode.rotate(-1, dial, io);

      expect(_isTrackOrderTapWaiting()).toBe(true);

      fail(new Error("gate gone"));
      await expect(Promise.all([first, second])).resolves.toBeDefined();

      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(_isTrackOrderTapWaiting()).toBe(false);
      expect(io.logger.warn).toHaveBeenCalledWith(expect.stringContaining("gate gone"));

      // The next turn is a turn of its own: on a quiet replay it taps at once.
      io.isJumpUnderWay.mockReturnValue(false);
      await trackOrderMode.rotate(1, dial, io);

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(NEXT);
    });

    it("a jump wait that throws at once leaves the next turn a turn of its own", async () => {
      const io = fakeStepIo();

      io.isJumpUnderWay.mockReturnValueOnce(true);
      io.waitForJumpsToSettle.mockImplementationOnce(() => {
        throw new Error("no gate");
      });

      await trackOrderMode.rotate(1, dial, io);
      await trackOrderMode.rotate(-1, dial, io);

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
      expect(_isTrackOrderTapWaiting()).toBe(false);
    });

    it("a turn after the wait ended is a turn of its own", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);
      let releaseTap!: () => void;

      io.tapBinding.mockReturnValueOnce(new Promise<boolean>((resolve) => (releaseTap = () => resolve(true))));

      const first = trackOrderMode.rotate(1, dial, io);

      jump.land();
      await vi.advanceTimersByTimeAsync(0);
      // The first tap is going out; this one is not folded into it.
      io.isJumpUnderWay.mockReturnValue(false);
      const second = trackOrderMode.rotate(-1, dial, io);

      releaseTap();
      await Promise.all([first, second]);

      expect(io.tapBinding.mock.calls).toEqual([[NEXT], [PREVIOUS]]);
    });
  });

  describe("view", () => {
    const SESSION_INFO = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 4, CarNumber: "12", CarNumberRaw: 12 },
          { CarIdx: 7, CarNumber: "042", CarNumberRaw: 3042 },
        ],
      },
    };

    it("shows the viewed car's number, the play state, both side marks", () => {
      const io = fakeStepIo();

      io.sessionInfo.mockReturnValue(SESSION_INFO);
      io.telemetry.mockReturnValue({ IsReplayPlaying: true, ReplayFrameNum: 5_000, CamCarIdx: 7 } as TelemetryData);

      expect(trackOrderMode.view(dial, io)).toEqual({
        value: "#042",
        caption: "PAUSED",
        sides: { left: true, right: true },
        bindingMissing: false,
      });
    });

    it("shows nothing for no car on camera, and keeps its value on a tick read mid-seek", () => {
      const io = fakeStepIo();

      io.sessionInfo.mockReturnValue(SESSION_INFO);
      io.telemetry.mockReturnValue({ IsReplayPlaying: true, CamCarIdx: 255 } as TelemetryData);
      expect(trackOrderMode.view(dial, io).value).toBe("");

      io.position.mockReturnValue(null);
      expect(trackOrderMode.view(dial, io).value).toBeNull();
    });

    it("flags a missing binding, either one of the pair", () => {
      const io = fakeStepIo();

      io.isBindingMissing.mockImplementation((keys) => Array.isArray(keys) && keys.includes(NEXT));

      expect(trackOrderMode.view(dial, io).bindingMissing).toBe(true);
    });

    it("is labelled TRACK ORDER and describes its turn as Camera Controls does", () => {
      expect(trackOrderMode.label).toBe("TRACK ORDER");
      expect(trackOrderMode.rotateDescription).toBe("Cycle Cars by Track Order");
    });
  });
});
