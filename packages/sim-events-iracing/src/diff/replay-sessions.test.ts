import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplaySessions, SESSION_START_AGREEMENT_FRAMES } from "./replay-sessions.js";
import type { PendingEvent } from "./types.js";

const SESSION_INFO: Record<string, unknown> = { WeekendInfo: { SubSessionID: 86697546, SimMode: "full" } };

type Where = "car" | "edge";

type TickOverrides = Partial<{
  /** The live frame: `ReplayFrameNumEnd` in the car, cursor plus distance at the edge. */
  frame: number;
  /** Session seconds. */
  time: number | undefined;
  sessionNum: number;
  uniqueId: number;
  /** Out of the car: how far the cursor sits from the end of the tape. */
  toEnd: number;
}>;

/** A tick in the car: the live frame is `ReplayFrameNumEnd` and the replay flag is down. */
function inCar(o: TickOverrides = {}): TelemetryData {
  return {
    ReplayFrameNum: 0,
    ReplayFrameNumEnd: o.frame ?? 36_000,
    SessionTime: "time" in o ? o.time : 600,
    SessionNum: o.sessionNum ?? 2,
    SessionUniqueID: o.uniqueId ?? 4,
    IsReplayPlaying: false,
  } as TelemetryData;
}

/** A tick out of the car in the in-session replay; at the live edge unless `toEnd` says otherwise. */
function outOfCar(o: TickOverrides = {}): TelemetryData {
  const toEnd = o.toEnd ?? 1;
  const frame = o.frame ?? 36_000;

  return {
    ReplayFrameNum: frame - toEnd,
    ReplayFrameNumEnd: toEnd,
    SessionTime: "time" in o ? o.time : 600,
    SessionNum: o.sessionNum ?? 2,
    SessionUniqueID: o.uniqueId ?? 4,
    IsReplayPlaying: true,
  } as TelemetryData;
}

/** A tick read during a slow seek, as measured: frame 0, session −1, the flag down. */
const MID_SEEK = {
  ReplayFrameNum: 0,
  ReplayFrameNumEnd: 204_563,
  SessionTime: 600,
  SessionNum: -1,
  SessionUniqueID: 4,
  IsReplayPlaying: false,
} as TelemetryData;

function at(where: Where, o: TickOverrides = {}): TelemetryData {
  return where === "car" ? inCar(o) : outOfCar(o);
}

function run(
  state: TranslatorState,
  telemetry: TelemetryData,
  opts: {
    inReplay?: boolean;
    replayOnly?: boolean;
    logger?: ILogger;
    sessionInfo?: Record<string, unknown> | null;
  } = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  // Out of the car the debounced replay state reads a replay; in the car it does not.
  diffReplaySessions(
    state,
    telemetry,
    "sessionInfo" in opts ? (opts.sessionInfo ?? null) : SESSION_INFO,
    opts.inReplay ?? (telemetry.IsReplayPlaying === true || telemetry.SessionNum === -1),
    opts.replayOnly ?? false,
    (ev) => out.push(ev),
    opts.logger ?? silentLogger,
  );

  return out;
}

function started(frame: number, sessionNum = 2, sessionUniqueId = 4): PendingEvent {
  return {
    event: "replay.sessionStarted",
    data: { subSessionId: 86697546, sessionNum, sessionUniqueId, frame },
  };
}

/** Two consecutive ticks of one pair, 1/60 s apart, from `frame` / `time`. */
function twoTicks(where: Where, o: TickOverrides & { frame: number; time: number }): TelemetryData[] {
  return [at(where, o), at(where, { ...o, frame: o.frame + 1, time: o.time + 1 / 60 })];
}

