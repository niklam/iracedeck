import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplayGreens } from "./replay-greens.js";
import { diffReplayLaps } from "./replay-laps.js";
import {
  LIVE_EDGE_MAX_FRAMES,
  readSubSessionId,
  resolveReplayLiveTick,
  resolveReplayRecordTick,
  resolveSubSessionId,
} from "./replay-record-gate.js";

type TickOverrides = Partial<{
  frame: number | undefined;
  cursorFrame: number;
  sessionNum: number | undefined;
  uniqueId: number | undefined;
  replay: boolean;
}>;

function tick(o: TickOverrides = {}): TelemetryData {
  return {
    ReplayFrameNumEnd: "frame" in o ? o.frame : 30_000,
    ReplayFrameNum: o.cursorFrame ?? 0,
    SessionNum: "sessionNum" in o ? o.sessionNum : 2,
    SessionUniqueID: "uniqueId" in o ? o.uniqueId : 4,
    IsReplayPlaying: o.replay ?? false,
    // What the two recorders read on top of the gate.
    SessionState: SessionState.Racing,
    SessionFlags: 0,
    CarIdxLapCompleted: [4, 4],
    CarIdxLastLapTime: [91.5, 92.5],
  } as TelemetryData;
}

describe("resolveReplayRecordTick", () => {
  it("returns the session identity and the live frame of an eligible tick", () => {
    expect(resolveReplayRecordTick(tick({ frame: 30_215 }), false)).toEqual({
      sessionNum: 2,
      sessionUniqueId: 4,
      frame: 30_215,
    });
  });

  it("accepts session 0 and frame 0 — neither is a sentinel", () => {
    expect(resolveReplayRecordTick(tick({ sessionNum: 0, frame: 0 }), false)).toEqual({
      sessionNum: 0,
      sessionUniqueId: 4,
      frame: 0,
    });
  });

  it("reads SessionUniqueID 0 from a build that does not carry it", () => {
    expect(resolveReplayRecordTick(tick({ uniqueId: undefined }), false)?.sessionUniqueId).toBe(0);
  });

  it("refuses a tick the translator calls a replay, whatever the flag reads", () => {
    // The replay view: the flag and the debounced state agree.
    expect(resolveReplayRecordTick(tick({ replay: true, cursorFrame: 12_000 }), true)).toBeNull();
    // A seek's blip tick or a saved replay: the flag reads false, the state does not (#1324).
    expect(resolveReplayRecordTick(tick(), true)).toBeNull();
  });

  it("takes `inReplay` as given: the tick's own IsReplayPlaying only picks which frame is read", () => {
    // Not a combination the translator produces, since the debounced state is
    // true whenever the flag is — pinned so the gate is seen not to re-derive
    // the replay state from the flag.
    expect(resolveReplayRecordTick(tick({ replay: true, cursorFrame: 12_000 }), false)?.frame).toBe(12_000);
  });

  it("refuses a tick with no session: SessionNum negative, missing or not a number", () => {
    expect(resolveReplayRecordTick(tick({ sessionNum: -1 }), false)).toBeNull();
    expect(resolveReplayRecordTick(tick({ sessionNum: undefined }), false)).toBeNull();
    expect(resolveReplayRecordTick(tick({ sessionNum: Number.NaN }), false)).toBeNull();
  });

  it("refuses a tick with no readable frame", () => {
    expect(resolveReplayRecordTick(tick({ frame: undefined }), false)).toBeNull();
    expect(resolveReplayRecordTick(tick({ frame: Number.NaN }), false)).toBeNull();
  });
});

