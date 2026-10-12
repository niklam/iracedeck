import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";
import {
  _resetReplayPositionState,
  recordReplayTarget,
  REPLAY_LANDING_GIVE_UP_MS,
  resolveReplayPosition,
} from "./replay-position-state.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** The last frame of the recording the readings below come from. */
const END = 204_563;

/** A paused replay standing on `frame`, as iRacing reports it: frames left, not a position, in `ReplayFrameNumEnd`. */
function replayOn(frame: number, extra: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: frame,
    ReplayFrameNumEnd: END - frame,
    ReplaySessionTime: frame / 60,
    ...extra,
  } as TelemetryData;
}

/** What iRacing reports for the whole of a jump under way, and from the car. */
const NOT_THE_REPLAY = {
  IsReplayPlaying: false,
  ReplayFrameNum: 0,
  ReplayFrameNumEnd: END,
  ReplaySessionTime: 0,
} as TelemetryData;

function position(telemetry: TelemetryData | null, nowMs = 1_000) {
  return resolveReplayPosition(telemetry, nowMs, logger as never);
}

function logged(): string[] {
  return logger.debug.mock.calls.map((call) => String(call[0]));
}

describe("replay position state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetReplayCursor();
    _resetReplayPositionState();
  });

  describe("with nothing pending", () => {
    it("is the frame, the time and the end of the recording a replay's reading carries", () => {
      expect(position(replayOn(15_494))).toEqual({
        frame: 15_494,
        time: 15_494 / 60,
        endFrame: END,
        seeking: false,
      });
    });

    it.each<[string, TelemetryData | null]>([
      ["no telemetry", null],
      ["a reading that is not the replay's", NOT_THE_REPLAY],
      ["a reading without the flag", { ReplayFrameNum: 600 } as TelemetryData],
      ["a reading without a frame", { IsReplayPlaying: true } as TelemetryData],
      ["a frame that is not a number", { IsReplayPlaying: true, ReplayFrameNum: Number.NaN } as TelemetryData],
    ])("is unknown for %s", (_name, telemetry) => {
      expect(position(telemetry)).toBeNull();
    });

    it("leaves the time and the end unknown when the reading does not say", () => {
      expect(position({ IsReplayPlaying: true, ReplayFrameNum: 600 } as TelemetryData)).toEqual({
        frame: 600,
        time: undefined,
        endFrame: undefined,
        seeking: false,
      });
    });

    it("ignores a count of frames left that cannot be one", () => {
      expect(position(replayOn(600, { ReplayFrameNumEnd: -1 }))?.endFrame).toBeUndefined();
    });
  });

  describe("a move that was sent", () => {
    it("is where the next move is measured from, before telemetry shows it", () => {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);

      expect(position(replayOn(600), 1_005)).toEqual({ frame: 602, time: 602 / 60, endFrame: END, seeking: true });
    });

    it("stands through the readings of a jump under way, which carry frame 0", () => {
      position(replayOn(600));
      recordReplayTarget(640, 600, 1_000);

      expect(position(NOT_THE_REPLAY, 1_200)).toEqual({ frame: 640, time: 640 / 60, endFrame: END, seeking: true });
    });

    it("works the time out backward as well as forward", () => {
      position(replayOn(600));
      recordReplayTarget(570, 600, 1_000);

      expect(position(NOT_THE_REPLAY, 1_100)?.time).toBe(570 / 60);
    });

    it("has no time to give when no reading ever carried one", () => {
      recordReplayTarget(602, null, 1_000);

      expect(position(NOT_THE_REPLAY, 1_100)).toEqual({
        frame: 602,
        time: undefined,
        endFrame: undefined,
        seeking: true,
      });
    });

    it("ends when its exact frame reads back from a replay", () => {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);

      expect(position(replayOn(602), 1_020)).toEqual({ frame: 602, time: 602 / 60, endFrame: END, seeking: false });
      expect(pendingReplayLanding()).toBeNull();
    });

    it("does not end on its frame read from outside a replay", () => {
      recordReplayTarget(0, 600, 1_000);

      // A jump to frame 0 reads frame 0 for as long as it is under way.
      expect(position(NOT_THE_REPLAY, 1_100)?.seeking).toBe(true);
      expect(position(replayOn(0), 1_400)?.seeking).toBe(false);
    });

    it("does not come back when the replay later passes the same frame", () => {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);
      position(replayOn(602), 1_020);

      expect(position(replayOn(700), 1_500)).toMatchObject({ frame: 700, seeking: false });
      expect(position(replayOn(602), 1_600)).toMatchObject({ frame: 602, seeking: false });
    });

    it("is replaced by the next one, which is measured from it", () => {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);

      const from = position(NOT_THE_REPLAY, 1_060);

      recordReplayTarget((from?.frame ?? 0) + 3, null, 1_060);

      expect(position(NOT_THE_REPLAY, 1_100)).toMatchObject({ frame: 605, seeking: true });
      expect(position(replayOn(602), 1_400)).toMatchObject({ frame: 605, seeking: true });
      expect(position(replayOn(605), 1_480)).toMatchObject({ frame: 605, seeking: false });
    });

    it("is dropped by anything else taking the replay cursor", () => {
      position(replayOn(600));
      recordReplayTarget(640, 600, 1_000);
      cancelReplayCursorOwner("play-pause");

      expect(position(replayOn(612), 1_100)).toMatchObject({ frame: 612, seeking: false });
      expect(position(NOT_THE_REPLAY, 1_200)).toBeNull();
    });
  });

  describe("giving a landing up", () => {
    it("holds it until the give-up time, then takes the replay where it reads", () => {
      position(replayOn(600));
      recordReplayTarget(END + 500, 600, 1_000);

      expect(position(replayOn(END), 1_000 + REPLAY_LANDING_GIVE_UP_MS - 1)).toMatchObject({
        frame: END + 500,
        seeking: true,
      });
      expect(position(replayOn(END), 1_000 + REPLAY_LANDING_GIVE_UP_MS)).toMatchObject({ frame: END, seeking: false });
      expect(pendingReplayLanding()).toBeNull();
    });

    it("is unknown afterwards when the reading is not the replay's, so nothing is measured from frame 0", () => {
      position(replayOn(600));
      recordReplayTarget(640, 600, 1_000);

      expect(position(NOT_THE_REPLAY, 1_000 + REPLAY_LANDING_GIVE_UP_MS)).toBeNull();
    });

    it("says so in the log, with what the replay reads", () => {
      position(replayOn(600));
      recordReplayTarget(640, 600, 1_000);
      position(replayOn(9_000), 1_000 + REPLAY_LANDING_GIVE_UP_MS);

      expect(logged()).toContain(
        `Replay landing given up: frame 640 did not read back within ${REPLAY_LANDING_GIVE_UP_MS} ms; the replay reads 9000`,
      );
    });

    it("counts from the newest move, so a turn kept up is not given up mid-turn", () => {
      position(replayOn(600));

      for (let i = 1; i <= 100; i++) {
        const now = 1_000 + i * 60;

        recordReplayTarget(600 + 2 * i, null, now);
        expect(position(NOT_THE_REPLAY, now + 1)?.seeking).toBe(true);
      }

      expect(position(NOT_THE_REPLAY, 1_000 + 100 * 60 + REPLAY_LANDING_GIVE_UP_MS - 1)).toMatchObject({
        frame: 800,
        seeking: true,
      });
    });
  });

  describe("a replay that stands off its target", () => {
    const OFF =
      "Replay stands off its target: sent to frame 606, reads 9353; the next turn is measured from the target";

    function turn(): void {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);
      position(NOT_THE_REPLAY, 1_060);
      recordReplayTarget(604, null, 1_060);
      position(NOT_THE_REPLAY, 1_120);
      recordReplayTarget(606, null, 1_120);
    }

    it("is still measured from the target, and logged once", () => {
      turn();

      expect(position(replayOn(9_353), 1_500)).toMatchObject({ frame: 606, seeking: true });
      expect(position(replayOn(9_353), 1_550)).toMatchObject({ frame: 606, seeking: true });
      expect(logged().filter((line) => line === OFF)).toHaveLength(1);
    });

    it("is not a move that has not started: the reading still shows where the turn began", () => {
      turn();
      position(replayOn(600), 1_125);

      expect(logged()).toEqual([]);
    });

    it("is not a fast turn's stop on the way, on an earlier target of the same turn", () => {
      turn();
      position(replayOn(602), 1_400);
      position(replayOn(604), 1_450);

      expect(logged()).toEqual([]);
      expect(position(replayOn(604), 1_460)).toMatchObject({ frame: 606, seeking: true });
    });

    it("is logged again when it then stands somewhere else", () => {
      turn();
      position(replayOn(9_353), 1_500);
      position(replayOn(1), 1_600);

      expect(logged()).toHaveLength(2);
    });

    it("is put right by the next move, which starts a clean slate once it reads back", () => {
      turn();

      const from = position(replayOn(9_353), 1_500);

      recordReplayTarget((from?.frame ?? 0) + 1, null, 1_500);

      expect(position(replayOn(607), 1_900)).toMatchObject({ frame: 607, seeking: false });

      logger.debug.mockClear();
      recordReplayTarget(608, 607, 2_000);
      position(replayOn(607), 2_005);

      expect(logged()).toEqual([]);
    });
  });

  describe("a landing another surface recorded", () => {
    it("is measured from like its own, and never reported as off", () => {
      position(replayOn(600));
      // A Replay Markers jump: the same pending landing, recorded by its own surface.
      recordReplayLanding(40_000, 1_000);

      expect(position(replayOn(600), 1_010)).toMatchObject({ frame: 40_000, seeking: true });
      expect(position(replayOn(38_000), 1_200)).toMatchObject({ frame: 40_000, seeking: true });
      expect(logged()).toEqual([]);
      expect(position(replayOn(40_000), 1_400)).toMatchObject({ frame: 40_000, seeking: false });
    });

    it("is not given up while its jump still holds a claim on the replay cursor", () => {
      position(replayOn(600));

      const claim = claimReplayCursor("replay-markers-next");

      recordReplayLanding(180_000, 1_000);

      expect(position(NOT_THE_REPLAY, 1_000 + REPLAY_LANDING_GIVE_UP_MS * 5)).toMatchObject({
        frame: 180_000,
        seeking: true,
      });
      expect(pendingReplayLanding()).not.toBeNull();

      claim.release();

      expect(position(NOT_THE_REPLAY, 1_000 + REPLAY_LANDING_GIVE_UP_MS * 5)).toBeNull();
      expect(pendingReplayLanding()).toBeNull();
    });

    it("ends a run of this module's moves, so their targets explain nothing after it", () => {
      position(replayOn(600));
      recordReplayTarget(602, 600, 1_000);
      position(NOT_THE_REPLAY, 1_030);
      recordReplayTarget(604, null, 1_030);
      recordReplayLanding(40_000, 1_050);
      // The replay is seen on 602, so that is where the next run starts from.
      position(replayOn(602), 1_100);
      recordReplayTarget(40_001, null, 1_100);
      position(replayOn(602), 1_150);

      expect(logged()).toEqual([]);

      // 604 was a target of the earlier run, not of this one.
      position(replayOn(604), 1_200);

      expect(logged()).toEqual([
        "Replay stands off its target: sent to frame 40001, reads 604; the next turn is measured from the target",
      ]);
    });
  });
});
