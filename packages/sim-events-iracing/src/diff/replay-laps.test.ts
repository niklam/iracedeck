import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplayLaps, REPLAY_LAP_TIME_WAIT_TICKS } from "./replay-laps.js";
import type { PendingEvent } from "./types.js";

/** Three cars at indices 0–2 and the pace car at 3. */
const SESSION_INFO: Record<string, unknown> = {
  WeekendInfo: { SubSessionID: 86697546, SimMode: "full" },
  DriverInfo: {
    PaceCarIdx: 3,
    Drivers: [
      { CarIdx: 0, CarNumberRaw: 7, UserID: 100 },
      { CarIdx: 1, CarNumberRaw: 42, UserID: 200 },
      { CarIdx: 2, CarNumberRaw: 3042, UserID: 300 },
      { CarIdx: 3, CarNumberRaw: 0, UserID: -1, CarIsPaceCar: 1 },
    ],
  },
};

type TickOverrides = Partial<{
  completed: number[];
  lastLapTime: number[];
  frame: number | undefined;
  sessionNum: number;
  uniqueId: number;
  replay: boolean;
}>;

function tick(o: TickOverrides = {}): TelemetryData {
  return {
    CarIdxLapCompleted: o.completed ?? [4, 4, 4, -1],
    CarIdxLastLapTime: o.lastLapTime ?? [91.5, 92.5, 93.5, -1],
    ReplayFrameNumEnd: "frame" in o ? o.frame : 30_000,
    SessionNum: o.sessionNum ?? 2,
    SessionUniqueID: o.uniqueId ?? 4,
    IsReplayPlaying: o.replay ?? false,
  } as TelemetryData;
}

function run(
  state: TranslatorState,
  telemetry: TelemetryData,
  opts: { sessionInfo?: Record<string, unknown> | null; replayOnly?: boolean } = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffReplayLaps(
    state,
    telemetry,
    "sessionInfo" in opts ? (opts.sessionInfo ?? null) : SESSION_INFO,
    opts.replayOnly ?? false,
    (ev) => out.push(ev),
  );

  return out;
}

const IDENTITY = { subSessionId: 86697546, sessionNum: 2, sessionUniqueId: 4 };