describe("resolveReplayLiveTick (issue #1426)", () => {
  type EdgeOverrides = Partial<{
    cursorFrame: number | undefined;
    toEnd: number | undefined;
    sessionNum: number | undefined;
    uniqueId: number | undefined;
    flag: boolean;
  }>;

  /** Out of the car in the in-session replay: the cursor and its distance to the end of the tape. */
  function outOfCar(o: EdgeOverrides = {}): TelemetryData {
    return {
      ReplayFrameNum: "cursorFrame" in o ? o.cursorFrame : 53_592,
      ReplayFrameNumEnd: "toEnd" in o ? o.toEnd : 1,
      SessionNum: "sessionNum" in o ? o.sessionNum : 0,
      SessionUniqueID: "uniqueId" in o ? o.uniqueId : 3,
      IsReplayPlaying: o.flag ?? true,
    } as TelemetryData;
  }

  describe("in the car", () => {
    it("is resolveReplayRecordTick's own answer, the frame ReplayFrameNumEnd", () => {
      const t = tick({ frame: 30_215 });

      expect(resolveReplayLiveTick(t, false, false)).toEqual(resolveReplayRecordTick(t, false));
      expect(resolveReplayLiveTick(t, false, false)).toEqual({ sessionNum: 2, sessionUniqueId: 4, frame: 30_215 });
    });

    it("refuses what resolveReplayRecordTick refuses", () => {
      expect(resolveReplayLiveTick(tick({ sessionNum: -1 }), false, false)).toBeNull();
      expect(resolveReplayLiveTick(tick({ frame: undefined }), false, false)).toBeNull();
    });
  });

  describe("out of the car", () => {
    it("at the live edge, the frame is the cursor plus its distance to the end of the tape", () => {
      expect(resolveReplayLiveTick(outOfCar(), true, false)).toEqual({
        sessionNum: 0,
        sessionUniqueId: 3,
        frame: 53_593,
      });
    });

    it(`counts a cursor up to ${LIVE_EDGE_MAX_FRAMES} frames from the end as at the edge, and not one further`, () => {
      expect(LIVE_EDGE_MAX_FRAMES).toBe(120);
      expect(resolveReplayLiveTick(outOfCar({ toEnd: 0 }), true, false)?.frame).toBe(53_592);
      expect(resolveReplayLiveTick(outOfCar({ toEnd: 120 }), true, false)?.frame).toBe(53_712);
      expect(resolveReplayLiveTick(outOfCar({ toEnd: 121 }), true, false)).toBeNull();
    });

    it("refuses a replay scrubbed back: not live", () => {
      // 21 s back and further, as measured (#1426).
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: 39_856, toEnd: 1_201 }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: 13_059, toEnd: 40_182 }), true, false)).toBeNull();
    });

    it("refuses a replay-only session, even at its end", () => {
      expect(resolveReplayLiveTick(outOfCar(), true, true)).toBeNull();
    });

    it("refuses a tick read mid-seek (frame 0, raw flag false), whatever ReplayFrameNumEnd says", () => {
      // The measured mid-seek reading: the whole tape's length at the end.
      expect(
        resolveReplayLiveTick(outOfCar({ cursorFrame: 0, toEnd: 204_563, sessionNum: -1, flag: false }), true, false),
      ).toBeNull();
      // And one that would pass the edge limit: the flag alone refuses it.
      expect(
        resolveReplayLiveTick(outOfCar({ cursorFrame: 0, toEnd: 1, sessionNum: -1, flag: false }), true, false),
      ).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: 0, toEnd: 1, flag: false }), true, false)).toBeNull();
    });

    it("refuses a tick inside the exit grace, where the debounced state says a replay and the flag does not", () => {
      expect(resolveReplayLiveTick(outOfCar({ flag: false }), true, false)).toBeNull();
    });

    it("refuses a tick with no session or no readable cursor or distance", () => {
      expect(resolveReplayLiveTick(outOfCar({ sessionNum: -1 }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ sessionNum: undefined }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: undefined }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: Number.NaN }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ cursorFrame: -1 }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ toEnd: undefined }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ toEnd: Number.NaN }), true, false)).toBeNull();
      expect(resolveReplayLiveTick(outOfCar({ toEnd: -1 }), true, false)).toBeNull();
    });

    it("reads SessionUniqueID 0 from a build that does not carry it", () => {
      expect(resolveReplayLiveTick(outOfCar({ uniqueId: undefined }), true, false)?.sessionUniqueId).toBe(0);
    });

    it("is never what the in-car gate answers: resolveReplayRecordTick still refuses every out-of-car tick", () => {
      expect(resolveReplayRecordTick(outOfCar(), true)).toBeNull();
    });
  });
});

describe("resolveSubSessionId", () => {
  it("reads WeekendInfo.SubSessionID", () => {
    expect(resolveSubSessionId({ WeekendInfo: { SubSessionID: 86697546 } })).toBe(86697546);
  });

  it("reads 0 when the session info, the section or the field is absent or not a finite number", () => {
    expect(resolveSubSessionId(null)).toBe(0);
    expect(resolveSubSessionId({})).toBe(0);
    expect(resolveSubSessionId({ WeekendInfo: {} })).toBe(0);
    expect(resolveSubSessionId({ WeekendInfo: { SubSessionID: "86697546" } })).toBe(0);
    expect(resolveSubSessionId({ WeekendInfo: { SubSessionID: Number.NaN } })).toBe(0);
  });
});

// Issue #1509: the translator's session identity needs absence told apart
// from an offline session's real 0.
describe("readSubSessionId", () => {
  it("reads WeekendInfo.SubSessionID, a real 0 included", () => {
    expect(readSubSessionId({ WeekendInfo: { SubSessionID: 86697546 } })).toBe(86697546);
    expect(readSubSessionId({ WeekendInfo: { SubSessionID: 0 } })).toBe(0);
  });

  it("reads null when the session info, the section or the field is absent or not a finite number", () => {
    expect(readSubSessionId(null)).toBeNull();
    expect(readSubSessionId({})).toBeNull();
    expect(readSubSessionId({ WeekendInfo: {} })).toBeNull();
    expect(readSubSessionId({ WeekendInfo: { SubSessionID: "86697546" } })).toBeNull();
    expect(readSubSessionId({ WeekendInfo: { SubSessionID: Number.NaN } })).toBeNull();
  });
});

// The point of one gate: the recorders that call it can never disagree about
// which ticks are live. Each ineligible tick below must unseed BOTH.
describe("the gate, as the two recorders apply it", () => {
  let state: TranslatorState;

  function run(telemetry: TelemetryData, inReplay: boolean): void {
    diffReplayLaps(state, telemetry, null, inReplay, () => {});
    diffReplayGreens(state, telemetry, null, inReplay, () => {});
  }

  beforeEach(() => {
    state = createInitialState();
    run(tick(), false);
  });

  it("seeds both on an eligible tick", () => {
    expect(resolveReplayRecordTick(tick(), false)).not.toBeNull();
    expect([state.replayLapsSeeded, state.replayGreensSeeded]).toEqual([true, true]);
  });

  it.each<[string, TelemetryData, boolean]>([
    ["the replay view", tick({ replay: true }), true],
    ["a seek's blip or a saved replay", tick(), true],
    ["SessionNum −1", tick({ sessionNum: -1 }), false],
    ["no readable frame", tick({ frame: undefined }), false],
  ])("unseeds both on %s, and re-seeds both on the next eligible tick", (_name, telemetry, inReplay) => {
    expect(resolveReplayRecordTick(telemetry, inReplay)).toBeNull();

    run(telemetry, inReplay);
    expect([state.replayLapsSeeded, state.replayGreensSeeded]).toEqual([false, false]);

    run(tick(), false);
    expect([state.replayLapsSeeded, state.replayGreensSeeded]).toEqual([true, true]);
  });
});
