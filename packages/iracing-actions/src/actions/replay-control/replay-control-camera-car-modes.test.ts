import { REPLAY_LIVE_EDGE_MAX_FRAMES, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  claimReplayCursor,
  FASTEST_LAP_WALK_OWNER,
  isCameraSwitchWaiting,
  type ReplaySettledOutcome,
  requestCameraSwitch,
} from "@iracedeck/replay-engine";
import { resetEngine } from "@iracedeck/replay-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  carNumberMode,
  carNumberNeighbours,
  carStepDirection,
  racePositionMode,
} from "./replay-control-camera-car-modes.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { trackOrderMode } from "./replay-control-track-order-mode.js";
import { type FakeStepIo, fakeStepIo } from "./replay-dial-step-io.test-support.js";

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

const carNumberDial = ReplayControlDialSettings.parse({ mode: "car-number" });
const positionDial = ReplayControlDialSettings.parse({ mode: "race-position" });

/**
 * The field, with gaps in the numbers: the pace car (carIdx 0, never a
 * target), #3 (1), #12 (2), #042 (4, raw 3042), #77 (7, departed: off the
 * world in every array below) and #94 (9).
 */
const SESSION_INFO = {
  DriverInfo: {
    Drivers: [
      { CarIdx: 0, CarNumber: "0", CarNumberRaw: 0, CarIsPaceCar: 1, UserName: "Pace Car" },
      { CarIdx: 1, CarNumber: "3", CarNumberRaw: 3, UserName: "a" },
      { CarIdx: 2, CarNumber: "12", CarNumberRaw: 12, UserName: "b" },
      { CarIdx: 4, CarNumber: "042", CarNumberRaw: 3042, UserName: "c" },
      { CarIdx: 7, CarNumber: "77", CarNumberRaw: 77, UserName: "d" },
      { CarIdx: 9, CarNumber: "94", CarNumberRaw: 94, UserName: "e" },
    ],
  },
};

/** The canonical race order: #12 leads, then #042, #3, #94 and #77 last; the pace car is unranked. */
const ORDER = [0, 3, 1, 0, 2, 0, 0, 5, 0, 4];

/** Not in the world: `-1` in every per-car array, as a departed car reads (#1281). */
const OFF = -1;

/** A paused replay tick with `camCarIdx` on camera, `toEnd` frames from the end of the tape. */
function tick(camCarIdx: number, toEnd = 90_000, extra: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: 5_000,
    ReplayFrameNumEnd: toEnd,
    CamCarIdx: camCarIdx,
    CarIdxLapDistPct: [0.05, 0.4, 0.6, OFF, 0.5, OFF, OFF, OFF, OFF, 0.3],
    ...extra,
  } as TelemetryData;
}

/** A fake io over the field with `camCarIdx` on camera, in a saved replay unless told otherwise. */
function fieldIo(camCarIdx: number, options: { saved?: boolean; toEnd?: number } = {}): FakeStepIo {
  const io = fakeStepIo();

  io.sessionInfo.mockReturnValue(SESSION_INFO);
  io.racePositions.mockReturnValue(ORDER);
  io.isSavedReplay.mockReturnValue(options.saved ?? true);
  io.telemetry.mockReturnValue(tick(camCarIdx, options.toEnd));

  return io;
}

/** The raw car numbers the io was asked to switch to, in order. */
const switched = (io: FakeStepIo): number[] => io.switchToCarNumber.mock.calls.map(([raw]) => raw);