describe("diffReplayLaps", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("seeds silently on the first eligible tick", () => {
    expect(run(state, tick())).toEqual([]);
    expect(state.replayLapsSeeded).toBe(true);
    expect(state.replayLapsLastCompleted).toEqual([4, 4, 4, -1]);
  });

  it("emits lap 1 for the first crossing (−1 → 0) with the tick's frame, and opens no time wait", () => {
    run(state, tick({ completed: [-1, -1, -1, -1] }));

    const events = run(state, tick({ completed: [-1, 0, -1, -1], frame: 30_821 }));

    expect(events).toEqual([
      {
        event: "replay.lapStarted",
        data: { ...IDENTITY, carIdx: 1, carNumberRaw: 42, userId: 200, lap: 1, frame: 30_821 },
      },
    ]);
    expect(state.replayLapsTimeWait[1]).toBeNull();
    // No completed lap to time — a later refresh is nobody's.
    expect(run(state, tick({ completed: [-1, 0, -1, -1], lastLapTime: [-1, 88.0, -1, -1] }))).toEqual([]);
  });

  it("emits lap n+2 for n → n+1 and then the lap time for n+1 once CarIdxLastLapTime refreshes", () => {
    run(state, tick());

    const started = run(state, tick({ completed: [5, 4, 4, -1], frame: 36_305 }));

    expect(started).toEqual([
      {
        event: "replay.lapStarted",
        data: { ...IDENTITY, carIdx: 0, carNumberRaw: 7, userId: 100, lap: 6, frame: 36_305 },
      },
    ]);

    // The refresh lags the counter by a tick or two.
    expect(run(state, tick({ completed: [5, 4, 4, -1] }))).toEqual([]);

    const timed = run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [91.433, 92.5, 93.5, -1] }));

    expect(timed).toEqual([{ event: "replay.lapTimed", data: { ...IDENTITY, carIdx: 0, lap: 5, timeMs: 91_433 } }]);
    // Emitted once: the same value on the next tick is not a second refresh.
    expect(run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [91.433, 92.5, 93.5, -1] }))).toEqual([]);
  });

  it("reads a refresh that lands on the crossing tick itself against the pre-crossing baseline", () => {
    run(state, tick());

    const events = run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [90.001, 92.5, 93.5, -1] }));

    expect(events.map((e) => e.event)).toEqual(["replay.lapStarted"]);
    // The next tick sees the time moved off the tick-before-the-crossing value.
    expect(run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [90.001, 92.5, 93.5, -1] }))).toEqual([
      { event: "replay.lapTimed", data: { ...IDENTITY, carIdx: 0, lap: 5, timeMs: 90_001 } },
    ]);
  });

  it("closes the wait with no event once the tick budget runs out", () => {
    run(state, tick());
    run(state, tick({ completed: [5, 4, 4, -1] }));

    for (let i = 0; i < REPLAY_LAP_TIME_WAIT_TICKS; i++) {
      expect(run(state, tick({ completed: [5, 4, 4, -1] }))).toEqual([]);
    }

    expect(state.replayLapsTimeWait[0]).toBeNull();
    // A refresh after the budget is not attributed to the lap.
    expect(run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [91.0, 92.5, 93.5, -1] }))).toEqual([]);
  });

  it("leaves the second of two byte-identical consecutive laps untimed", () => {
    run(state, tick({ lastLapTime: [91.5, 92.5, 93.5, -1] }));
    run(state, tick({ completed: [5, 4, 4, -1] }));

    // The sim publishes the same 91.5 again: no change, so no time.
    for (let i = 0; i < REPLAY_LAP_TIME_WAIT_TICKS; i++) {
      expect(run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [91.5, 92.5, 93.5, -1] }))).toEqual([]);
    }

    expect(state.replayLapsTimeWait[0]).toBeNull();
  });

  it("re-seeds a car silently on a jump of two, a decrease, or a drop to −1", () => {
    run(state, tick());

    expect(run(state, tick({ completed: [6, 4, 4, -1] }))).toEqual([]); // jump of two
    expect(run(state, tick({ completed: [6, 3, 4, -1] }))).toEqual([]); // decrease
    expect(run(state, tick({ completed: [6, 3, -1, -1] }))).toEqual([]); // NotInWorld
    expect(state.replayLapsLastCompleted).toEqual([6, 3, -1, -1]);
    // −1 → a positive number is not the first crossing either.
    expect(run(state, tick({ completed: [6, 3, 4, -1] }))).toEqual([]);
    // From the new baselines an ordinary crossing counts again.
    expect(run(state, tick({ completed: [7, 3, 4, -1] })).map((e) => e.data)).toEqual([
      { ...IDENTITY, carIdx: 0, carNumberRaw: 7, userId: 100, lap: 8, frame: 30_000 },
    ]);
  });

  it("drops an open lap-time wait when the car re-seeds", () => {
    run(state, tick());
    run(state, tick({ completed: [5, 4, 4, -1] }));
    expect(state.replayLapsTimeWait[0]).not.toBeNull();

    run(state, tick({ completed: [8, 4, 4, -1] })); // towed

    expect(state.replayLapsTimeWait[0]).toBeNull();
    expect(run(state, tick({ completed: [8, 4, 4, -1], lastLapTime: [91.0, 92.5, 93.5, -1] }))).toEqual([]);
  });

  it("skips the pace car", () => {
    run(state, tick());

    expect(run(state, tick({ completed: [4, 4, 4, 0] }))).toEqual([]);
    expect(run(state, tick({ completed: [4, 4, 4, 1] }))).toEqual([]);
  });

  it("skips a car the session YAML does not name — the record could never verify it", () => {
    const roster = { ...SESSION_INFO, DriverInfo: { Drivers: [{ CarIdx: 0, CarNumberRaw: 7, UserID: 100 }] } };
    run(state, tick(), { sessionInfo: roster });

    expect(run(state, tick({ completed: [4, 5, 4, -1] }), { sessionInfo: roster })).toEqual([]);
    expect(state.replayLapsTimeWait[1]).toBeNull();
    expect(run(state, tick({ completed: [5, 5, 4, -1] }), { sessionInfo: roster })).toHaveLength(1);
  });

  it("reads subSessionId 0 and userId 0 when the session info does not carry them", () => {
    const offline = { DriverInfo: { Drivers: [{ CarIdx: 0, CarNumberRaw: 7 }] } };
    run(state, tick(), { sessionInfo: offline });

    expect(run(state, tick({ completed: [5, 4, 4, -1] }), { sessionInfo: offline }).map((e) => e.data)).toEqual([
      {
        subSessionId: 0,
        sessionNum: 2,
        sessionUniqueId: 4,
        carIdx: 0,
        carNumberRaw: 7,
        userId: 0,
        lap: 6,
        frame: 30_000,
      },
    ]);
  });

  describe("the gate", () => {
    it("unseeds on a replay-view tick and re-seeds silently on the first live tick after it", () => {
      run(state, tick());

      expect(run(state, tick({ completed: [5, 4, 4, -1], replay: true }))).toEqual([]);
      expect(state.replayLapsSeeded).toBe(false);
      // The field crossed while the replay was up — no fabricated crossing.
      expect(run(state, tick({ completed: [5, 5, 5, -1] }))).toEqual([]);
      expect(state.replayLapsSeeded).toBe(true);
      // The next real crossing counts.
      expect(run(state, tick({ completed: [6, 5, 5, -1] })).map((e) => e.data)).toEqual([
        { ...IDENTITY, carIdx: 0, carNumberRaw: 7, userId: 100, lap: 7, frame: 30_000 },
      ]);
    });

    it("unseeds in a replay-only session (SimMode replay)", () => {
      run(state, tick());

      expect(run(state, tick({ completed: [5, 4, 4, -1] }), { replayOnly: true })).toEqual([]);
      expect(state.replayLapsSeeded).toBe(false);
      expect(run(state, tick({ completed: [5, 4, 4, -1] }))).toEqual([]);
    });

    it("unseeds while SessionNum is negative or no frame is readable", () => {
      run(state, tick());

      expect(run(state, tick({ completed: [5, 4, 4, -1], sessionNum: -1 }))).toEqual([]);
      expect(state.replayLapsSeeded).toBe(false);
      run(state, tick({ completed: [5, 4, 4, -1] }));
      expect(state.replayLapsSeeded).toBe(true);

      expect(run(state, tick({ completed: [6, 4, 4, -1], frame: undefined }))).toEqual([]);
      expect(state.replayLapsSeeded).toBe(false);
    });

    it("drops an open lap-time wait with the rest of the baselines", () => {
      run(state, tick());
      run(state, tick({ completed: [5, 4, 4, -1] }));
      run(state, tick({ completed: [5, 4, 4, -1], replay: true }));
      run(state, tick({ completed: [5, 4, 4, -1] }));

      expect(run(state, tick({ completed: [5, 4, 4, -1], lastLapTime: [91.0, 92.5, 93.5, -1] }))).toEqual([]);
    });
  });

  describe("session change", () => {
    it("re-seeds on a SessionNum change and stamps the new identity on later events", () => {
      run(state, tick());

      expect(run(state, tick({ completed: [0, 0, 0, -1], sessionNum: 3 }))).toEqual([]);
      expect(run(state, tick({ completed: [1, 0, 0, -1], sessionNum: 3 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, sessionNum: 3, carIdx: 0, carNumberRaw: 7, userId: 100, lap: 2, frame: 30_000 },
      ]);
    });

    it("re-seeds on a SessionUniqueID change — a restart is the same SessionNum under a new id", () => {
      run(state, tick());
      run(state, tick({ completed: [5, 4, 4, -1] })); // opens a wait for car 0

      expect(run(state, tick({ completed: [0, 0, 0, -1], uniqueId: 5 }))).toEqual([]);
      expect(state.replayLapsTimeWait).toEqual([]);
      expect(run(state, tick({ completed: [0, 1, 0, -1], uniqueId: 5 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, sessionUniqueId: 5, carIdx: 1, carNumberRaw: 42, userId: 200, lap: 2, frame: 30_000 },
      ]);
    });
  });
});
