import { REPLAY_LIVE_EDGE_MAX_FRAMES, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplaySettledOutcome } from "../../shared/replay-command-gate.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import {
  _isTrackOrderTapWaiting,
  _resetTrackOrderTap,
  jumpToMyCarFromDial,
  neighbourNumbers,
  trackOrderMode,
  trackOrderNeighbours,
} from "./replay-control-track-order-mode.js";
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

  describe("the dial's Jump to My Car (jumpToMyCarFromDial)", () => {
    it("on a quiet replay cancels only the walks, under its own name, then switches at once", async () => {
      const io = fakeStepIo();

      await jumpToMyCarFromDial(io);

      expect(io.cancelCameraWalks).toHaveBeenCalledWith("dial-jump-to-my-car");
      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(io.recordJump).not.toHaveBeenCalled();
      expect(io.queueSearch).not.toHaveBeenCalled();
    });

    it("during a position jump switches only once it has settled", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const pending = jumpToMyCarFromDial(io);
      await vi.advanceTimersByTimeAsync(500);
      expect(io.jumpToMyCar).not.toHaveBeenCalled();
      expect(_isTrackOrderTapWaiting()).toBe(true);

      jump.land();
      await pending;

      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
    });

    it("shares the one waiting switch with a turn: whichever was asked for last goes out", async () => {
      const io = fakeStepIo();
      let jump = jumpUnderWay(io);

      const turn = trackOrderMode.rotate(1, dial, io);
      const myCar = jumpToMyCarFromDial(io);

      expect(io.waitForJumpsToSettle).toHaveBeenCalledTimes(1);
      jump.land();
      await Promise.all([turn, myCar]);
      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
      expect(io.tapBinding).not.toHaveBeenCalled();

      jump = jumpUnderWay(io);
      const second = jumpToMyCarFromDial(io);
      const later = trackOrderMode.rotate(-1, dial, io);

      jump.land();
      await Promise.all([second, later]);
      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
    });

    it("is dropped with nothing sent at the ceiling of the jump wait", async () => {
      const io = fakeStepIo();
      const jump = jumpUnderWay(io);

      const pending = jumpToMyCarFromDial(io);

      jump.giveUp();
      await pending;

      expect(io.jumpToMyCar).not.toHaveBeenCalled();
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

    it("shows the viewed car's number alone, no caption but its line kept so the number stays in place, and both side marks", () => {
      const io = fakeStepIo();

      io.sessionInfo.mockReturnValue(SESSION_INFO);
      io.telemetry.mockReturnValue({ IsReplayPlaying: true, ReplayFrameNum: 5_000, CamCarIdx: 7 } as TelemetryData);

      expect(trackOrderMode.view(dial, io)).toEqual({
        value: "#042",
        caption: "",
        reserveCaption: true,
        neighbours: null,
        sides: { left: true, right: true },
        bindingMissing: false,
      });
    });

    describe("the neighbours on track", () => {
      /** Car 2 (#5) at 0.10, car 4 (#12) at 0.50, car 7 (#042) at 0.95, car 9 (#88) in the garage. */
      const FIELD_INFO = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 2, CarNumber: "5", CarNumberRaw: 5 },
            ...SESSION_INFO.DriverInfo.Drivers,
            { CarIdx: 9, CarNumber: "88", CarNumberRaw: 88 },
          ],
        },
      };
      const LAP_DIST = [-1, -1, 0.1, -1, 0.5, -1, -1, 0.95, -1, 0.7];
      const SURFACE = [-1, -1, 3, -1, 3, -1, -1, 3, -1, -1];

      function field(extra: Partial<TelemetryData>): TelemetryData {
        return {
          IsReplayPlaying: true,
          ReplayFrameNum: 5_000,
          CamCarIdx: 4,
          CarIdxLapDistPct: LAP_DIST,
          CarIdxTrackSurface: SURFACE,
          ...extra,
        } as TelemetryData;
      }

      const flanked = (behind: string, ahead: string) => ({ left: `#${behind}`, right: `#${ahead}` });

      it("flank the car in a saved replay, behind on the left and ahead on the right, with no caption", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.isSavedReplay.mockReturnValue(true);
        // Scrubbed far back: in a saved replay the arrays are the replay's own anyway.
        io.telemetry.mockReturnValue(field({ ReplayFrameNumEnd: 90_000 }));

        expect(trackOrderMode.view(dial, io)).toMatchObject({
          value: "#12",
          neighbours: flanked("5", "042"),
          caption: "",
          reserveCaption: true,
        });
      });

      it("flank the car at the live edge of an in-session replay", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.telemetry.mockReturnValue(field({ ReplayFrameNumEnd: 1 }));

        expect(trackOrderMode.view(dial, io).neighbours).toEqual(flanked("5", "042"));
      });

      it("do not show scrubbed back in an in-session replay, where the arrays read the live field", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.telemetry.mockReturnValue(field({ ReplayFrameNumEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 }));

        expect(trackOrderMode.view(dial, io)).toMatchObject({ value: "#12", neighbours: null });
      });

      it("do not show while a jump is under way, nor with no car number for the camera car", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.isSavedReplay.mockReturnValue(true);
        io.telemetry.mockReturnValue(field({}));
        io.position.mockReturnValue({ frame: 9_000, time: 150, endFrame: undefined, seeking: true });
        expect(trackOrderMode.view(dial, io).neighbours).toBeNull();

        io.position.mockReturnValue({ frame: 9_000, time: 150, endFrame: undefined, seeking: false });
        io.telemetry.mockReturnValue(field({ CamCarIdx: 255 }));
        expect(trackOrderMode.view(dial, io)).toMatchObject({ value: "", neighbours: null });
      });

      it("say nothing on a tick read mid-seek: the value is null, and the box keeps the car and its neighbours", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.isSavedReplay.mockReturnValue(true);
        io.telemetry.mockReturnValue(field({}));
        io.position.mockReturnValue(null);

        expect(trackOrderMode.view(dial, io)).toMatchObject({ value: null, neighbours: null });
      });

      it("wrap round the line: the car first past it is ahead of the car last before it", () => {
        const io = fakeStepIo();

        io.sessionInfo.mockReturnValue(FIELD_INFO);
        io.isSavedReplay.mockReturnValue(true);
        io.telemetry.mockReturnValue(field({ CamCarIdx: 7 }));

        // Car 7 at 0.95: car 2 at 0.10 is 0.15 ahead, car 4 at 0.50 0.45 behind.
        expect(trackOrderMode.view(dial, io)).toMatchObject({ value: "#042", neighbours: flanked("12", "5") });
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

    it("is labelled TRK ORD, short enough to clear the side marks, and describes its turn as Camera Controls does", () => {
      // The surface's test measures every mode's label against the marks.
      expect(trackOrderMode.label).toBe("TRK ORD");
      expect(trackOrderMode.rotateDescription).toBe("Cycle Cars by Track Order");
    });
  });
});

