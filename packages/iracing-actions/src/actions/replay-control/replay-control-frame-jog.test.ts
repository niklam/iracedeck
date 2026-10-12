import { type ReplayCommand, ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { formatReplayTime, frameJogMode, sendFrameSteps } from "./replay-control-frame-jog.js";

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
const dial = ReplayControlDialSettings.parse({});

interface FakeIoOptions {
  liveSpeed?: ReplaySpeed;
  telemetry?: TelemetryData | null;
  /** What `io.pause` reports; false is a pause that did not go out. */
  pauseSent?: boolean;
  /** How many frame steps go out before one fails; all of them by default. */
  stepsSent?: number;
}

/**
 * A surface stand-in: `send` runs the mode's callback against a fake replay,
 * and `calls` records every command in the order it went out, with the
 * cursor owner it was sent under.
 */
function fakeIo(options: FakeIoOptions = {}) {
  const calls: string[] = [];
  let stepsLeft = options.stepsSent ?? Infinity;
  const step = (name: string) => () => {
    calls.push(name);

    return stepsLeft-- > 0;
  };
  const replay = {
    nextFrame: vi.fn<() => boolean>(step("nextFrame")),
    prevFrame: vi.fn<() => boolean>(step("prevFrame")),
    setPlayPosition: vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>((mode, frameNumber) => {
      calls.push(`setPlayPosition(${ReplayPosMode[mode]}, ${frameNumber})`);

      return true;
    }),
  };
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const io: ReplayDialModeIo = {
    logger: logger as unknown as ILogger,
    liveSpeed: () => options.liveSpeed ?? PAUSED,
    telemetry: () => options.telemetry ?? null,
    send: vi.fn<ReplayDialModeIo["send"]>((owner, run) => {
      calls.push(`send:${owner}`);

      return run(replay as unknown as ReplayCommand);
    }),
    setSpeed: vi.fn<ReplayDialModeIo["setSpeed"]>(() => true),
    pause: vi.fn<ReplayDialModeIo["pause"]>((owner) => {
      calls.push(`pause:${owner}`);

      return options.pauseSent ?? true;
    }),
  };

  return { io, replay, logger, calls };
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

describe("sendFrameSteps", () => {
  it("sends a single detent as a frame step either way, as one jump or not", () => {
    for (const asOneJump of [true, false]) {
      const forward = fakeIo();
      const back = fakeIo();

      expect(sendFrameSteps(forward.io, 1, asOneJump)).toBe(true);
      expect(sendFrameSteps(back.io, -1, asOneJump)).toBe(true);

      expect(forward.calls).toEqual(["send:dial-frame-jog", "nextFrame"]);
      expect(back.calls).toEqual(["send:dial-frame-jog", "prevFrame"]);
    }
  });

  it("sends several detents as one relative jump, signed", () => {
    const forward = fakeIo();
    const back = fakeIo();

    sendFrameSteps(forward.io, 4, true);
    sendFrameSteps(back.io, -4, true);

    expect(forward.calls).toEqual(["send:dial-frame-jog", "setPlayPosition(Current, 4)"]);
    expect(back.calls).toEqual(["send:dial-frame-jog", "setPlayPosition(Current, -4)"]);
    expect(back.replay.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Current, -4);
  });

  it("falls back to that many single steps inside one send", () => {
    const forward = fakeIo();
    const back = fakeIo();

    expect(sendFrameSteps(forward.io, 3, false)).toBe(true);
    expect(sendFrameSteps(back.io, -3, false)).toBe(true);

    expect(forward.calls).toEqual(["send:dial-frame-jog", "nextFrame", "nextFrame", "nextFrame"]);
    expect(back.calls).toEqual(["send:dial-frame-jog", "prevFrame", "prevFrame", "prevFrame"]);
    expect(back.replay.setPlayPosition).not.toHaveBeenCalled();
  });

  it("stops the fallback at the first step that does not go out", () => {
    const { io, calls } = fakeIo({ stepsSent: 1 });

    expect(sendFrameSteps(io, 4, false)).toBe(false);
    expect(calls).toEqual(["send:dial-frame-jog", "nextFrame", "nextFrame"]);
  });

  it("reports a single step that does not go out", () => {
    const { io } = fakeIo({ stepsSent: 0 });

    expect(sendFrameSteps(io, 1, true)).toBe(false);
  });
});

describe("frameJogMode", () => {
  it("describes its rotation for the dial hint", () => {
    expect(frameJogMode.rotateDescription).toBe("Next / previous frame");
  });

  describe("rotate", () => {
    it("steps one frame per detent on a paused replay", () => {
      const forward = fakeIo();
      const back = fakeIo();

      frameJogMode.rotate(1, dial, forward.io);
      frameJogMode.rotate(-1, dial, back.io);

      expect(forward.calls).toEqual(["send:dial-frame-jog", "nextFrame"]);
      expect(back.calls).toEqual(["send:dial-frame-jog", "prevFrame"]);
    });

    it("sends a fast spin as one relative jump of that many frames, uncapped", () => {
      const forward = fakeIo();
      const back = fakeIo();

      frameJogMode.rotate(37, dial, forward.io);
      frameJogMode.rotate(-37, dial, back.io);

      expect(forward.calls).toEqual(["send:dial-frame-jog", "setPlayPosition(Current, 37)"]);
      expect(back.calls).toEqual(["send:dial-frame-jog", "setPlayPosition(Current, -37)"]);
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

      expect(single.calls).toEqual(["pause:dial-frame-jog", "send:dial-frame-jog", "prevFrame"]);
      expect(spin.calls).toEqual(["pause:dial-frame-jog", "send:dial-frame-jog", "setPlayPosition(Current, 5)"]);
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
      expect(io.send).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("never sets a speed itself", () => {
      const { io } = fakeIo({ liveSpeed: { speed: 2, slowMotion: false } });

      frameJogMode.rotate(1, dial, io);
      frameJogMode.rotate(-6, dial, io);

      expect(io.setSpeed).not.toHaveBeenCalled();
    });

    it("logs the ticks at debug, for the capture that confirms the jump", () => {
      const { io, logger } = fakeIo();

      frameJogMode.rotate(-4, dial, io);

      expect(logger.debug).toHaveBeenCalledWith("Frame jog: ticks=-4, playing=false");
    });
  });

  describe("view", () => {
    it("shows the replay time with the play state under it", () => {
      const { io } = fakeIo({ telemetry: { ReplaySessionTime: 83.45 } as TelemetryData });

      expect(frameJogMode.view(dial, io)).toEqual({
        label: "FRAME",
        value: "1:23.45",
        caption: "PAUSED",
        sides: { left: true, right: true },
      });
    });

    it.each<[ReplaySpeed, string]>([
      [{ speed: 4, slowMotion: false }, "4x"],
      [{ speed: -2, slowMotion: false }, "-2x"],
      [{ speed: 4, slowMotion: true }, "1/4x"],
      [{ speed: -4, slowMotion: true }, "-1/4x"],
    ])("captions a playing replay with its live speed (%o)", (liveSpeed, caption) => {
      const { io } = fakeIo({ liveSpeed, telemetry: { ReplaySessionTime: 1 } as TelemetryData });

      expect(frameJogMode.view(dial, io).caption).toBe(caption);
    });

    it("shows no value without telemetry or without the time", () => {
      const none = fakeIo({ telemetry: null });
      const noTime = fakeIo({ telemetry: {} as TelemetryData });

      expect(frameJogMode.view(dial, none.io).value).toBe("");
      expect(frameJogMode.view(dial, noTime.io).value).toBe("");
    });

    it("sends nothing", () => {
      const { io, calls } = fakeIo({ liveSpeed: { speed: 1, slowMotion: false } });

      frameJogMode.view(dial, io);

      expect(calls).toEqual([]);
      expect(io.send).not.toHaveBeenCalled();
      expect(io.pause).not.toHaveBeenCalled();
      expect(io.setSpeed).not.toHaveBeenCalled();
    });
  });
});
