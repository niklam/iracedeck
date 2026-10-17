import type { LapStartListing, ReplaySessionStore, SessionStartListing } from "@iracedeck/replay-store";
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

function source(lapStarts: number[], sessionStarts: number[]): RecordStepSource {
  const laps: LapStartListing = { hit: true, frames: lapStarts };
  const sessions: SessionStartListing = {
    hit: true,
    starts: sessionStarts.map((frame, i) => ({ sessionNum: i, sessionUniqueId: i + 1, frame })),
  };

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
  const SESSIONS = [0, 60_000, 150_000];
  const LAPS = [50_000, 53_000, 56_000, 59_000];

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
    expect(findRecordStep(RECORD_STEPS["prev-lap"], 6_050, source([30, 6_000], SESSIONS))).toMatchObject({
      hit: true,
      frame: 0,
    });
  });
});
