import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffReplayGreens } from "./replay-greens.js";
import type { PendingEvent } from "./types.js";

/** A practice, a qualifying and a race session, the race at `SessionNum` 2. */
const SESSION_INFO: Record<string, unknown> = {
  WeekendInfo: { SubSessionID: 86697546, SimMode: "full" },
  SessionInfo: {
    Sessions: [{ SessionType: "Practice" }, { SessionType: "Lone Qualify" }, { SessionType: "Race" }],
  },
};

// `SessionFlags` values lifted from the 2026-09-17 capture (see `caution.test.ts`).
const RACING = 0x10040000; // Servicible | StartHidden — green-flag running
const WAVING = 0x10048000; // + CautionWaving
const STATIC = 0x10044000; // + Caution
const ONE_TO_GO = 0x10044200; // + OneLapToGreen
const RESTART = 0x80040004 | 0; // Green | Servicible | StartGo — StartGo is the sign bit
/** A green rising with `Caution` still set: the yellow-checkered tick. */
const GREEN_UNDER_CAUTION = STATIC | Flags.Green;
/** A green flying with no start bit and no caution bit. */
const PLAIN_GREEN = RACING | Flags.Green;

type TickOverrides = Partial<{
  state: SessionState | undefined;
  flags: number;
  frame: number | undefined;
  time: number | undefined;
  sessionNum: number;
  uniqueId: number;
  replay: boolean;
}>;

function tick(o: TickOverrides = {}): TelemetryData {
  return {
    SessionState: "state" in o ? o.state : SessionState.Racing,
    SessionFlags: o.flags ?? RACING,
    ReplayFrameNumEnd: "frame" in o ? o.frame : 30_000,
    SessionTime: "time" in o ? o.time : 500,
    SessionNum: o.sessionNum ?? 2,
    SessionUniqueID: o.uniqueId ?? 4,
    IsReplayPlaying: o.replay ?? false,
  } as TelemetryData;
}

function run(
  state: TranslatorState,
  telemetry: TelemetryData,
  opts: { sessionInfo?: Record<string, unknown> | null; inReplay?: boolean; logger?: ILogger } = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  // `inReplay` is the translator's read of the controller's debounced replay
  // state (#1324), which the diff takes as given; the tick's own
  // `IsReplayPlaying` only decides which frame `resolveReplayFrame` reads.
  diffReplayGreens(
    state,
    telemetry,
    "sessionInfo" in opts ? (opts.sessionInfo ?? null) : SESSION_INFO,
    opts.inReplay ?? telemetry.IsReplayPlaying === true,
    (ev) => out.push(ev),
    opts.logger,
  );

  return out;
}

const IDENTITY = { subSessionId: 86697546, sessionNum: 2, sessionUniqueId: 4 };

function green(kind: "start" | "restart", frame: number, sessionTimeMs: number): PendingEvent {
  return { event: "replay.greenFlag", data: { ...IDENTITY, kind, frame, sessionTimeMs } };
}