describe("diffReplaySessions", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  function feed(ticks: TelemetryData[], opts?: Parameters<typeof run>[2]): PendingEvent[] {
    return ticks.flatMap((t) => run(state, t, opts));
  }

  describe.each<Where>(["car", "edge"])("first seen on its change tick (%s)", (where) => {
    it("publishes one start, at the live frame, once a second tick agrees", () => {
      const [first, second] = twoTicks(where, { frame: 120_000, time: 0.0167 });

      expect(run(state, first)).toEqual([]);
      // round(0.0167 × 60) = 1, so the start is the frame before the change tick's.
      expect(run(state, second)).toEqual([started(119_999)]);
    });

    it("first seen ten minutes in, publishes the same frame", () => {
      expect(feed(twoTicks(where, { frame: 156_000, time: 600 }))).toEqual([started(120_000)]);
    });

    it("publishes 0 for a session that began before the tape did", () => {
      expect(feed(twoTicks(where, { frame: 912, time: 58.283 }))).toEqual([started(0)]);
    });
  });

  it("publishes the in-car and the out-of-car reading of one session as one start", () => {
    // Out of the car on the change tick, back in the car on the next.
    const out = feed([outOfCar({ frame: 120_000, time: 0 }), inCar({ frame: 120_001, time: 1 / 60 })]);

    expect(out).toEqual([started(120_000)]);
  });

  it("publishes nothing on a tick whose clock disagrees with the next, until two agree", () => {
    // The session number has moved on this tick and the clock has not: the
    // old session's 900 s puts the start 54000 frames too early.
    expect(run(state, inCar({ frame: 120_000, time: 900, sessionNum: 3 }))).toEqual([]);
    expect(run(state, inCar({ frame: 120_001, time: 1 / 60, sessionNum: 3 }))).toEqual([]);
    expect(run(state, inCar({ frame: 120_002, time: 2 / 60, sessionNum: 3 }))).toEqual([started(120_000, 3)]);
  });

  it(`takes two readings within ${SESSION_START_AGREEMENT_FRAMES} frames as agreeing, and not one further`, () => {
    expect(SESSION_START_AGREEMENT_FRAMES).toBe(2);
    expect(feed([inCar({ frame: 36_000, time: 0 }), inCar({ frame: 36_002, time: 0 })])).toEqual([started(36_002)]);

    state = createInitialState();
    expect(feed([inCar({ frame: 36_000, time: 0 }), inCar({ frame: 36_003, time: 0 })])).toEqual([]);
  });

  it("publishes the second reading's start", () => {
    expect(feed([inCar({ frame: 36_000, time: 0 }), inCar({ frame: 36_001, time: 0 })])).toEqual([started(36_001)]);
  });

  it("breaks the run on an ineligible tick: the two readings either side of it do not agree with each other", () => {
    expect(run(state, inCar({ frame: 36_000, time: 0 }))).toEqual([]);
    expect(run(state, MID_SEEK, { inReplay: true })).toEqual([]);
    expect(run(state, inCar({ frame: 36_001, time: 1 / 60 }))).toEqual([]);
    // The run starts again from the tick after the seek.
    expect(run(state, inCar({ frame: 36_002, time: 2 / 60 }))).toEqual([started(36_000)]);
  });

  it("breaks the run on a tick with no readable SessionTime", () => {
    expect(run(state, inCar({ frame: 36_000, time: 0 }))).toEqual([]);
    expect(run(state, inCar({ frame: 36_001, time: undefined }))).toEqual([]);
    expect(run(state, inCar({ frame: 36_002, time: 2 / 60 }))).toEqual([]);
    expect(run(state, inCar({ frame: 36_003, time: 3 / 60 }))).toEqual([started(36_000)]);
  });

  it("does not let a reading of one pair agree with a reading of another", () => {
    expect(run(state, inCar({ frame: 36_000, time: 0, sessionNum: 2 }))).toEqual([]);
    expect(run(state, inCar({ frame: 36_001, time: 1 / 60, sessionNum: 3 }))).toEqual([]);
  });

  it("never reads a tick mid-seek, whatever its numbers say", () => {
    // Even two of them in a row, which would agree with each other.
    expect(feed([MID_SEEK, MID_SEEK], { inReplay: true })).toEqual([]);
    // A seek's tick with the flag down and the session still readable is refused too.
    const blip = { ...outOfCar({ frame: 36_000, time: 0 }), IsReplayPlaying: false } as TelemetryData;
    expect(feed([blip, blip], { inReplay: true })).toEqual([]);
  });

  it("publishes nothing from a replay scrubbed back across a session boundary, and the start once back at the edge", () => {
    // In the race, out of the car, scrubbed back into qualifying: whatever
    // SessionNum reads there (it may follow the cursor), the tick is not live.
    const scrubbed = [
      outOfCar({ frame: 400_000, time: 3000, sessionNum: 1, uniqueId: 3, toEnd: 150_000 }),
      outOfCar({ frame: 400_001, time: 3000 + 1 / 60, sessionNum: 1, uniqueId: 3, toEnd: 150_001 }),
      outOfCar({ frame: 400_002, time: 3000 + 2 / 60, sessionNum: 2, uniqueId: 4, toEnd: 150_002 }),
      outOfCar({ frame: 400_003, time: 3000 + 3 / 60, sessionNum: 2, uniqueId: 4, toEnd: 150_003 }),
    ];

    expect(feed(scrubbed)).toEqual([]);
    // Back at the live edge of the race: its start, at the frame the race began.
    expect(feed(twoTicks("edge", { frame: 420_000, time: 3000 }))).toEqual([started(240_000)]);
  });

  it("publishes nothing in a replay-only session", () => {
    expect(feed(twoTicks("edge", { frame: 36_000, time: 0 }), { replayOnly: true })).toEqual([]);
  });

  it("does not publish a pair again", () => {
    expect(feed(twoTicks("car", { frame: 36_000, time: 0 }))).toEqual([started(36_000)]);
    expect(feed(twoTicks("car", { frame: 36_100, time: 100 / 60 }))).toEqual([]);
    // Across a trip to the garage, a seek, and a later reading that disagrees.
    expect(feed([MID_SEEK], { inReplay: true })).toEqual([]);
    expect(feed(twoTicks("edge", { frame: 72_000, time: 600 }))).toEqual([]);
    expect(feed(twoTicks("car", { frame: 90_000, time: 100 }))).toEqual([]);
    expect(state.replaySessionsPublished).toEqual(["2:4"]);
  });

  it("publishes a restarted event's second instance of a session number, later on the tape", () => {
    // An offline AI event restarted: the race (SessionNum 2) again, under a new SessionUniqueID.
    expect(feed(twoTicks("car", { frame: 36_000, time: 0, uniqueId: 4 }))).toEqual([started(36_000, 2, 4)]);
    expect(feed(twoTicks("car", { frame: 180_000, time: 0, uniqueId: 7 }))).toEqual([started(180_000, 2, 7)]);
  });

  it("publishes each session of an event in turn", () => {
    const out = [
      ...feed(twoTicks("car", { frame: 0, time: 0, sessionNum: 0, uniqueId: 1 })),
      ...feed(twoTicks("edge", { frame: 72_000, time: 0, sessionNum: 1, uniqueId: 2 })),
      ...feed(twoTicks("car", { frame: 144_000, time: 0, sessionNum: 2, uniqueId: 3 })),
    ];

    expect(out).toEqual([started(0, 0, 1), started(72_000, 1, 2), started(144_000, 2, 3)]);
  });

  it("reads SubSessionID 0 when the session info has none", () => {
    const out = feed(twoTicks("car", { frame: 36_000, time: 0 }), { sessionInfo: null });

    expect(out).toEqual([
      { event: "replay.sessionStarted", data: { subSessionId: 0, sessionNum: 2, sessionUniqueId: 4, frame: 36_000 } },
    ]);
  });

  it("logs the publish at debug, with the tick's frame and SessionTime", () => {
    const logger = { debug: vi.fn() } as unknown as ILogger;

    feed(twoTicks("edge", { frame: 156_000, time: 600 }), { logger });

    expect(vi.mocked(logger.debug).mock.calls.map((c) => c[0])).toEqual([
      "Replay session start: frame=120000 (tick frame=156001 sessionTime=600.017 inCar=false) " +
        "SessionNum=2 SessionUniqueID=4",
    ]);
  });
});
