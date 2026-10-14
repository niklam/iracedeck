import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { describeReplayPosition, formatReplayTime, frameJogMode } from "./replay-control-frame-jog.js";

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
const dial = ReplayControlDialSettings.parse({});

/** A replay at rest on `frame` of a 10 000-frame recording, unless overridden. */
function at(frame: number, overrides: Partial<ReplayPosition> = {}): ReplayPosition {
  return { frame, time: frame / 60, endFrame: 10_000, seeking: false, ...overrides };
}

interface FakeIoOptions {
  liveSpeed?: ReplaySpeed;
  telemetry?: TelemetryData | null;
  /** Where the surface says the replay stands or is headed; at rest on frame 5000 by default. */
  position?: ReplayPosition | null;
  /** What `io.pause` reports; false is a pause that did not go out. */
  pauseSent?: boolean;
  /** What `io.step` and `io.jumpTo` report; false is a move that did not go out. */
  moveSent?: boolean;
}

/**
 * A surface stand-in: `calls` records every command in the order it went out,
 * with the cursor owner it was sent under.
 */
function fakeIo(options: FakeIoOptions = {}) {
  const calls: string[] = [];
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const io: ReplayDialModeIo = {
    logger: logger as unknown as ILogger,
    liveSpeed: () => options.liveSpeed ?? PAUSED,
    telemetry: () => options.telemetry ?? null,
    position: () => (options.position === undefined ? at(5000) : options.position),
    setSpeed: vi.fn<ReplayDialModeIo["setSpeed"]>(() => true),
    pause: vi.fn<ReplayDialModeIo["pause"]>((owner) => {
      calls.push(`pause:${owner}`);

      return options.pauseSent ?? true;
    }),
    step: vi.fn<ReplayDialModeIo["step"]>((owner, direction) => {
      calls.push(`step:${owner}:${direction}`);

      return options.moveSent ?? true;
    }),
    jumpTo: vi.fn<ReplayDialModeIo["jumpTo"]>((owner, frame) => {
      calls.push(`jumpTo:${owner}:${frame}`);

      return options.moveSent ?? true;
    }),
  };

  return { io, logger, calls };
}

