import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplayIncidents } from "./replay-incidents.js";
import type { PendingEvent } from "./types.js";

type Row = Record<string, unknown>;

/**
 * The player in car 0 (#7); two opponents, cars 1 (#42) and 2 (#3042); the
 * pace car in 3 and a spectator in 4. `counts` are each row's
 * `CurDriverIncidentCount`, by carIdx.
 */
function sessionInfo(counts: Array<number | undefined>, o: { driverCarIdx?: number | null } = {}): Row {
  const rows: Row[] = [
    { CarIdx: 0, CarNumberRaw: 7 },
    { CarIdx: 1, CarNumberRaw: 42 },
    { CarIdx: 2, CarNumberRaw: 3042 },
    { CarIdx: 3, CarNumberRaw: 0, CarIsPaceCar: 1 },
    { CarIdx: 4, CarNumberRaw: 99, IsSpectator: 1 },
  ];

  return {
    WeekendInfo: { SubSessionID: 86697546, SimMode: "full" },
    DriverInfo: {
      ...(o.driverCarIdx === null ? {} : { DriverCarIdx: o.driverCarIdx ?? 0 }),
      Drivers: rows.map((row, carIdx) =>
        counts[carIdx] === undefined ? row : { ...row, CurDriverIncidentCount: counts[carIdx] },
      ),
    },
  };
}

type TickOverrides = Partial<{
  player: number | undefined;
  frame: number;
  time: number;
  sessionNum: number;
  uniqueId: number;
  playerCarIdx: number;
}>;

function tick(o: TickOverrides = {}): TelemetryData {
  return {
    PlayerCarMyIncidentCount: "player" in o ? o.player : 0,
    PlayerCarIdx: o.playerCarIdx ?? 0,
    ReplayFrameNumEnd: o.frame ?? 30_000,
    SessionTime: o.time ?? 500,
    SessionNum: o.sessionNum ?? 2,
    SessionUniqueID: o.uniqueId ?? 4,
    IsReplayPlaying: false,
  } as TelemetryData;
}

const IDENTITY = { subSessionId: 86697546, sessionNum: 2, sessionUniqueId: 4 };

function incident(
  carIdx: number,
  carNumberRaw: number,
  delta: number,
  source: "telemetry" | "sessionInfo",
  frame = 30_000,
  sessionTimeMs = 500_000,
): PendingEvent {
  return {
    event: "replay.incident",
    data: { ...IDENTITY, carIdx, carNumberRaw, frame, sessionTimeMs, delta, source },
  };
}