describe("the camera-car modes (#1448)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A replay on screen: outside one the waiter sends every switch at once.
    resetEngine({ inReplay: () => true });
    vi.mocked(requestCameraSwitch).mockClear();
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  describe("the direction of a turn", () => {
    it("clockwise lowers the number in both modes, as on Camera Controls' dial (#884, #973)", () => {
      expect(carStepDirection(1)).toBe("previous");
      expect(carStepDirection(4)).toBe("previous");
      expect(carStepDirection(-1)).toBe("next");
      expect(carStepDirection(-3)).toBe("next");
    });

    it("leaves Track Order's clockwise as the car ahead", async () => {
      const io = fakeStepIo();

      await trackOrderMode.rotate(1, ReplayControlDialSettings.parse({ mode: "track-order" }), io);

      expect(io.tapBinding).toHaveBeenCalledExactlyOnceWith("replayControlNextCar");
    });
  });

  describe("Car #", () => {
    it.each<[string, number, number, number]>([
      ["#12 clockwise to the lower number, #3", 2, 1, 3],
      ["#12 counter-clockwise to the higher number, #042", 2, -1, 3042],
      ["#042 clockwise over the gap to #12", 4, 1, 12],
      ["#94 clockwise to #77, a car that has left the world", 9, 1, 77],
      ["#94 counter-clockwise round to #3", 9, -1, 3],
      ["#3 clockwise round to #94, never the pace car", 1, 1, 94],
      ["the pace car on camera clockwise to the last car, #94", 0, 1, 94],
      ["the pace car on camera counter-clockwise to the first, #3", 0, -1, 3],
    ])("switches %s", async (_name, camCarIdx, ticks, raw) => {
      const io = fieldIo(camCarIdx);

      await carNumberMode.rotate(ticks, carNumberDial, io);

      expect(switched(io)).toEqual([raw]);
    });

    it("switches by one car per event whatever its ticks", async () => {
      const io = fieldIo(2);

      await carNumberMode.rotate(5, carNumberDial, io);

      expect(switched(io)).toEqual([3]);
    });

    it("sends nothing with no other car to go to, and says so at debug", async () => {
      const io = fakeStepIo();

      io.sessionInfo.mockReturnValue({ DriverInfo: { Drivers: [SESSION_INFO.DriverInfo.Drivers[2]] } });
      io.telemetry.mockReturnValue(tick(2));
      await carNumberMode.rotate(1, carNumberDial, io);

      expect(io.switchToCarNumber).not.toHaveBeenCalled();
      expect(io.logger.debug).toHaveBeenCalledWith(expect.stringContaining("no other car to switch to"));
    });

    it("needs no trust in the per-car arrays: scrubbed back in an in-session replay it still switches", async () => {
      const io = fieldIo(2, { saved: false, toEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 });

      await carNumberMode.rotate(1, carNumberDial, io);

      expect(switched(io)).toEqual([3]);
    });

    it("sends no replay command and taps no binding", async () => {
      const io = fieldIo(2);

      await carNumberMode.rotate(1, carNumberDial, io);

      expect(io.tapBinding).not.toHaveBeenCalled();
      expect(io.recordJump).not.toHaveBeenCalled();
      expect(io.queueSearch).not.toHaveBeenCalled();
      expect(io.jumpTo).not.toHaveBeenCalled();
      expect(io.setSpeed).not.toHaveBeenCalled();
      expect(io.pause).not.toHaveBeenCalled();
    });
  });

  describe("Position", () => {
    it.each<[string, number, number, number]>([
      ["P2 clockwise up to the leader, P1", 4, 1, 12],
      ["P2 counter-clockwise down to P3", 4, -1, 3],
      ["the leader clockwise round to last place, P5", 2, 1, 77],
      ["last place counter-clockwise round to the leader", 7, -1, 12],
      ["the unranked pace car clockwise: re-enters at the end, last place", 0, 1, 77],
      ["the unranked pace car counter-clockwise: re-enters at the leader", 0, -1, 12],
      ["no car on camera (NO_CAR_IDX) clockwise: re-enters at last place, as Camera Controls does", 255, 1, 77],
      ["no car on camera (NO_CAR_IDX) counter-clockwise: re-enters at the leader", 255, -1, 12],
    ])("switches %s, by car number", async (_name, camCarIdx, ticks, raw) => {
      const io = fieldIo(camCarIdx);

      await racePositionMode.rotate(ticks, positionDial, io);

      expect(switched(io)).toEqual([raw]);
    });

    it("steps past a position nobody holds", async () => {
      const io = fieldIo(4);

      // Nobody is P1: from P2 clockwise wraps round to last place.
      io.racePositions.mockReturnValue([0, 3, 0, 0, 2, 0, 0, 5, 0, 4]);
      await racePositionMode.rotate(1, positionDial, io);

      expect(switched(io)).toEqual([77]);
    });

    it("walks the official CarIdxPosition where the canonical order ranks nobody (race-positions.md)", async () => {
      const io = fieldIo(4);

      io.racePositions.mockReturnValue(new Array<number>(10).fill(0));
      io.telemetry.mockReturnValue(tick(4, 90_000, { CarIdxPosition: [0, 2, 0, 0, 1, 0, 0, 0, 0, 3] }));
      await racePositionMode.rotate(-1, positionDial, io);

      // #042 is P1 by the official count; counter-clockwise is P2, #3.
      expect(switched(io)).toEqual([3]);
    });

    it("switches at the live edge of an in-session replay, where the arrays are the replay's", async () => {
      const io = fieldIo(4, { saved: false, toEnd: 1 });

      await racePositionMode.rotate(1, positionDial, io);

      expect(switched(io)).toEqual([12]);
    });

    it("sends nothing scrubbed back in an in-session replay, asks nothing of the waiter, and says so at debug", async () => {
      const io = fieldIo(4, { saved: false, toEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 });
      const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);

      await racePositionMode.rotate(1, positionDial, io);

      expect(io.switchToCarNumber).not.toHaveBeenCalled();
      expect(requestCameraSwitch).not.toHaveBeenCalled();
      // A turn that sends nothing interrupts nothing.
      expect(walk.interruptedBy).toBeNull();
      expect(io.logger.debug).toHaveBeenCalledWith(expect.stringContaining("not the replay's here, nothing sent"));
    });

    it("with no position reading yet, still checks the arrays at the turn and interrupts no walk", async () => {
      const io = fieldIo(4, { saved: false, toEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 });
      const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);

      vi.mocked(io.position).mockReturnValue(null);
      await racePositionMode.rotate(1, positionDial, io);

      expect(io.switchToCarNumber).not.toHaveBeenCalled();
      expect(requestCameraSwitch).not.toHaveBeenCalled();
      expect(walk.interruptedBy).toBeNull();
    });

    it("behind a jump decides when the jump has landed: landed scrubbed back, it sends nothing", async () => {
      const io = fieldIo(4, { saved: false, toEnd: 1 });
      let land!: (outcome: ReplaySettledOutcome) => void;

      io.isJumpUnderWay.mockReturnValue(true);
      io.waitForJumpsToSettle.mockReturnValue(new Promise<ReplaySettledOutcome>((resolve) => (land = resolve)));

      const turn = racePositionMode.rotate(1, positionDial, io);

      expect(isCameraSwitchWaiting()).toBe(true);

      // The jump lands far back on the tape, where the arrays read the live field.
      io.telemetry.mockReturnValue(tick(4, REPLAY_LIVE_EDGE_MAX_FRAMES + 1));
      io.isJumpUnderWay.mockReturnValue(false);
      land("settled");
      await turn;

      expect(io.switchToCarNumber).not.toHaveBeenCalled();
      expect(io.logger.debug).toHaveBeenCalledWith(expect.stringContaining("where the replay landed, nothing sent"));
    });

    it("sends nothing with no race order, or with the camera car the only ranked car", async () => {
      const none = fieldIo(4);

      none.racePositions.mockReturnValue(null);
      await racePositionMode.rotate(1, positionDial, none);

      const alone = fieldIo(4);

      alone.racePositions.mockReturnValue([0, 0, 0, 0, 1]);
      await racePositionMode.rotate(1, positionDial, alone);

      expect(none.switchToCarNumber).not.toHaveBeenCalled();
      expect(alone.switchToCarNumber).not.toHaveBeenCalled();
    });
  });

  describe("the shared camera-switch waiter", () => {
    it("routes a turn of each mode through it, with the dial's own jump reads and on-screen check", async () => {
      const io = fieldIo(4);
      const jumps = { underWay: false };

      io.isJumpUnderWay.mockImplementation(() => jumps.underWay);
      await carNumberMode.rotate(1, carNumberDial, io);
      await racePositionMode.rotate(-1, positionDial, io);

      const calls = vi.mocked(requestCameraSwitch).mock.calls;

      expect(
        calls.map(([, options]) => [
          options.by,
          options.label,
          options.name,
          options.asked,
          options.surface,
          options.interruptsWalks,
        ]),
      ).toEqual([
        ["dial-car-number", "Dial car number", "previous car by number", "ticks=1", "the dial", undefined],
        ["dial-race-position", "Dial position", "next car by position", "ticks=-1", "the dial", undefined],
      ]);

      for (const [, options] of calls) {
        expect(options.logger).toBe(io.logger);
        jumps.underWay = true;
        expect(options.jumps?.isUnderWay()).toBe(true);
        jumps.underWay = false;
        await options.jumps?.waitToSettle();
        io.isStillOnScreen.mockReturnValueOnce(false);
        expect(options.stillValid()).toBe(false);
      }
    });

    it.each([
      ["Car #", carNumberMode, carNumberDial, "dial-car-number"],
      ["Position", racePositionMode, positionDial, "dial-race-position"],
    ] as const)(
      "a %s turn interrupts a fastest-lap walk under its own name, never cancels it",
      async (_name, mode, d, by) => {
        const io = fieldIo(4);
        const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);
        let interruptedAtSwitch: string | null | undefined;

        io.switchToCarNumber.mockImplementation(() => {
          interruptedAtSwitch = walk.interruptedBy;

          return true;
        });
        await mode.rotate(1, d, io);

        expect(interruptedAtSwitch).toBe(by);
        expect(walk.cancelledBy).toBeNull();
      },
    );

    it("works the target out when the switch goes out, from the camera car then, not at the turn", async () => {
      const io = fieldIo(2);
      let land!: (outcome: ReplaySettledOutcome) => void;

      io.isJumpUnderWay.mockReturnValue(true);
      io.waitForJumpsToSettle.mockReturnValue(new Promise<ReplaySettledOutcome>((resolve) => (land = resolve)));

      const turn = carNumberMode.rotate(1, carNumberDial, io);

      // The jump's own camera switch put #94 on camera before it landed.
      io.telemetry.mockReturnValue(tick(9));
      io.isJumpUnderWay.mockReturnValue(false);
      land("settled");
      await turn;

      expect(switched(io)).toEqual([77]);
    });

    it("a second turn while one waits replaces it: one switch, the newer one's", async () => {
      const io = fieldIo(4);
      let land!: (outcome: ReplaySettledOutcome) => void;

      io.isJumpUnderWay.mockReturnValue(true);
      io.waitForJumpsToSettle.mockReturnValue(new Promise<ReplaySettledOutcome>((resolve) => (land = resolve)));

      const first = carNumberMode.rotate(1, carNumberDial, io);
      const second = racePositionMode.rotate(-1, positionDial, io);

      expect(isCameraSwitchWaiting()).toBe(true);
      io.isJumpUnderWay.mockReturnValue(false);
      land("settled");
      await Promise.all([first, second]);

      // P2 counter-clockwise is P3, #3; the Car # turn's #12 never went out.
      expect(switched(io)).toEqual([3]);
    });
  });

  describe("view", () => {
    describe("Car #", () => {
      it("shows the camera car's number with the cars one detent either way beside it, the lower on the right", () => {
        expect(carNumberMode.view(carNumberDial, fieldIo(2))).toEqual({
          value: "#12",
          caption: "",
          reserveCaption: true,
          neighbours: { left: "#042", right: "#3" },
          sides: { left: true, right: true },
        });
      });

      it("flanks a car whatever the arrays say: scrubbed back in an in-session replay too", () => {
        const io = fieldIo(9, { saved: false, toEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 });

        expect(carNumberMode.view(carNumberDial, io)).toMatchObject({
          value: "#94",
          neighbours: { left: "#3", right: "#77" },
        });
      });

      it("with no car on camera shows no number, and the ends a turn would go to", () => {
        const io = fieldIo(255);

        expect(carNumberMode.view(carNumberDial, io)).toMatchObject({
          value: "",
          neighbours: { left: "#3", right: "#94" },
        });
      });

      it("says nothing on a tick read mid-seek: the box keeps the car and its neighbours", () => {
        const io = fieldIo(2);

        io.position.mockReturnValue(null);

        expect(carNumberMode.view(carNumberDial, io)).toMatchObject({ value: null, neighbours: null });
      });

      it("is labelled CAR # and describes its turn as Camera Controls does", () => {
        expect(carNumberMode.label).toBe("CAR #");
        expect(carNumberMode.rotateDescription).toBe("Cycle Cars by Number");
      });
    });

    describe("Position", () => {
      it("shows the camera car's position, its number beneath, and the positions one detent either way", () => {
        expect(racePositionMode.view(positionDial, fieldIo(4))).toEqual({
          value: "P2",
          caption: "#042",
          reserveCaption: true,
          neighbours: { left: "P3", right: "P1" },
          sides: { left: true, right: true },
        });
      });

      it("shows the same at the live edge of an in-session replay", () => {
        expect(racePositionMode.view(positionDial, fieldIo(4, { saved: false, toEnd: 1 }))).toMatchObject({
          value: "P2",
          caption: "#042",
          neighbours: { left: "P3", right: "P1" },
        });
      });

      it("shows P-- with its number, no neighbours and no side marks scrubbed back in an in-session replay", () => {
        const io = fieldIo(4, { saved: false, toEnd: REPLAY_LIVE_EDGE_MAX_FRAMES + 1 });

        expect(racePositionMode.view(positionDial, io)).toEqual({
          value: "P--",
          caption: "#042",
          reserveCaption: true,
          neighbours: null,
          sides: { left: false, right: false },
        });
      });

      it("shows the unranked pace car as P-- with the ends a turn re-enters at beside it", () => {
        expect(racePositionMode.view(positionDial, fieldIo(0))).toMatchObject({
          value: "P--",
          caption: "#0",
          neighbours: { left: "P1", right: "P5" },
          sides: { left: true, right: true },
        });
      });

      it("with no car on camera (NO_CAR_IDX) shows P-- and the ends a turn re-enters at, as Camera Controls does", () => {
        expect(racePositionMode.view(positionDial, fieldIo(255))).toMatchObject({
          value: "P--",
          caption: "",
          neighbours: { left: "P1", right: "P5" },
          sides: { left: true, right: true },
        });
      });

      it("lights no side mark where a turn has no car to go to, and keeps the position of a car ranked alone", () => {
        const io = fieldIo(4);

        io.racePositions.mockReturnValue([0, 0, 0, 0, 1]);

        expect(racePositionMode.view(positionDial, io)).toMatchObject({
          value: "P1",
          caption: "#042",
          neighbours: null,
          sides: { left: false, right: false },
        });
      });

      it("says nothing on a tick read mid-seek or while a jump is under way: the box keeps what it showed", () => {
        const io = fieldIo(4);

        io.position.mockReturnValue(null);
        expect(racePositionMode.view(positionDial, io)).toMatchObject({ value: null, caption: null });

        io.position.mockReturnValue({ frame: 9_000, time: 150, endFrame: undefined, seeking: true });
        expect(racePositionMode.view(positionDial, io)).toMatchObject({ value: null, caption: null });
      });

      it("is labelled POS, and describes its turn as Camera Controls does", () => {
        // POSITION leaves less room than INCIDENT beside the side marks on the knob: the surface's test measures every label.
        expect(racePositionMode.label).toBe("POS");
        expect(racePositionMode.rotateDescription).toBe("Cycle Cars by Position");
      });
    });
  });
});

describe("carNumberNeighbours", () => {
  it("is the higher number on the left and the lower on the right, wrapping at the ends", () => {
    expect(carNumberNeighbours(1, SESSION_INFO)).toEqual({ left: "#12", right: "#94" });
    expect(carNumberNeighbours(9, SESSION_INFO)).toEqual({ left: "#3", right: "#77" });
  });

  it("is the one other car both ways, and null with none", () => {
    const pair = { DriverInfo: { Drivers: SESSION_INFO.DriverInfo.Drivers.slice(1, 3) } };
    const single = { DriverInfo: { Drivers: SESSION_INFO.DriverInfo.Drivers.slice(1, 2) } };

    expect(carNumberNeighbours(1, pair)).toEqual({ left: "#12", right: "#12" });
    expect(carNumberNeighbours(1, single)).toBeNull();
    expect(carNumberNeighbours(1, null)).toBeNull();
  });
});
