import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplayGreens } from "./replay-greens.js";
import { diffReplayLaps } from "./replay-laps.js";
import { resolveReplayRecordTick, resolveSubSessionId } from "./replay-record-gate.js";

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