describe("trackOrderNeighbours", () => {
  const ON = 3;
  const OFF = -1;

  /** A reading of the field: each car's lap distance and track surface. */
  const field = (lapDistPct: number[] | undefined, trackSurface: number[] | undefined) =>
    ({ CarIdxLapDistPct: lapDistPct, CarIdxTrackSurface: trackSurface }) as TelemetryData;

  it("is the car with the smallest gap forward ahead, and the smallest gap back behind", () => {
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.6, 0.9], [ON, ON, ON, ON]), 1)).toEqual({ ahead: 2, behind: 0 });
  });

  it("wraps round the line both ways", () => {
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.6, 0.9], [ON, ON, ON, ON]), 3)).toEqual({ ahead: 0, behind: 2 });
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.6, 0.9], [ON, ON, ON, ON]), 0)).toEqual({ ahead: 1, behind: 3 });
  });

  it("skips a car not in the world, one with no lap distance, and one the caller refuses", () => {
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.6, 0.9], [ON, ON, OFF, ON]), 1)).toEqual({ ahead: 3, behind: 0 });
    expect(trackOrderNeighbours(field([0.2, 0.5, -1, 0.9], [ON, ON, ON, ON]), 1)).toEqual({ ahead: 3, behind: 0 });
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.6, 0.9], [ON, ON, ON, ON]), 1, (idx) => idx !== 0)).toEqual({
      ahead: 2,
      behind: 3,
    });
  });

  it("is the one other car both ways, and none with no other car or the camera car off track", () => {
    expect(trackOrderNeighbours(field([0.2, 0.5], [ON, ON]), 1)).toEqual({ ahead: 0, behind: 0 });
    expect(trackOrderNeighbours(field([0.2, 0.5], [OFF, ON]), 1)).toEqual({ ahead: null, behind: null });
    expect(trackOrderNeighbours(field([0.2, 0.5], [ON, OFF]), 1)).toEqual({ ahead: null, behind: null });
    expect(trackOrderNeighbours(field([0.2, -1], [ON, ON]), 1)).toEqual({ ahead: null, behind: null });
    expect(trackOrderNeighbours(field(undefined, undefined), 1)).toEqual({ ahead: null, behind: null });
    expect(trackOrderNeighbours(null, 1)).toEqual({ ahead: null, behind: null });
  });

  it("gives a tie to the lower index", () => {
    expect(trackOrderNeighbours(field([0.6, 0.5, 0.6], [ON, ON, ON]), 1)).toEqual({ ahead: 0, behind: 0 });
  });

  it("does not count a car at the camera car's own lap distance, either way", () => {
    expect(trackOrderNeighbours(field([0.2, 0.5, 0.5], [ON, ON, ON]), 1)).toEqual({ ahead: 0, behind: 0 });
    expect(trackOrderNeighbours(field([-1, 0.5, 0.5], [OFF, ON, ON]), 1)).toEqual({ ahead: null, behind: null });
  });
});