describe("diffReplayGreens", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("seeds silently on the first eligible tick, even one already in Racing", () => {
    expect(run(state, tick())).toEqual([]);
    expect(state.replayGreensSeeded).toBe(true);
    expect(state.replayGreensLastSessionState).toBe(SessionState.Racing);
    // …and the tick after it is not an edge either.
    expect(run(state, tick())).toEqual([]);
  });

  describe("the race start", () => {
    it("emits one start for Warmup → Racing (a standing start), with the tick's frame and session time", () => {
      run(state, tick({ state: SessionState.Warmup, frame: 30_100, time: 510 }));

      expect(run(state, tick({ frame: 30_215, time: 512.433 }))).toEqual([green("start", 30_215, 512_433)]);
      // Once: the race staying in Racing is not a second start.
      expect(run(state, tick({ frame: 30_216, time: 512.45 }))).toEqual([]);
    });

    it("emits one start for ParadeLaps → Racing (a rolling start)", () => {
      run(state, tick({ state: SessionState.GetInCar }));
      expect(run(state, tick({ state: SessionState.Warmup }))).toEqual([]);
      expect(run(state, tick({ state: SessionState.ParadeLaps }))).toEqual([]);

      expect(run(state, tick({ frame: 41_007, time: 690.1 }))).toEqual([green("start", 41_007, 690_100)]);
    });

    it("emits a start straight from GetInCar", () => {
      run(state, tick({ state: SessionState.GetInCar }));

      expect(run(state, tick({ frame: 100, time: 1.5 }))).toEqual([green("start", 100, 1_500)]);
    });

    it("needs no flag bit: the edge is the state's, whatever SessionFlags reads on the flip", () => {
      run(state, tick({ state: SessionState.ParadeLaps, flags: RACING }));

      // No StartGo and no Green yet — the bit trails the flip by a tick.
      expect(run(state, tick({ flags: RACING })).map((e) => e.data)).toEqual([
        { ...IDENTITY, kind: "start", frame: 30_000, sessionTimeMs: 500_000 },
      ]);
      // The bit arriving a tick later is not a second edge.
      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
    });

    it("emits nothing for Invalid → Racing — a reconnect or a session-YAML reload mid-race", () => {
      run(state, tick({ state: SessionState.Invalid }));

      expect(run(state, tick())).toEqual([]);
    });

    it("emits nothing when Invalid sits between the pre-green state and Racing", () => {
      run(state, tick({ state: SessionState.Warmup }));
      run(state, tick({ state: SessionState.Invalid }));

      expect(run(state, tick())).toEqual([]);
    });

    it("holds a tick with no SessionState as Invalid", () => {
      run(state, tick({ state: SessionState.Warmup }));
      run(state, tick({ state: undefined }));

      expect(state.replayGreensLastSessionState).toBe(SessionState.Invalid);
      expect(run(state, tick())).toEqual([]);
    });

    it("emits nothing for Checkered or CoolDown → Racing", () => {
      run(state, tick({ state: SessionState.Checkered }));
      expect(run(state, tick())).toEqual([]);

      run(state, tick({ state: SessionState.CoolDown }));
      expect(run(state, tick())).toEqual([]);
    });

    it("emits a second start when the race re-enters ParadeLaps and goes green again (a re-grid)", () => {
      run(state, tick({ state: SessionState.ParadeLaps }));
      expect(run(state, tick({ frame: 41_000, time: 690 }))).toEqual([green("start", 41_000, 690_000)]);

      run(state, tick({ state: SessionState.ParadeLaps }));
      expect(run(state, tick({ frame: 52_400, time: 880 }))).toEqual([green("start", 52_400, 880_000)]);
    });

    it("emits nothing for a practice or a qualifying session going Racing", () => {
      for (const sessionNum of [0, 1]) {
        run(state, tick({ state: SessionState.GetInCar, sessionNum }));

        expect(run(state, tick({ sessionNum }))).toEqual([]);
      }
    });

    it('emits nothing for a session iRacing calls Warmup — the strict reading: only "Race" is a race', () => {
      // The permissive session-start classifier counts anything that is not
      // practice, testing or qualifying as a race, a warmup included. This
      // record reads `SessionType === "Race"`, as `handleTick`'s own
      // `isRaceSession` does.
      const withWarmup = {
        WeekendInfo: { SubSessionID: 86697546 },
        SessionInfo: { Sessions: [{ SessionType: "Warmup" }, { SessionType: "Race" }] },
      };
      run(state, tick({ state: SessionState.Warmup, sessionNum: 0 }), { sessionInfo: withWarmup });

      expect(run(state, tick({ sessionNum: 0 }), { sessionInfo: withWarmup })).toEqual([]);

      // A caution restart there is not recorded either.
      run(state, tick({ sessionNum: 0, flags: STATIC }), { sessionInfo: withWarmup });
      expect(run(state, tick({ sessionNum: 0, flags: RESTART }), { sessionInfo: withWarmup })).toEqual([]);

      // The positive control: the same steps in the race session beside it.
      run(state, tick({ state: SessionState.Warmup, sessionNum: 1 }), { sessionInfo: withWarmup });
      expect(run(state, tick({ sessionNum: 1 }), { sessionInfo: withWarmup })).toHaveLength(1);
    });

    it("emits nothing while the session type is unknown — no session info, or one that does not list the session", () => {
      run(state, tick({ state: SessionState.Warmup }), { sessionInfo: null });
      expect(run(state, tick(), { sessionInfo: null })).toEqual([]);

      run(state, tick({ state: SessionState.Warmup }), { sessionInfo: { WeekendInfo: {} } });
      expect(run(state, tick(), { sessionInfo: { WeekendInfo: {} } })).toEqual([]);
    });

    it("reads subSessionId 0 when the session info does not carry one (an offline session)", () => {
      const offline = { SessionInfo: { Sessions: [{ SessionType: "Race" }] } };
      run(state, tick({ state: SessionState.Warmup, sessionNum: 0 }), { sessionInfo: offline });

      expect(run(state, tick({ sessionNum: 0 }), { sessionInfo: offline }).map((e) => e.data)).toEqual([
        { subSessionId: 0, sessionNum: 0, sessionUniqueId: 4, kind: "start", frame: 30_000, sessionTimeMs: 500_000 },
      ]);
    });

    it("records session time 0 for a tick that carries none, rather than dropping the green", () => {
      run(state, tick({ state: SessionState.Warmup }));

      expect(run(state, tick({ time: undefined, frame: 30_215 }))).toEqual([green("start", 30_215, 0)]);
    });
  });

  describe("a restart", () => {
    /** Green-flag running, then a caution thrown and picked up: the latch is set. */
    function throwCaution(): void {
      run(state, tick({ flags: RACING }));
      expect(run(state, tick({ flags: WAVING }))).toEqual([]);
      expect(run(state, tick({ flags: STATIC }))).toEqual([]);
      expect(run(state, tick({ flags: ONE_TO_GO }))).toEqual([]);
    }

    it("emits one restart when the green rises on the tick both caution bits drop", () => {
      throwCaution();

      expect(run(state, tick({ flags: RESTART, frame: 71_904, time: 1199.87 }))).toEqual([
        green("restart", 71_904, 1_199_870),
      ]);
      // The green staying up, and then dropping, is nothing more.
      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
      expect(run(state, tick({ flags: RACING }))).toEqual([]);
    });

    it("emits one restart per caution", () => {
      throwCaution();
      expect(run(state, tick({ flags: RESTART, frame: 40_000 }))).toHaveLength(1);
      run(state, tick({ flags: RACING }));

      expect(run(state, tick({ flags: WAVING }))).toEqual([]);
      expect(run(state, tick({ flags: STATIC }))).toEqual([]);
      expect(run(state, tick({ flags: RESTART, frame: 60_000 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, kind: "restart", frame: 60_000, sessionTimeMs: 500_000 },
      ]);
    });

    it("counts a caution that only ever waved", () => {
      run(state, tick({ flags: RACING }));
      run(state, tick({ flags: WAVING }));

      expect(run(state, tick({ flags: PLAIN_GREEN }))).toHaveLength(1);
    });

    it("emits nothing for a green rising with Caution still set (yellow-checkered), nor when the bit then drops", () => {
      throwCaution();

      expect(run(state, tick({ flags: GREEN_UNDER_CAUTION }))).toEqual([]);
      // The caution bit outlives the green and drops under it: no rising edge.
      expect(run(state, tick({ flags: PLAIN_GREEN }))).toEqual([]);
      // …and the caution did not outlive its bits: the next plain green of
      // the race is not a restart.
      run(state, tick({ flags: RACING }));
      expect(run(state, tick({ flags: PLAIN_GREEN }))).toEqual([]);
    });

    it("emits nothing for a green rising with CautionWaving still set", () => {
      run(state, tick({ flags: RACING }));
      run(state, tick({ flags: WAVING }));

      expect(run(state, tick({ flags: WAVING | Flags.Green }))).toEqual([]);
    });

    it("emits nothing for a green with no caution behind it", () => {
      run(state, tick({ flags: RACING }));

      expect(run(state, tick({ flags: PLAIN_GREEN }))).toEqual([]);
      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
    });

    it("emits nothing when the caution bits drop a tick before the green rises — the latch falls with the bits", () => {
      // An unmeasured ordering (both #1127 captures drop the bits on the
      // green's own tick). `caution.restarted` announces nothing here either;
      // an absent entry, never a wrong one.
      throwCaution();
      expect(run(state, tick({ flags: RACING }))).toEqual([]);

      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
    });

    it("emits nothing while the green stays up across the caution bits dropping", () => {
      run(state, tick({ flags: PLAIN_GREEN }));
      run(state, tick({ flags: GREEN_UNDER_CAUTION }));

      expect(run(state, tick({ flags: PLAIN_GREEN }))).toEqual([]);
    });

    it("emits nothing outside Racing", () => {
      throwCaution();

      expect(run(state, tick({ flags: RESTART, state: SessionState.Checkered }))).toEqual([]);
    });

    it("emits nothing in a practice or a qualifying session", () => {
      for (const sessionNum of [0, 1]) {
        run(state, tick({ flags: RACING, sessionNum }));
        run(state, tick({ flags: STATIC, sessionNum }));

        expect(run(state, tick({ flags: RESTART, sessionNum }))).toEqual([]);
      }
    });

    it("is not also emitted on the start's own tick: the start wins and the tick is one edge", () => {
      // Caution bits on the formation lap are not something any capture shows;
      // if a build ever sets them, the green that ends the formation is still
      // the start and nothing else.
      run(state, tick({ state: SessionState.ParadeLaps, flags: STATIC }));

      expect(run(state, tick({ flags: RESTART, frame: 41_000 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, kind: "start", frame: 41_000, sessionTimeMs: 500_000 },
      ]);
    });
  });

  describe("the gate", () => {
    it("unseeds on a replay-view tick and re-seeds silently across a Racing flip", () => {
      run(state, tick({ state: SessionState.Warmup }));

      // The driver sat in the garage through the green.
      expect(run(state, tick({ state: SessionState.Warmup, replay: true }))).toEqual([]);
      expect(state.replayGreensSeeded).toBe(false);
      expect(run(state, tick())).toEqual([]);
      expect(state.replayGreensSeeded).toBe(true);
      expect(run(state, tick())).toEqual([]);
    });

    it("unseeds on a tick the debounced state calls a replay though the flag reads false (a seek's blip, a saved replay)", () => {
      run(state, tick({ state: SessionState.Warmup }));

      expect(run(state, tick({ state: SessionState.Warmup }), { inReplay: true })).toEqual([]);
      expect(state.replayGreensSeeded).toBe(false);
      expect(run(state, tick())).toEqual([]);
    });

    it("emits nothing on an ineligible tick that would itself be the edge", () => {
      run(state, tick({ state: SessionState.Warmup }));

      expect(run(state, tick(), { inReplay: true })).toEqual([]);
      expect(run(state, tick({ replay: true }))).toEqual([]);
    });

    it("unseeds while SessionNum is negative or no frame is readable", () => {
      run(state, tick({ state: SessionState.Warmup }));

      expect(run(state, tick({ state: SessionState.Warmup, sessionNum: -1 }))).toEqual([]);
      expect(state.replayGreensSeeded).toBe(false);
      expect(run(state, tick())).toEqual([]);
      expect(state.replayGreensSeeded).toBe(true);

      run(state, tick({ state: SessionState.ParadeLaps }));
      expect(run(state, tick({ state: SessionState.ParadeLaps, frame: undefined }))).toEqual([]);
      expect(state.replayGreensSeeded).toBe(false);
      expect(run(state, tick())).toEqual([]);
    });

    it("records again from the first edge after the re-seed", () => {
      run(state, tick({ state: SessionState.Warmup }));
      run(state, tick({ state: SessionState.Warmup, replay: true }));
      run(state, tick({ state: SessionState.ParadeLaps }));

      expect(run(state, tick({ frame: 44_000 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, kind: "start", frame: 44_000, sessionTimeMs: 500_000 },
      ]);
    });

    it("misses a restart taken behind a replay glance: the first tick back only re-seeds", () => {
      run(state, tick({ flags: RACING }));
      run(state, tick({ flags: STATIC }));
      run(state, tick({ flags: STATIC, replay: true }));

      // Back on the very tick the green rises.
      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
      expect(run(state, tick({ flags: RESTART }))).toEqual([]);
      expect(run(state, tick({ flags: RACING }))).toEqual([]);
    });

    it("re-reads the latch from the flags it comes back to, so a restart watched after a glance is recorded", () => {
      run(state, tick({ flags: RACING }));
      run(state, tick({ flags: WAVING }));
      run(state, tick({ flags: WAVING, replay: true }));

      // Back with the caution still out: the seed tick is an eligible tick
      // with a caution bit set.
      expect(run(state, tick({ flags: STATIC }))).toEqual([]);
      expect(run(state, tick({ flags: RESTART, frame: 72_000 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, kind: "restart", frame: 72_000, sessionTimeMs: 500_000 },
      ]);
    });
  });

  describe("session change", () => {
    it("re-seeds on a SessionNum change, even across a Racing flip, and stamps the new identity afterwards", () => {
      const heats = {
        WeekendInfo: { SubSessionID: 86697546 },
        SessionInfo: { Sessions: [{ SessionType: "Race" }, { SessionType: "Race" }] },
      };
      run(state, tick({ state: SessionState.Warmup, sessionNum: 0 }), { sessionInfo: heats });

      expect(run(state, tick({ sessionNum: 1 }), { sessionInfo: heats })).toEqual([]);
      expect(state.replayGreensSessionNum).toBe(1);

      run(state, tick({ state: SessionState.ParadeLaps, sessionNum: 1 }), { sessionInfo: heats });
      expect(run(state, tick({ sessionNum: 1, frame: 90_000 }), { sessionInfo: heats }).map((e) => e.data)).toEqual([
        { ...IDENTITY, sessionNum: 1, kind: "start", frame: 90_000, sessionTimeMs: 500_000 },
      ]);
    });

    it("re-seeds on a SessionUniqueID change — a restart is the same SessionNum under a new id", () => {
      run(state, tick({ state: SessionState.Warmup }));

      expect(run(state, tick({ uniqueId: 5 }))).toEqual([]);
      expect(state.replayGreensSessionUniqueId).toBe(5);

      run(state, tick({ state: SessionState.Warmup, uniqueId: 5 }));
      expect(run(state, tick({ uniqueId: 5 })).map((e) => e.data)).toEqual([
        { ...IDENTITY, sessionUniqueId: 5, kind: "start", frame: 30_000, sessionTimeMs: 500_000 },
      ]);
    });

    it("does not carry the caution latch into the new session", () => {
      run(state, tick({ flags: RACING }));
      run(state, tick({ flags: STATIC }));

      // The new instance opens on the green's own tick: a seed, not a restart.
      expect(run(state, tick({ flags: RESTART, uniqueId: 5 }))).toEqual([]);
      run(state, tick({ flags: RACING, uniqueId: 5 }));
      expect(run(state, tick({ flags: RESTART, uniqueId: 5 }))).toEqual([]);
    });

    it("records one start per race instance when an AI session is restarted and runs practice → qualifying → race again", () => {
      // An offline AI event can be restarted: the session numbers start over
      // while the replay's frames keep growing, each instance under a
      // `SessionUniqueID` of its own. A real (hosted, official) event never loops.
      const starts: unknown[] = [];
      const drive = (o: Parameters<typeof tick>[0]): void => {
        starts.push(...run(state, tick(o)).map((e) => e.data));
      };
      const weekend = (firstUniqueId: number, firstFrame: number): void => {
        // Practice and qualifying sit in Racing too, and are not race sessions.
        drive({ sessionNum: 0, uniqueId: firstUniqueId, state: SessionState.GetInCar, frame: firstFrame });
        drive({ sessionNum: 0, uniqueId: firstUniqueId, frame: firstFrame + 100 });
        drive({ sessionNum: 1, uniqueId: firstUniqueId + 1, state: SessionState.GetInCar, frame: firstFrame + 5_000 });
        drive({ sessionNum: 1, uniqueId: firstUniqueId + 1, frame: firstFrame + 5_100 });
        drive({ sessionNum: 2, uniqueId: firstUniqueId + 2, state: SessionState.GetInCar, frame: firstFrame + 9_000 });
        drive({ sessionNum: 2, uniqueId: firstUniqueId + 2, state: SessionState.Warmup, frame: firstFrame + 9_500 });
        drive({ sessionNum: 2, uniqueId: firstUniqueId + 2, frame: firstFrame + 10_000, time: 60 });
      };

      weekend(1, 0);
      // Restarted from inside the race: back to practice, on the same tape.
      weekend(4, 20_000);
      // Restarted again, this time straight into a new race instance.
      drive({ sessionNum: 2, uniqueId: 7, state: SessionState.GetInCar, frame: 40_000 });
      drive({ sessionNum: 2, uniqueId: 7, frame: 40_500, time: 30 });

      expect(starts).toEqual([
        { ...IDENTITY, sessionUniqueId: 3, kind: "start", frame: 10_000, sessionTimeMs: 60_000 },
        { ...IDENTITY, sessionUniqueId: 6, kind: "start", frame: 30_000, sessionTimeMs: 60_000 },
        { ...IDENTITY, sessionUniqueId: 7, kind: "start", frame: 40_500, sessionTimeMs: 30_000 },
      ]);
    });
  });

  describe("the debug line", () => {
    function debugLogger(): { logger: ILogger; lines: string[] } {
      const lines: string[] = [];

      return { logger: { ...silentLogger, debug: (message: string) => lines.push(message) }, lines };
    }

    it("logs the kind, frame, session time, and the state and raw flags on both sides of a start", () => {
      const { logger, lines } = debugLogger();
      run(state, tick({ state: SessionState.ParadeLaps, flags: RACING }), { logger });

      run(state, tick({ flags: RESTART, frame: 41_007, time: 690.1 }), { logger });

      expect(lines).toEqual([
        "Replay green: kind=start frame=41007 sessionTime=690.100 SessionState=3→4 " +
          "SessionFlags=0x10040000→0x80040004 SessionNum=2 SessionUniqueID=4",
      ]);
    });

    it("logs a restart the same way", () => {
      const { logger, lines } = debugLogger();
      run(state, tick({ flags: RACING }), { logger });
      run(state, tick({ flags: ONE_TO_GO }), { logger });

      run(state, tick({ flags: RESTART, frame: 71_904, time: 1199.87 }), { logger });

      expect(lines).toEqual([
        "Replay green: kind=restart frame=71904 sessionTime=1199.870 SessionState=4→4 " +
          "SessionFlags=0x10044200→0x80040004 SessionNum=2 SessionUniqueID=4",
      ]);
    });

    it("logs nothing on a tick that emits nothing", () => {
      const debug = vi.fn();
      const logger: ILogger = { ...silentLogger, debug };

      run(state, tick({ state: SessionState.Warmup }), { logger });
      run(state, tick({ state: SessionState.Warmup, replay: true }), { logger });
      run(state, tick(), { logger });
      run(state, tick({ state: SessionState.GetInCar, sessionNum: 0 }), { logger });
      run(state, tick({ sessionNum: 0 }), { logger });

      expect(debug).not.toHaveBeenCalled();
    });
  });
});
