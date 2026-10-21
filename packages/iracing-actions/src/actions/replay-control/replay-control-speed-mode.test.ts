import type { ILogger } from "@iracedeck/logger";
import { _resetReplaySpeedState, noteTelemetrySpeed, reverseRememberedSpeed } from "@iracedeck/replay-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { ReplayControlDialSettings, SPEED_STOP_TOKENS } from "./replay-control-dial-settings.js";
import { speedMode } from "./replay-control-speed-mode.js";

const ladderSpy = vi.hoisted(() => ({ buildLadder: vi.fn() }));

// The real ladder module, with `buildLadder` counted: the mode memoizes the
// ladder it builds, and only a call count can show that.
vi.mock("./replay-speed-ladder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./replay-speed-ladder.js")>();

  ladderSpy.buildLadder.mockImplementation(actual.buildLadder);

  return { ...actual, buildLadder: ladderSpy.buildLadder };
});

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

const PAUSED = speed(0);

function dial(overrides: Record<string, unknown> = {}): ReplayControlDialSettings {
  return ReplayControlDialSettings.parse(overrides);
}

/** A dial whose ladder holds exactly these magnitudes. */
function dialWith(...tokens: string[]): ReplayControlDialSettings {
  return dial({ speedStops: Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, tokens.includes(token)])) });
}

/** The surface's side of the seam, with the live speed a test sets. */
function fakeIo(live: ReplaySpeed) {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const setSpeed = vi.fn<ReplayDialModeIo["setSpeed"]>(() => true);
  const pause = vi.fn<ReplayDialModeIo["pause"]>(() => true);
  const io: ReplayDialModeIo = {
    logger: logger as unknown as ILogger,
    liveSpeed: () => live,
    telemetry: () => null,
    setSpeed,
    pause,
    // Speed Control never moves the replay by frames.
    position: () => null,
    step: () => false,
    jumpTo: () => false,
  };

  return { io, logger, setSpeed, pause };
}

