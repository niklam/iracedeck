import type {
  LapStartListEntry,
  LapStartListing,
  ReplaySessionStart,
  ReplaySessionStore,
  SessionStartListing,
} from "@iracedeck/replay-store";
import { describe, expect, it, vi } from "vitest";

import { findRecordStep, RECORD_STEPS, type RecordStepSource } from "./replay-record-step.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a record step sends nothing");
  }),
  getController: vi.fn(() => {
    throw new Error("a record step reads no telemetry");
  }),
}));

const CAR = 4;

/** A recorded lap start of session (2, 3). */
const lap = (lapNum: number, frame: number, sessionNum = 2, sessionUniqueId = 3): LapStartListEntry => ({
  frame,
  lap: lapNum,
  sessionNum,
  sessionUniqueId,
});

/** Laps 1, 2, 3 … of session (2, 3) at `frames`. */
const lapsAt = (frames: number[]): LapStartListEntry[] => frames.map((frame, i) => lap(i + 1, frame));

/** Sessions 0, 1, 2 … of one instance at `frames`. */
const sessionsAt = (frames: number[]): ReplaySessionStart[] =>
  frames.map((frame, i) => ({ sessionNum: i, sessionUniqueId: 1, frame }));

function source(lapStarts: LapStartListEntry[], sessionStarts: ReplaySessionStart[]): RecordStepSource {
  const laps: LapStartListing = { hit: true, starts: lapStarts };
  const sessions: SessionStartListing = { hit: true, starts: sessionStarts };

  return {
    store: {
      laps: { listLapStarts: () => laps },
      sessions: { list: () => sessions },
    } as unknown as ReplaySessionStore,
    scope: undefined,
    camCarIdx: CAR,
    carNumberRaw: () => 104,
    lapApproachFrames: 60,
  };
}

describe("findRecordStep: direction is decided on the recorded starts, the landing added after", () => {
  const SESSIONS = sessionsAt([0, 60_000, 150_000]);
  const LAPS = lapsAt([50_000, 53_000, 56_000, 59_000]);

  it("Next Session from the tape's first frame, where the first session starts, goes to the second session", () => {
    // After Jump to Beginning: the cursor at 0 is in session 0, not before its landing at 120.
    expect(findRecordStep(RECORD_STEPS["next-session"], 0, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 60_000 + 120,
    });
  });

  it("Next Session from just inside a session (iRacing's search landed 59 frames past its start) goes to the next one", () => {
    expect(findRecordStep(RECORD_STEPS["next-session"], 60_059, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 150_000 + 120,
    });
  });

  it("Next and Previous Session from a session's landing go to the next and the previous session's landings", () => {
    expect(findRecordStep(RECORD_STEPS["next-session"], 60_120, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 150_120,
    });
    expect(findRecordStep(RECORD_STEPS["prev-session"], 60_120, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 120,
    });
  });

  it("Next Lap pressed at a lap's landing goes on to the next lap's landing", () => {
    expect(findRecordStep(RECORD_STEPS["next-lap"], 53_000 - 60, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 56_000 - 60,
    });
  });

  it("Previous Lap pressed at a lap's landing goes to the landing of the one before", () => {
    expect(findRecordStep(RECORD_STEPS["prev-lap"], 56_000 - 60, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 53_000 - 60,
    });
  });

  it("a lap landing before the tape's first frame is the first frame", () => {
    expect(
      findRecordStep(RECORD_STEPS["prev-lap"], 6_050, source(lapsAt([30, 6_000, 12_000]), SESSIONS)),
    ).toMatchObject({
      hit: true,
      frame: 0,
    });
  });
});

describe("findRecordStep: Previous measures its window from the entry's landing", () => {
  const S = 60_000;
  const SESSIONS = sessionsAt([0, S, 150_000]);
  const LAPS = lapsAt([50_000, 53_000, 56_000, 59_000]);

  it("on a playing replay, a second Previous Session goes to the session before, not back to the same start", () => {
    // The first press lands at S + 120 and Replay jump playback resumes play.
    expect(findRecordStep(RECORD_STEPS["prev-session"], 150_120, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: S + 120,
    });
    // The cursor has moved on to S + 200: still within two seconds of the landing.
    expect(findRecordStep(RECORD_STEPS["prev-session"], S + 200, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 0 + 120,
    });
  });

  it("Previous Session more than two seconds past a session's landing goes to that session's own start", () => {
    expect(findRecordStep(RECORD_STEPS["prev-session"], S + 500, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: S + 120,
    });
  });

  it("Previous Lap at a lap's landing goes to the lap before", () => {
    expect(findRecordStep(RECORD_STEPS["prev-lap"], 56_000 - 60, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 53_000 - 60,
    });
  });

  it("Previous Lap half a second after the line goes to the lap before", () => {
    expect(findRecordStep(RECORD_STEPS["prev-lap"], 56_000 + 30, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 53_000 - 60,
    });
  });

  it("Previous Lap more than a second after the line goes to its own lap's start", () => {
    // The landing is a second before the line, so the two-second window ends a second after it.
    expect(findRecordStep(RECORD_STEPS["prev-lap"], 56_000 + 100, source(LAPS, SESSIONS))).toMatchObject({
      hit: true,
      frame: 56_000 - 60,
    });
  });
});

