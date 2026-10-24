import { REPLAY_LIVE_EDGE_MAX_FRAMES, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  claimReplayCursor,
  FASTEST_LAP_WALK_OWNER,
  isCameraSwitchWaiting,
  RACE_START_WALK_OWNER,
  type ReplaySettledOutcome,
  requestCameraSwitch,
} from "@iracedeck/replay-engine";
import { resetEngine } from "@iracedeck/replay-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import {
  jumpToMyCarFromDial,
  neighbourNumbers,
  trackOrderMode,
  trackOrderNeighbours,
} from "./replay-control-track-order-mode.js";
import { fakeStepIo } from "./replay-dial-step-io.test-support.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

// The engine's waiter, real, with its calls recorded: the routing case reads what the mode hands it.
vi.mock("@iracedeck/replay-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/replay-engine")>();

  return { ...actual, requestCameraSwitch: vi.fn(actual.requestCameraSwitch) };
});

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

describe("trackOrderMode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEngine();
    vi.mocked(requestCameraSwitch).mockClear();
  });

  afterEach(() => {
    resetEngine();
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

    it("interrupts a camera walk before it taps, and sends no replay command (#1428 / #1435)", async () => {
      const io = fakeStepIo();
      const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);
      let interruptedAtTap: string | null | undefined;

      io.tapBinding.mockImplementation(() => {
        interruptedAtTap = walk.interruptedBy;

        return Promise.resolve(true);
      });
      await trackOrderMode.rotate(1, dial, io);

      expect(interruptedAtTap).toBe("dial-track-order");
      expect(walk.cancelledBy).toBeNull();
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

  describe("the shared camera-switch waiter", () => {
    it("routes a turn and the My Car gesture through the shared waiter", async () => {
      const io = fakeStepIo();
      const jumps = { underWay: false };

      io.isJumpUnderWay.mockImplementation(() => jumps.underWay);
      await trackOrderMode.rotate(-2, dial, io);
      await jumpToMyCarFromDial(io);

      const calls = vi.mocked(requestCameraSwitch).mock.calls;

      expect(
        calls.map(([, options]) => [options.by, options.label, options.name, options.asked, options.surface]),
      ).toEqual([
        ["dial-track-order", "Dial track order", "previous car", "ticks=-2", "the dial"],
        ["dial-jump-to-my-car", "Dial track order", "my car", "Jump to My Car", "the dial"],
      ]);

      // What each hands over: its send, the dial's own jump reads, its on-screen check, and its logger.
      const [[sendTap, turn], [sendMyCar, myCar]] = calls;

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(PREVIOUS);
      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
      await sendTap();
      expect(io.tapBinding).toHaveBeenLastCalledWith(PREVIOUS);
      await sendMyCar();
      expect(io.jumpToMyCar).toHaveBeenCalledTimes(2);

      for (const options of [turn, myCar]) {
        expect(options.logger).toBe(io.logger);
        jumps.underWay = true;
        expect(options.jumps?.isUnderWay()).toBe(true);
        jumps.underWay = false;
        await options.jumps?.waitToSettle();
        io.isStillOnScreen.mockReturnValueOnce(false);
        expect(options.stillValid()).toBe(false);
      }

      expect(io.waitForJumpsToSettle).toHaveBeenCalledTimes(2);
    });

    it("waits behind a position jump as the one switch the waiter holds", async () => {
      const io = fakeStepIo();
      let land!: (outcome: ReplaySettledOutcome) => void;

      io.isJumpUnderWay.mockReturnValue(true);
      io.waitForJumpsToSettle.mockReturnValue(new Promise<ReplaySettledOutcome>((resolve) => (land = resolve)));

      const turn = trackOrderMode.rotate(1, dial, io);

      expect(isCameraSwitchWaiting()).toBe(true);
      expect(io.tapBinding).not.toHaveBeenCalled();

      land("settled");
      await turn;

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith(NEXT);
      expect(isCameraSwitchWaiting()).toBe(false);
    });
  });

  describe("the dial's Jump to My Car (jumpToMyCarFromDial)", () => {
    it("on a quiet replay interrupts only the walks, under its own name, then switches at once", async () => {
      const io = fakeStepIo();
      const walk = claimReplayCursor(RACE_START_WALK_OWNER);

      await jumpToMyCarFromDial(io);

      expect(walk.interruptedBy).toBe("dial-jump-to-my-car");
      expect(walk.cancelledBy).toBeNull();
      expect(io.jumpToMyCar).toHaveBeenCalledOnce();
      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(io.recordJump).not.toHaveBeenCalled();
      expect(io.queueSearch).not.toHaveBeenCalled();

      // Any other owner is left standing.
      const record = claimReplayCursor("jump-to-fastest-lap record jump");

      await jumpToMyCarFromDial(io);

      expect(record.cancelledBy).toBeNull();
      expect(record.interruptedBy).toBeNull();
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