describe("speedMode", () => {
  beforeEach(() => {
    _resetReplaySpeedState();
  });

  describe("rotate", () => {
    it.each<[string, ReplaySpeed, number, ReplaySpeed]>([
      ["clockwise from 1x", speed(1), 1, speed(2)],
      ["counter-clockwise from 1x", speed(1), -1, speed(2, true)],
      ["clockwise from -8x", speed(-8), 1, speed(-4)],
      ["clockwise out of pause", PAUSED, 1, speed(4, true)],
      ["counter-clockwise out of pause", PAUSED, -1, speed(-4, true)],
      ["counter-clockwise into pause", speed(4, true), -1, PAUSED],
      ["three detents", speed(1), 3, speed(8)],
      ["a spin longer than the ladder", speed(1), -40, speed(-8)],
      ["clockwise off the ladder at 3x", speed(3), 1, speed(4)],
      ["counter-clockwise off the ladder at 3x", speed(3), -1, speed(2)],
    ])("should send one speed, the stop reached: %s", (_name, live, ticks, expected) => {
      const { io, setSpeed, pause } = fakeIo(live);

      speedMode.rotate(ticks, dial(), io);

      expect(setSpeed).toHaveBeenCalledTimes(1);
      expect(setSpeed).toHaveBeenCalledWith("dial-speed", expected);
      expect(pause).not.toHaveBeenCalled();
    });

    it.each<[string, ReplaySpeed, number]>([
      ["clockwise at the top", speed(8), 1],
      ["a spin at the top", speed(8), 9],
      ["counter-clockwise at the bottom", speed(-8), -1],
      ["clockwise beyond the top", speed(16), 1],
    ])("should send nothing at a ladder end: %s", (_name, live, ticks) => {
      const { io, logger, setSpeed } = fakeIo(live);

      speedMode.rotate(ticks, dial(), io);

      expect(setSpeed).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("nothing sent"));
    });

    it("should walk the ladder the dial's own Speeds ticks build", () => {
      const { io, setSpeed } = fakeIo(speed(1));

      speedMode.rotate(1, dialWith("1", "16"), io);
      expect(setSpeed).toHaveBeenLastCalledWith("dial-speed", speed(16));

      speedMode.rotate(-1, dialWith("1", "16"), io);
      expect(setSpeed).toHaveBeenLastCalledWith("dial-speed", PAUSED);
    });

    it("should start out of pause at the adjacent stop, never the remembered speed", () => {
      noteTelemetrySpeed(speed(8), 0);
      const { io, setSpeed } = fakeIo(PAUSED);

      speedMode.rotate(1, dial(), io);

      expect(setSpeed).toHaveBeenCalledWith("dial-speed", speed(4, true));
    });
  });

  describe("view", () => {
    it("should show the live speed as the value", () => {
      expect(speedMode.view(dial(), fakeIo(speed(4)).io).value).toBe("4x");
    });

    it("should leave the label to the mode itself, so it reads the same outside a replay", () => {
      expect(speedMode.label).toBe("SPEED");
      expect(speedMode.view(dial(), fakeIo(speed(4)).io)).not.toHaveProperty("label");
    });

    it.each<[ReplaySpeed, string]>([
      [speed(-2), "-2x"],
      [speed(4, true), "1/4x"],
      [speed(-4, true), "-1/4x"],
      [PAUSED, "PAUSED"],
    ])("should format %j as %s", (live, expected) => {
      expect(speedMode.view(dial(), fakeIo(live).io).value).toBe(expected);
    });

    it("should show no caption while the replay plays", () => {
      noteTelemetrySpeed(speed(4), 0);

      expect(speedMode.view(dial(), fakeIo(speed(4)).io).caption).toBe("");
    });

    it("should caption a paused replay with the speed Play/Pause would resume", () => {
      expect(speedMode.view(dial(), fakeIo(PAUSED).io).caption).toBe("► 1x");

      noteTelemetrySpeed(speed(4), 0);
      expect(speedMode.view(dial(), fakeIo(PAUSED).io).caption).toBe("► 4x");

      noteTelemetrySpeed(speed(-2, true), 16);
      expect(speedMode.view(dial(), fakeIo(PAUSED).io).caption).toBe("◄ 1/2x");
    });

    it("should show a Reverse made while paused in the caption at once", () => {
      noteTelemetrySpeed(speed(2), 0);
      reverseRememberedSpeed();

      expect(speedMode.view(dial(), fakeIo(PAUSED).io).caption).toBe("◄ 2x");
    });

    it.each<[string, ReplaySpeed, { left: boolean; right: boolean }]>([
      ["mid-ladder", speed(1), { left: true, right: true }],
      ["paused", PAUSED, { left: true, right: true }],
      ["the top stop", speed(8), { left: true, right: false }],
      ["the bottom stop", speed(-8), { left: false, right: true }],
      ["beyond the top", speed(16), { left: true, right: false }],
      ["off the ladder inside it", speed(3), { left: true, right: true }],
    ])("should light the sides a turn would change the speed towards: %s", (_name, live, expected) => {
      expect(speedMode.view(dial(), fakeIo(live).io).sides).toEqual(expected);
    });

    it("should send nothing", () => {
      const { io, setSpeed, pause } = fakeIo(speed(1));

      speedMode.view(dial(), io);

      expect(setSpeed).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    });
  });

  describe("the ladder it walks", () => {
    beforeEach(() => {
      ladderSpy.buildLadder.mockClear();
    });

    it("should be built once for the same settings object, however often the box is drawn", () => {
      const d = dial();
      const { io } = fakeIo(speed(1));

      for (let tick = 0; tick < 60; tick++) speedMode.view(d, io);

      speedMode.rotate(1, d, io);
      speedMode.rotate(-2, d, io);

      expect(ladderSpy.buildLadder).toHaveBeenCalledTimes(1);
      expect(ladderSpy.buildLadder).toHaveBeenCalledWith(d.speedStops);
    });

    it("should be rebuilt for a new settings object, even one that ticks the same speeds", () => {
      const { io } = fakeIo(speed(1));

      speedMode.view(dial(), io);
      speedMode.view(dial(), io);

      expect(ladderSpy.buildLadder).toHaveBeenCalledTimes(2);
    });

    it("should follow a settings change: the new object's ladder is the one walked", () => {
      const { io, setSpeed } = fakeIo(speed(1));
      const before = dialWith("1", "2");
      const after = dialWith("1", "16");

      speedMode.rotate(1, before, io);
      speedMode.rotate(1, after, io);
      speedMode.rotate(1, before, io);

      expect(setSpeed.mock.calls.map(([, target]) => target)).toEqual([speed(2), speed(16), speed(2)]);
      expect(ladderSpy.buildLadder).toHaveBeenCalledTimes(2);
    });
  });

  it("should name its rotation for the dial hint", () => {
    expect(speedMode.rotateDescription).toBe("Replay speed");
  });
});