describe("findRecordStep: a gap in the record falls back to the search", () => {
  const NO_SESSIONS: ReplaySessionStart[] = [];

  describe("laps 1-5 and 15-20 recorded (a stint in the garage between)", () => {
    const STARTS = [...[1, 2, 3, 4, 5], ...[15, 16, 17, 18, 19, 20]].map((n) => lap(n, n * 6_000));
    const recorded = source(STARTS, NO_SESSIONS);
    const at = (n: number) => n * 6_000;

    it("Next from lap 5's landing would cross the gap: a miss", () => {
      expect(findRecordStep(RECORD_STEPS["next-lap"], at(5) - 60, recorded)).toEqual({
        hit: false,
        reason: "gap in the record",
      });
    });

    it("Next from inside lap 5, whose end the record does not hold, is outside the record", () => {
      expect(findRecordStep(RECORD_STEPS["next-lap"], at(5) + 1_000, recorded)).toEqual({
        hit: false,
        reason: "outside the record",
      });
    });

    it("Next from inside lap 3 is a hit on lap 4", () => {
      expect(findRecordStep(RECORD_STEPS["next-lap"], at(3) + 1_000, recorded)).toMatchObject({
        hit: true,
        frame: at(4) - 60,
      });
    });

    it("Previous from inside lap 16 hits lap 16's start past the window, else lap 15's", () => {
      expect(findRecordStep(RECORD_STEPS["prev-lap"], at(16) + 1_000, recorded)).toMatchObject({
        hit: true,
        frame: at(16) - 60,
      });
      expect(findRecordStep(RECORD_STEPS["prev-lap"], at(16) + 30, recorded)).toMatchObject({
        hit: true,
        frame: at(15) - 60,
      });
    });

    it("Previous from inside lap 15 within the window would cross the gap: a miss", () => {
      expect(findRecordStep(RECORD_STEPS["prev-lap"], at(15) + 30, recorded)).toEqual({
        hit: false,
        reason: "gap in the record",
      });
    });

    it("an anchor before the first recorded lap is outside the record", () => {
      expect(findRecordStep(RECORD_STEPS["next-lap"], at(1) - 500, recorded)).toEqual({
        hit: false,
        reason: "outside the record",
      });
      expect(findRecordStep(RECORD_STEPS["prev-lap"], at(1) - 500, recorded)).toEqual({
        hit: false,
        reason: "outside the record",
      });
    });

    it("an anchor past the last recorded lap start is outside the record, either way", () => {
      expect(findRecordStep(RECORD_STEPS["next-lap"], at(20) + 1_000, recorded)).toEqual({
        hit: false,
        reason: "outside the record",
      });
      expect(findRecordStep(RECORD_STEPS["prev-lap"], at(20) + 1_000, recorded)).toEqual({
        hit: false,
        reason: "outside the record",
      });
    });
  });

  it("a lap step never crosses from one session's laps to the next session's", () => {
    const starts = [lap(1, 10_000, 1, 2), lap(2, 16_000, 1, 2), lap(1, 30_000, 2, 3), lap(2, 36_000, 2, 3)];

    expect(findRecordStep(RECORD_STEPS["next-lap"], 10_500, source(starts, NO_SESSIONS))).toMatchObject({
      hit: true,
      frame: 16_000 - 60,
    });
    expect(findRecordStep(RECORD_STEPS["next-lap"], 16_000 - 60, source(starts, NO_SESSIONS))).toEqual({
      hit: false,
      reason: "gap in the record",
    });
  });

  describe("sessions", () => {
    it("with sessions 0 and 2 recorded, Next from session 0 is a miss", () => {
      const starts = [
        { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
        { sessionNum: 2, sessionUniqueId: 1, frame: 90_000 },
      ];

      expect(findRecordStep(RECORD_STEPS["next-session"], 1_000, source([], starts))).toEqual({
        hit: false,
        reason: "outside the record",
      });
    });

    it("a restarted event (0, 1, 2, then 0, 1, 2 of another instance) steps through all six", () => {
      const starts = [0, 1, 2, 0, 1, 2].map((sessionNum, i) => ({
        sessionNum,
        sessionUniqueId: i < 3 ? 1 : 2,
        frame: i * 10_000,
      }));
      const landings: number[] = [];
      let anchor = 0;

      for (;;) {
        const found = findRecordStep(RECORD_STEPS["next-session"], anchor, source([], starts));

        if (!found.hit) {
          expect(found.reason).toBe("nothing that way");
          break;
        }

        landings.push(found.frame);
        anchor = found.frame;
      }

      expect(landings).toEqual([10_120, 20_120, 30_120, 40_120, 50_120]);
    });

    it("Previous from inside the last session hits: its span is open", () => {
      const starts = sessionsAt([0, 60_000, 150_000]);

      expect(findRecordStep(RECORD_STEPS["prev-session"], 400_000, source([], starts))).toMatchObject({
        hit: true,
        frame: 150_120,
      });
      expect(findRecordStep(RECORD_STEPS["prev-session"], 150_120, source([], starts))).toMatchObject({
        hit: true,
        frame: 60_120,
      });
    });

    it("an anchor before the first recorded session start is outside the record", () => {
      expect(findRecordStep(RECORD_STEPS["next-session"], 500, source([], sessionsAt([30_000, 60_000])))).toEqual({
        hit: false,
        reason: "outside the record",
      });
    });
  });
});