describe("neighbourNumbers", () => {
  const INFO = {
    DriverInfo: {
      Drivers: [
        { CarIdx: 0, CarNumber: "3", CarNumberRaw: 3 },
        { CarIdx: 1, CarNumber: "12", CarNumberRaw: 12 },
        { CarIdx: 3, CarNumber: "7", CarNumberRaw: 7 },
      ],
    },
  };

  it("is the car behind on the left and the car ahead on the right, counting only cars with a number", () => {
    // Car 2 is closest ahead but has no number in the session info.
    const telemetry = { CarIdxLapDistPct: [0.2, 0.5, 0.55, 0.9], CarIdxTrackSurface: [3, 3, 3, 3] } as TelemetryData;

    expect(neighbourNumbers(telemetry, 1, INFO)).toEqual({ left: "#3", right: "#7" });
  });

  it("two cars at the identical lap distance are not both neighbours: a gap of 0 is none", () => {
    // Car 3 sits at car 1's own lap distance; car 0 is the one car round the lap.
    const telemetry = { CarIdxLapDistPct: [0.2, 0.5, -1, 0.5], CarIdxTrackSurface: [3, 3, -1, 3] } as TelemetryData;

    expect(neighbourNumbers(telemetry, 1, INFO)).toEqual({ left: "#3", right: "#3" });
  });

  it("reads the session info's driver list once per session-info object, not per car per view", () => {
    let reads = 0;
    const counted = {
      get DriverInfo() {
        reads++;

        return INFO.DriverInfo;
      },
    };
    const telemetry = { CarIdxLapDistPct: [0.2, 0.5, 0.55, 0.9], CarIdxTrackSurface: [3, 3, 3, 3] } as TelemetryData;

    expect(neighbourNumbers(telemetry, 1, counted)).toEqual({ left: "#3", right: "#7" });
    reads = 0;
    expect(neighbourNumbers(telemetry, 1, counted)).toEqual({ left: "#3", right: "#7" });
    expect(reads).toBe(0);

    // A new session info object is read afresh.
    const renumbered = {
      DriverInfo: { Drivers: INFO.DriverInfo.Drivers.map((d) => (d.CarIdx === 3 ? { ...d, CarNumber: "77" } : d)) },
    };

    expect(neighbourNumbers(telemetry, 1, renumbered)).toEqual({ left: "#3", right: "#77" });
  });

  it("is null with no other numbered car on track", () => {
    const telemetry = { CarIdxLapDistPct: [-1, 0.5], CarIdxTrackSurface: [-1, 3] } as TelemetryData;

    expect(neighbourNumbers(telemetry, 1, INFO)).toBeNull();
    expect(neighbourNumbers(null, 1, INFO)).toBeNull();
  });
});
