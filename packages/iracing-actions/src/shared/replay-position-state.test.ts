import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, cancelReplayCursorOwner, claimReplayCursor } from "./replay-cursor.js";
import {
  _resetReplayPositionState,
  markReplayTargetSent,
  pendingReplayTarget,
  recordReplayTarget,
  REPLAY_TARGET_GIVE_UP_MS,
  replayTargetGiveUpMs,
  resolveReplayPosition,
  settleReplayTarget,
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
      recordReplayTarget(602, replayOn(600), 1_000);

      expect(position(replayOn(600), 1_005)).toEqual({ frame: 602, time: 602 / 60, endFrame: END, seeking: true });
    });

    it("stands through the readings of a jump under way, which carry frame 0", () => {
      recordReplayTarget(640, replayOn(600), 1_000);

      expect(position(NOT_THE_REPLAY, 1_200)).toEqual({ frame: 640, time: 640 / 60, endFrame: END, seeking: true });
    });

    it("works the time out backward as well as forward", () => {
      recordReplayTarget(570, replayOn(600), 1_000);

      expect(position(NOT_THE_REPLAY, 1_100)?.time).toBe(570 / 60);
    });

    it("has no time or end to give when the reading at the send was not the replay's", () => {
      recordReplayTarget(602, NOT_THE_REPLAY, 1_000);

      expect(position(NOT_THE_REPLAY, 1_100)).toEqual({
        frame: 602,
        time: undefined,
        endFrame: undefined,
        seeking: true,
      });
    });

    it("works its time out from the reading its own run started on, never from an earlier one", () => {
      // A reading from another session, long before: resolved, then left behind.
      position(replayOn(50_000, { ReplayFrameNumEnd: 10, ReplaySessionTime: 9_999 }));
      recordReplayTarget(602, NOT_THE_REPLAY, 1_000);

      expect(position(NOT_THE_REPLAY, 1_100)).toMatchObject({ time: undefined, endFrame: undefined });
    });

    it("keeps the reading its run started on through every later move of the run", () => {
      recordReplayTarget(602, replayOn(600), 1_000);
      position(NOT_THE_REPLAY, 1_060);
      recordReplayTarget(605, NOT_THE_REPLAY, 1_060);

      expect(position(NOT_THE_REPLAY, 1_100)).toEqual({ frame: 605, time: 605 / 60, endFrame: END, seeking: true });
    });

    it("ends when its frame reads back from a replay", () => {
      recordReplayTarget(602, replayOn(600), 1_000);

      expect(position(replayOn(602), 1_020)).toEqual({ frame: 602, time: 602 / 60, endFrame: END, seeking: false });
      expect(position(replayOn(602), 1_040)?.seeking).toBe(false);
    });

    it("does not end on its frame read from outside a replay", () => {
      recordReplayTarget(0, replayOn(600), 1_000);

      // A jump to frame 0 reads frame 0 for as long as it is under way.
      expect(position(NOT_THE_REPLAY, 1_100)?.seeking).toBe(true);
      expect(position(replayOn(0), 1_400)?.seeking).toBe(false);
    });

    it("does not come back when the replay later passes the same frame", () => {
      recordReplayTarget(602, replayOn(600), 1_000);
      position(replayOn(602), 1_020);

      expect(position(replayOn(700), 1_500)).toMatchObject({ frame: 700, seeking: false });
      expect(position(replayOn(602), 1_600)).toMatchObject({ frame: 602, seeking: false });
    });

    it("is replaced by the next one, which is measured from it", () => {
      recordReplayTarget(602, replayOn(600), 1_000);

      const from = position(NOT_THE_REPLAY, 1_060);

      recordReplayTarget((from?.frame ?? 0) + 3, NOT_THE_REPLAY, 1_060);

      expect(position(NOT_THE_REPLAY, 1_100)).toMatchObject({ frame: 605, seeking: true });
      expect(position(replayOn(602), 1_400)).toMatchObject({ frame: 605, seeking: true });
      expect(position(replayOn(605), 1_480)).toMatchObject({ frame: 605, seeking: false });
    });
  });

  describe("a read-back that could mean something else", () => {
    it("a turn back onto the frame still on screen is not landed by that frame alone", () => {
      // The replay shows 600; a jump to 604 waits; the turn reverses onto 600.
      recordReplayTarget(604, replayOn(600), 1_000);
      position(replayOn(600), 1_030);
      recordReplayTarget(600, replayOn(600), 1_030);

      // Still showing 600: neither jump has been acted on yet.
      expect(position(replayOn(600), 1_040)).toMatchObject({ frame: 600, seeking: true });
      expect(position(replayOn(600), 1_200)).toMatchObject({ frame: 600, seeking: true });
    });

    it("is landed once the jump has been seen under way and the frame reads back after it", () => {
      recordReplayTarget(604, replayOn(600), 1_000);
      recordReplayTarget(600, replayOn(600), 1_030);
      position(replayOn(600), 1_040);

      expect(position(NOT_THE_REPLAY, 1_100)).toMatchObject({ frame: 600, seeking: true });
      expect(position(replayOn(600), 1_450)).toMatchObject({ frame: 600, seeking: false });
    });

    it("a fast turn ending on a frame it already stopped on is not landed by a stop on the way", () => {
      recordReplayTarget(604, replayOn(602), 1_060);
      recordReplayTarget(606, replayOn(602), 1_120);
      recordReplayTarget(604, replayOn(602), 1_180);

      // The replay lands on the 604 of the first jump, the newest when it was acted on.
      expect(position(replayOn(604), 1_190)).toMatchObject({ frame: 604, seeking: true });
      // The last jump is then seen under way, and the landing after it is the real one.
      position(NOT_THE_REPLAY, 1_250);
      expect(position(replayOn(604), 1_600)).toMatchObject({ frame: 604, seeking: false });
    });

    it("a target the replay happens to be showing at the send waits for the same proof", () => {
      // The reading was not the replay's when the run began, and shows 700 at the next send.
      recordReplayTarget(650, NOT_THE_REPLAY, 1_000);
      recordReplayTarget(700, replayOn(700), 1_060);

      expect(position(replayOn(700), 1_070)).toMatchObject({ frame: 700, seeking: true });
    });

    it("is given up like any other when the proof never comes", () => {
      recordReplayTarget(604, replayOn(600), 1_000);
      recordReplayTarget(600, replayOn(600), 1_030);

      expect(position(replayOn(600), 1_030 + REPLAY_TARGET_GIVE_UP_MS)).toMatchObject({ frame: 600, seeking: false });
    });
  });

  describe("giving a target up", () => {
    it("holds it until the jump's own wait has run out, then takes the replay where it reads", () => {
      recordReplayTarget(END + 500, replayOn(600), 1_000);

      // A jump of 204463 frames: twice its time at iRacing's search rate, more than the three-second floor (#1430).
      const waitMs = replayTargetGiveUpMs(END + 500 - 600);

      expect(waitMs).toBeGreaterThan(REPLAY_TARGET_GIVE_UP_MS);
      expect(position(replayOn(END), 1_000 + waitMs - 1)).toMatchObject({ frame: END + 500, seeking: true });
      expect(position(replayOn(END), 1_000 + waitMs)).toMatchObject({ frame: END, seeking: false });
      expect(position(replayOn(END), 1_000 + waitMs + 1)?.seeking).toBe(false);
    });

    it("is unknown afterwards when the reading is not the replay's, so nothing is measured from frame 0", () => {
      recordReplayTarget(640, replayOn(600), 1_000);

      expect(position(NOT_THE_REPLAY, 1_000 + REPLAY_TARGET_GIVE_UP_MS)).toBeNull();
    });

    it("says so in the log, with what the replay reads", () => {
      recordReplayTarget(640, replayOn(600), 1_000);
      position(replayOn(9_000), 1_000 + REPLAY_TARGET_GIVE_UP_MS);

      expect(logged()).toContain(
        `Replay target given up: frame 640 did not read back within ${REPLAY_TARGET_GIVE_UP_MS} ms; the replay reads 9000`,
      );
    });

    it("counts from the newest move, so a turn kept up is not given up mid-turn", () => {
      recordReplayTarget(600, replayOn(598), 1_000);

      for (let i = 1; i <= 100; i++) {
        const now = 1_000 + i * 60;

        recordReplayTarget(600 + 2 * i, NOT_THE_REPLAY, now);
        expect(position(NOT_THE_REPLAY, now + 1)?.seeking).toBe(true);
      }

      expect(position(NOT_THE_REPLAY, 1_000 + 100 * 60 + REPLAY_TARGET_GIVE_UP_MS - 1)).toMatchObject({
        frame: 800,
        seeking: true,
      });
    });
  });

  describe("a replay that stands off its target", () => {
    const OFF =
      "Replay stands off its target: sent to frame 606, reads 9353; the next turn is measured from the target";

    function turn(): void {
      recordReplayTarget(602, replayOn(600), 1_000);
      position(NOT_THE_REPLAY, 1_060);
      recordReplayTarget(604, NOT_THE_REPLAY, 1_060);
      position(NOT_THE_REPLAY, 1_120);
      recordReplayTarget(606, NOT_THE_REPLAY, 1_120);
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

      recordReplayTarget((from?.frame ?? 0) + 1, replayOn(9_353), 1_500);

      expect(position(replayOn(607), 1_900)).toMatchObject({ frame: 607, seeking: false });

      logger.debug.mockClear();
      recordReplayTarget(608, replayOn(607), 2_000);
      position(replayOn(607), 2_005);

      expect(logged()).toEqual([]);
    });
  });

  describe("the replay cursor (#1430)", () => {
    it("keeps the target when anything takes the cursor: the replay is still headed there", () => {
      recordReplayTarget(640, replayOn(600), 1_000);
      cancelReplayCursorOwner("play-pause");

      expect(position(NOT_THE_REPLAY, 1_100)).toMatchObject({ frame: 640, seeking: true });
    });

    it("keeps the target when something claims the cursor, and the run with it", () => {
      recordReplayTarget(602, replayOn(600), 1_000);
      claimReplayCursor("jump-to-fastest-lap");

      expect(position(NOT_THE_REPLAY, 1_050)).toMatchObject({ frame: 602, seeking: true });

      // The run is the same one: 602 is still a stop on the way for the next move, not a bad landing.
      recordReplayTarget(605, NOT_THE_REPLAY, 1_060);
      position(replayOn(602), 1_400);

      expect(logged()).toEqual([]);
    });
  });

  describe("the jump's own wait (#1430)", () => {
    /** Six hours of recording at 60 frames a second. */
    const SIX_HOURS = 1_296_000;

    it("is three seconds for a short jump and twice the jump's length at iRacing's search rate for a long one", () => {
      expect(replayTargetGiveUpMs(30)).toBe(REPLAY_TARGET_GIVE_UP_MS);
      // 1296000 frames at 2048 a sim update is 633 updates, 10.55 s; twice that.
      expect(replayTargetGiveUpMs(SIX_HOURS)).toBe(Math.ceil(2 * 633 * (1000 / 60)));
    });

    it("keeps a target across six hours standing for as long as its jump could still be seeking", () => {
      recordReplayTarget(SIX_HOURS, replayOn(10, { ReplayFrameNumEnd: SIX_HOURS + 100 }), 1_000);

      const waitMs = replayTargetGiveUpMs(SIX_HOURS - 10);

      expect(position(NOT_THE_REPLAY, 1_000 + 10_000)).toMatchObject({ frame: SIX_HOURS, seeking: true });
      expect(position(NOT_THE_REPLAY, 1_000 + waitMs - 1)).toMatchObject({ seeking: true });
      expect(position(NOT_THE_REPLAY, 1_000 + waitMs)).toBeNull();
    });

    it("does not give a target up while the replay jump that recorded it holds the cursor", () => {
      let held = true;

      recordReplayTarget(640, replayOn(600), 1_000, { heldBy: () => held });

      expect(position(NOT_THE_REPLAY, 1_000 + 60_000)).toMatchObject({ frame: 640, seeking: true });

      held = false;

      expect(position(NOT_THE_REPLAY, 1_000 + 60_000)).toBeNull();
    });
  });

  describe("a target recorded before its seek (#1430)", () => {
    it("is a position at once, never reads back and is never timed before its seek goes out", () => {
      const target = recordReplayTarget(40_000, replayOn(600), 1_000, { sent: false });

      expect(position(replayOn(40_000), 1_000 + 60_000)).toMatchObject({ frame: 40_000, seeking: true });
      expect(pendingReplayTarget()).toMatchObject({ id: target.id, sent: false });
    });

    it("judges a read-back from the send: a frame the replay ran across before the seek is not a landing", () => {
      const target = recordReplayTarget(40_000, replayOn(39_990, { ReplayPlaySpeed: 16 }), 1_000, { sent: false });

      // The replay fast-forwarded onto the frame while its pause took hold; the seek goes out from there.
      markReplayTargetSent(target, replayOn(40_000), 1_100);

      expect(settleReplayTarget(replayOn(40_000), 1_120, logger as never)).toEqual({ kind: "none" });
      expect(settleReplayTarget(NOT_THE_REPLAY, 1_140, logger as never)).toEqual({ kind: "none" });
      expect(settleReplayTarget(replayOn(40_000), 1_160, logger as never)).toMatchObject({ kind: "read-back" });
    });

    it("reads back on its frame once sent from anywhere else", () => {
      const target = recordReplayTarget(40_000, replayOn(600), 1_000, { sent: false });

      markReplayTargetSent(target, replayOn(600), 1_100);

      expect(settleReplayTarget(replayOn(40_000), 1_150, logger as never)).toMatchObject({
        kind: "read-back",
        target: { frame: 40_000, sent: true, sentAt: 1_100 },
      });
    });

    it("is marked only by the record it belongs to", () => {
      const first = recordReplayTarget(40_000, replayOn(600), 1_000, { sent: false });

      recordReplayTarget(41_000, replayOn(600), 1_010, { sent: false });
      markReplayTargetSent(first, replayOn(600), 1_100);

      expect(pendingReplayTarget()).toMatchObject({ frame: 41_000, sent: false });
    });
  });
});