describe("formatReplayTime", () => {
  it("formats seconds as m:ss.ss", () => {
    expect(formatReplayTime(0)).toBe("0:00.00");
    expect(formatReplayTime(7.5)).toBe("0:07.50");
    expect(formatReplayTime(83.456)).toBe("1:23.46");
  });

  it("carries a rounded-up second into the minute", () => {
    expect(formatReplayTime(59.999)).toBe("1:00.00");
  });

  it("keeps minutes past the hour rather than folding them", () => {
    expect(formatReplayTime(3723.5)).toBe("62:03.50");
  });

  it("changes on every frame step", () => {
    const start = 754.2;
    const shown = Array.from({ length: 120 }, (_, frame) => formatReplayTime(start + frame / 60));

    expect(new Set(shown).size).toBe(shown.length);
  });

  it("reads a missing, non-finite or negative time as nothing", () => {
    expect(formatReplayTime(undefined)).toBe("");
    expect(formatReplayTime(Number.NaN)).toBe("");
    expect(formatReplayTime(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatReplayTime(-1)).toBe("");
  });
});

describe("describeReplayPosition", () => {
  it("gives the frame, the time in seconds and the raw replay flag", () => {
    const telemetry = { ReplayFrameNum: 45273, ReplaySessionTime: 754.5566, IsReplayPlaying: true } as TelemetryData;

    expect(describeReplayPosition(telemetry)).toBe("frame=45273, time=754.557, replaying=true");
  });

  it("keeps a zero reading apart from a missing one", () => {
    const zero = { ReplayFrameNum: 0, ReplaySessionTime: 0, IsReplayPlaying: false } as TelemetryData;

    expect(describeReplayPosition(zero)).toBe("frame=0, time=0.000, replaying=false");
    expect(describeReplayPosition({} as TelemetryData)).toBe("frame=n/a, time=n/a, replaying=n/a");
    expect(describeReplayPosition(null)).toBe("frame=n/a, time=n/a, replaying=n/a");
  });
});

describe("frameJogMode", () => {
  it("names its box and describes its rotation for the dial hint", () => {
    expect(frameJogMode.label).toBe("FRAME");
    expect(frameJogMode.rotateDescription).toBe("Next / previous frame");
  });

  describe("rotate", () => {
    it("steps one frame per detent on a replay at rest", () => {
      const forward = fakeIo();
      const back = fakeIo();

      frameJogMode.rotate(1, dial, forward.io);
      frameJogMode.rotate(-1, dial, back.io);

      expect(forward.calls).toEqual(["step:dial-frame-jog:1"]);
      expect(back.calls).toEqual(["step:dial-frame-jog:-1"]);
    });

    it("sends a fast spin as one absolute jump of that many frames", () => {
      const forward = fakeIo();
      const back = fakeIo();

      frameJogMode.rotate(37, dial, forward.io);
      frameJogMode.rotate(-37, dial, back.io);

      expect(forward.calls).toEqual(["jumpTo:dial-frame-jog:5037"]);
      expect(back.calls).toEqual(["jumpTo:dial-frame-jog:4963"]);
    });

    it("jumps from the pending target while the last move has not read back, even for one detent", () => {
      const { io, calls } = fakeIo({ position: at(5010, { seeking: true }) });

      frameJogMode.rotate(1, dial, io);
      frameJogMode.rotate(-3, dial, io);

      expect(calls).toEqual(["jumpTo:dial-frame-jog:5011", "jumpTo:dial-frame-jog:5007"]);
      expect(io.step).not.toHaveBeenCalled();
    });

    it("sends every move through the position calls, never a command of its own", () => {
      const { io } = fakeIo();

      for (const ticks of [1, -1, 2, -2, 3, -4, 12]) frameJogMode.rotate(ticks, dial, io);

      expect(io.setSpeed).not.toHaveBeenCalled();
    });

    it("sends nothing when the position is not known", () => {
      const { io, calls, logger } = fakeIo({ position: null });

      frameJogMode.rotate(1, dial, io);
      frameJogMode.rotate(4, dial, io);

      expect(calls).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("sends nothing at the end of the recording the turn points at", () => {
      const { io, calls } = fakeIo({ position: at(9999) });

      frameJogMode.rotate(1, dial, io);
      frameJogMode.rotate(5, dial, io);

      expect(calls).toEqual([]);
    });

    it.each<[string, ReplaySpeed]>([
      ["at 1x", { speed: 1, slowMotion: false }],
      ["in fast-forward", { speed: 8, slowMotion: false }],
      ["in rewind", { speed: -2, slowMotion: false }],
      ["in slow motion", { speed: 4, slowMotion: true }],
      ["in reverse slow motion", { speed: -4, slowMotion: true }],
    ])("pauses first when the replay is playing %s", (_name, liveSpeed) => {
      const single = fakeIo({ liveSpeed });
      const spin = fakeIo({ liveSpeed });

      frameJogMode.rotate(-1, dial, single.io);
      frameJogMode.rotate(5, dial, spin.io);

      expect(single.calls).toEqual(["pause:dial-frame-jog", "step:dial-frame-jog:-1"]);
      expect(spin.calls).toEqual(["pause:dial-frame-jog", "jumpTo:dial-frame-jog:5005"]);
    });

    it("still pauses a playing replay when there is nothing to move", () => {
      const { io, calls } = fakeIo({ liveSpeed: { speed: 1, slowMotion: false }, position: null });

      frameJogMode.rotate(1, dial, io);

      expect(calls).toEqual(["pause:dial-frame-jog"]);
    });

    it("does not pause a replay that is already paused", () => {
      const { io } = fakeIo({ liveSpeed: PAUSED });

      frameJogMode.rotate(1, dial, io);

      expect(io.pause).not.toHaveBeenCalled();
    });

    it("moves nothing when the pause does not go out", () => {
      const { io, calls, logger } = fakeIo({ liveSpeed: { speed: 1, slowMotion: false }, pauseSent: false });

      frameJogMode.rotate(3, dial, io);

      expect(calls).toEqual(["pause:dial-frame-jog"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("warns when a move does not go out", () => {
      const step = fakeIo({ moveSent: false });
      const jump = fakeIo({ moveSent: false });

      frameJogMode.rotate(1, dial, step.io);
      frameJogMode.rotate(4, dial, jump.io);

      expect(step.logger.warn).toHaveBeenCalledTimes(1);
      expect(jump.logger.warn).toHaveBeenCalledTimes(1);
    });

    it("never sets a speed itself", () => {
      const { io } = fakeIo({ liveSpeed: { speed: 2, slowMotion: false } });

      frameJogMode.rotate(1, dial, io);
      frameJogMode.rotate(-6, dial, io);

      expect(io.setSpeed).not.toHaveBeenCalled();
    });

    it("logs the turn, its move and the reading it was decided on at debug", () => {
      const telemetry = { ReplayFrameNum: 0, ReplaySessionTime: 0, IsReplayPlaying: false } as TelemetryData;
      const pending = fakeIo({ telemetry, position: at(5010, { seeking: true }) });
      const resting = fakeIo({
        telemetry: { ReplayFrameNum: 5000, ReplaySessionTime: 83.333, IsReplayPlaying: true } as TelemetryData,
      });
      const unknown = fakeIo({ telemetry, position: null });

      frameJogMode.rotate(-4, dial, pending.io);
      frameJogMode.rotate(1, dial, resting.io);
      frameJogMode.rotate(1, dial, unknown.io);

      expect(pending.logger.debug).toHaveBeenCalledWith(
        "Frame jog: ticks=-4, playing=false, move=jump to 5006, from=5010 (pending), frame=0, time=0.000, replaying=false",
      );
      expect(resting.logger.debug).toHaveBeenCalledWith(
        "Frame jog: ticks=1, playing=false, move=step 1, from=5000, frame=5000, time=83.333, replaying=true",
      );
      expect(unknown.logger.debug).toHaveBeenCalledWith(
        "Frame jog: ticks=1, playing=false, move=none, from=n/a, frame=0, time=0.000, replaying=false",
      );
    });

    it("logs the turn before the pause and the move go out", () => {
      const { io, calls, logger } = fakeIo({ liveSpeed: { speed: 1, slowMotion: false } });

      logger.debug.mockImplementation(() => void calls.push("debug"));
      frameJogMode.rotate(1, dial, io);

      expect(calls).toEqual(["debug", "pause:dial-frame-jog", "step:dial-frame-jog:1"]);
    });
  });

  describe("view", () => {
    it("shows the position's time with the play state under it", () => {
      const { io } = fakeIo({ position: at(5007, { time: 83.45 }) });

      expect(frameJogMode.view(dial, io)).toEqual({
        value: "1:23.45",
        caption: "PAUSED",
        sides: { left: true, right: true },
      });
    });

    it("shows where a turn is heading while telemetry reads 0", () => {
      const { io } = fakeIo({
        telemetry: { ReplayFrameNum: 0, ReplaySessionTime: 0, IsReplayPlaying: false } as TelemetryData,
        position: at(5010, { time: 83.5, seeking: true }),
      });

      expect(frameJogMode.view(dial, io).value).toBe("1:23.50");
    });

    it.each<[ReplaySpeed, string]>([
      [{ speed: 4, slowMotion: false }, "4x"],
      [{ speed: -2, slowMotion: false }, "-2x"],
      [{ speed: 4, slowMotion: true }, "1/4x"],
      [{ speed: -4, slowMotion: true }, "-1/4x"],
    ])("captions a playing replay with its live speed (%o)", (liveSpeed, caption) => {
      const { io } = fakeIo({ liveSpeed });

      expect(frameJogMode.view(dial, io).caption).toBe(caption);
    });

    it("shows no value when the position or its time is not known, never a raw time of 0", () => {
      const telemetry = { ReplayFrameNum: 0, ReplaySessionTime: 0, IsReplayPlaying: false } as TelemetryData;
      const none = fakeIo({ telemetry, position: null });
      const noTime = fakeIo({ telemetry, position: at(5000, { time: undefined }) });

      expect(frameJogMode.view(dial, none.io).value).toBe("");
      expect(frameJogMode.view(dial, noTime.io).value).toBe("");
    });

    it("sends nothing", () => {
      const { io, calls } = fakeIo({ liveSpeed: { speed: 1, slowMotion: false } });

      frameJogMode.view(dial, io);

      expect(calls).toEqual([]);
      expect(io.setSpeed).not.toHaveBeenCalled();
    });
  });
});