describe("diffReplayIncidents", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  function run(telemetry: TelemetryData, info: Row | null = sessionInfo([0, 0, 0]), inReplay = false): PendingEvent[] {
    const out: PendingEvent[] = [];

    diffReplayIncidents(state, telemetry, info, inReplay, (ev) => out.push(ev));

    return out;
  }

  describe("the driver's own car", () => {
    it("seeds on the first eligible tick without emitting, whatever the count", () => {
      expect(run(tick({ player: 6 }))).toEqual([]);
      expect(run(tick({ player: 6 }))).toEqual([]);
    });

    it("publishes a rise with that tick's frame, session time and delta", () => {
      run(tick({ player: 2 }));

      expect(run(tick({ player: 4, frame: 41_007, time: 690.1234 }))).toEqual([
        incident(0, 7, 2, "telemetry", 41_007, 690_123),
      ]);
      expect(run(tick({ player: 4 }))).toEqual([]);
      expect(run(tick({ player: 5, frame: 41_100 }))).toEqual([incident(0, 7, 1, "telemetry", 41_100)]);
    });

    it("publishes each rise of a burst on its own tick: the store folds them", () => {
      run(tick({ player: 0 }));

      expect([...run(tick({ player: 1, frame: 100 })), ...run(tick({ player: 3, frame: 101 }))]).toEqual([
        incident(0, 7, 1, "telemetry", 100),
        incident(0, 7, 2, "telemetry", 101),
      ]);
    });

    it("re-seeds silently on a decrease", () => {
      run(tick({ player: 8 }));

      expect(run(tick({ player: 0 }))).toEqual([]);
      expect(run(tick({ player: 2 }))).toEqual([incident(0, 7, 2, "telemetry")]);
    });

    it("re-seeds after an ineligible window: a rise behind the replay view is absent, the next one is recorded", () => {
      run(tick({ player: 2 }));
      // The garage or the replay view, a seek's blip, then no session.
      expect(run(tick({ player: 2 }), undefined, true)).toEqual([]);
      expect(run(tick({ player: 4, sessionNum: -1 }))).toEqual([]);
      expect(run(tick({ player: 4 }))).toEqual([]);
      expect(run(tick({ player: 5 }))).toEqual([incident(0, 7, 1, "telemetry")]);
    });

    it("re-seeds on a session change", () => {
      run(tick({ player: 3 }));

      expect(run(tick({ player: 5, sessionNum: 3 }))).toEqual([]);
      expect(run(tick({ player: 5, uniqueId: 9, sessionNum: 3 }))).toEqual([]);
    });

    it("has no baseline on a tick that carries no count", () => {
      run(tick({ player: 3 }));

      expect(run(tick({ player: undefined }))).toEqual([]);
      expect(run(tick({ player: 5 }))).toEqual([]);
      expect(run(tick({ player: 6 }))).toEqual([incident(0, 7, 1, "telemetry")]);
    });

    it("takes the car from PlayerCarIdx when the session info names none", () => {
      run(tick({ player: 0, playerCarIdx: 1 }), sessionInfo([0, 0, 0], { driverCarIdx: null }));

      expect(run(tick({ player: 1, playerCarIdx: 1 }), sessionInfo([0, 0, 0], { driverCarIdx: null }))).toEqual([
        incident(1, 42, 1, "telemetry"),
      ]);
    });

    it("publishes nothing for a car the roster cannot name, and keeps the baseline moving", () => {
      run(tick({ player: 0 }), null);

      expect(run(tick({ player: 2 }), null)).toEqual([]);
      expect(run(tick({ player: 3 }))).toEqual([incident(0, 7, 1, "telemetry")]);
    });
  });

  describe("other cars, from the session info", () => {
    it("seeds on the first eligible tick without emitting", () => {
      expect(run(tick(), sessionInfo([0, 4, 9]))).toEqual([]);
    });

    it("publishes a rise from a non-negative baseline", () => {
      run(tick(), sessionInfo([0, 4, 9]));

      expect(run(tick({ frame: 52_000 }), sessionInfo([0, 6, 9]))).toEqual([
        incident(1, 42, 2, "sessionInfo", 52_000),
      ]);
      expect(run(tick(), sessionInfo([0, 6, 10]))).toEqual([incident(2, 3042, 1, "sessionInfo")]);
    });

    it("takes −1 as no baseline: the reveal after an official race re-seeds silently", () => {
      run(tick(), sessionInfo([0, -1, -1]));

      expect(run(tick(), sessionInfo([0, -1, -1]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 4, 12]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 6, 12]))).toEqual([incident(1, 42, 2, "sessionInfo")]);
    });

    it("re-seeds when a count goes back to −1", () => {
      run(tick(), sessionInfo([0, 4, 0]));

      expect(run(tick(), sessionInfo([0, -1, 0]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 6, 0]))).toEqual([]);
    });

    it("re-seeds silently on a decrease (a driver swap)", () => {
      run(tick(), sessionInfo([0, 9, 0]));

      expect(run(tick(), sessionInfo([0, 2, 0]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 3, 0]))).toEqual([incident(1, 42, 1, "sessionInfo")]);
    });

    it("seeds a car the roster had not held silently", () => {
      run(tick(), sessionInfo([0, 0]));

      expect(run(tick(), sessionInfo([0, 0, 5]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 0, 6]))).toEqual([incident(2, 3042, 1, "sessionInfo")]);
    });

    it("does not publish the driver twice: the driver's own row is skipped", () => {
      run(tick({ player: 0 }), sessionInfo([0, 0, 0]));

      // The rise shows in the counter and, in the same tick, in the roster.
      expect(run(tick({ player: 4 }), sessionInfo([4, 0, 0]))).toEqual([incident(0, 7, 4, "telemetry")]);
      // A roster rise of the driver's row alone publishes nothing.
      expect(run(tick({ player: 4 }), sessionInfo([8, 0, 0]))).toEqual([]);
    });

    it("skips the pace car and spectator rows", () => {
      run(tick(), sessionInfo([0, 0, 0, 0, 0]));

      expect(run(tick(), sessionInfo([0, 0, 0, 3, 3]))).toEqual([]);
    });

    it("re-seeds after an ineligible window", () => {
      run(tick(), sessionInfo([0, 4, 0]));

      expect(run(tick(), sessionInfo([0, 6, 0]), true)).toEqual([]);
      expect(run(tick(), sessionInfo([0, 8, 0]))).toEqual([]);
      expect(run(tick(), sessionInfo([0, 9, 0]))).toEqual([incident(1, 42, 1, "sessionInfo")]);
    });

    it("publishes the driver and other cars on one tick, the driver first", () => {
      run(tick({ player: 0 }), sessionInfo([0, 0, 0]));

      expect(run(tick({ player: 2 }), sessionInfo([2, 4, 1]))).toEqual([
        incident(0, 7, 2, "telemetry"),
        incident(1, 42, 4, "sessionInfo"),
        incident(2, 3042, 1, "sessionInfo"),
      ]);
    });
  });

  it("reads SessionTime 0 on a tick that carries none", () => {
    run(tick({ player: 0 }));
    const t = { ...tick({ player: 1 }), SessionTime: undefined } as TelemetryData;

    expect(run(t)).toEqual([incident(0, 7, 1, "telemetry", 30_000, 0)]);
  });
});
