import { Flags } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffLeaderWhite } from "./leader-white.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;

/** frozenPositions indexed by carIdx (1-based ranks) — 4-car field, carIdx 1 leads (P1), player (carIdx 0) is P4. */
const POSITIONS = [4, 1, 2, 3];

type Field = {
  CarIdxLapCompleted: number[];
  SessionLapsRemainEx?: number;
  SessionTimeRemain?: number;
  SessionFlags?: number;
};

function field(lapCompleted: number[], extra: Partial<Field> = {}): Field {
  return { CarIdxLapCompleted: lapCompleted, ...extra };
}

function run(
  state: TranslatorState,
  telemetry: Field,
  opts: Partial<{
    player: number;
    isRace: boolean;
    replay: boolean;
    preGreen: boolean;
    postRace: boolean;
    positions: number[];
  }> = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffLeaderWhite(
    state,
    telemetry as never,
    opts.player ?? PLAYER,
    opts.isRace ?? true,
    opts.replay ?? false,
    opts.preGreen ?? false,
    opts.postRace ?? false,
    opts.positions ?? POSITIONS,
    (ev) => out.push(ev),
  );

  return out;
}

const RAISED = { event: "flag.white-leader.raised", data: {} };

describe("diffLeaderWhite", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  describe("lap-limited", () => {
    it("stays silent on a 3 → 2 tick", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }))).toEqual([]);
    });

    it("fires once on the 2 → 1 edge", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }))).toEqual([RAISED]);
      expect(state.leaderWhiteFired).toBe(true);
    });

    it("stays silent on a 1 → 1 tick (no re-fire, already latched)", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }));
      expect(run(state, field([10, 10, 10, 11], { SessionLapsRemainEx: 1 }))).toEqual([]);
    });

    it("latch blocks a later re-edge (e.g. laps-remain bounces back up then falls to 1 again)", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }))).toEqual([]);
    });

    it("seeding mid-final-lap (first tick already at 1) never fires this race", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }))).toEqual([]);
      expect(state.leaderWhiteFired).toBe(false);
    });
  });

  describe("timed", () => {
    it("emits on a genuine leader-lap increment once the clock has expired", () => {
      run(state, field([10, 20, 10, 10], { SessionTimeRemain: 5 })); // seed baseline, clock still running
      expect(run(state, field([10, 21, 10, 10], { SessionTimeRemain: 0 }))).toEqual([RAISED]);
      expect(state.leaderWhiteFired).toBe(true);
    });

    it("stays silent on a leader-lap increment while the clock has not expired", () => {
      run(state, field([10, 20, 10, 10], { SessionTimeRemain: 5 }));
      expect(run(state, field([10, 21, 10, 10], { SessionTimeRemain: 3 }))).toEqual([]);
    });

    it("a leader change re-baselines silently — only the NEXT crossing of the newly-tracked leader fires", () => {
      run(state, field([10, 20, 10, 10], { SessionTimeRemain: 0 })); // carIdx 1 leads, seeds lap 20
      const newPositions = [4, 2, 1, 3]; // carIdx 2 now leads

      // Leader-change tick: carIdx 2 becomes the tracked leader; re-baselines silently.
      expect(run(state, field([10, 20, 21, 10], { SessionTimeRemain: 0 }), { positions: newPositions })).toEqual([]);

      // The NEXT genuine crossing of the now-tracked leader (carIdx 2), clock still expired, fires.
      expect(run(state, field([10, 20, 22, 10], { SessionTimeRemain: 0 }), { positions: newPositions })).toEqual([
        RAISED,
      ]);
    });
  });

  describe("unlimited sentinels", () => {
    it("ignores the SessionLapsRemainEx unlimited-laps sentinel (timed-only race)", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 32767, SessionTimeRemain: 100 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 32767, SessionTimeRemain: 50 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 32767, SessionTimeRemain: 0 }))).toEqual([]);
      // The baseline never seeds a finite lapsRemain value from the sentinel.
      expect(state.leaderWhiteLastLapsRemainEx).toBeNull();
    });

    it("ignores the SessionTimeRemain unlimited-time sentinel (lap-limited-only race)", () => {
      run(state, field([10, 20, 10, 10], { SessionTimeRemain: 604800 }));
      // Leader-lap increment happens, but the clock reads the "no time limit" sentinel — never expired.
      expect(run(state, field([10, 21, 10, 10], { SessionTimeRemain: 604800 }))).toEqual([]);
    });
  });

  describe("suppression", () => {
    it("leader === player: latches without emitting", () => {
      const playerLeads = [1, 2, 3, 4]; // player (carIdx 0) is P1
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }), { positions: playerLeads });
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { positions: playerLeads });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }), { positions: playerLeads })).toEqual([]);
      expect(state.leaderWhiteFired).toBe(true);
    });

    it("the player's own White bit already up at the detection tick: latches without emitting", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }));
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1, SessionFlags: Flags.White }))).toEqual([]);
      expect(state.leaderWhiteFired).toBe(true);
    });
  });

  describe("dual-limit race", () => {
    it("whichever edge lands first wins the latch — a same-tick double-true edge emits exactly once, and the latch blocks the other mechanism's later edge too", () => {
      run(state, field([10, 20, 10, 10], { SessionLapsRemainEx: 3, SessionTimeRemain: 50 }));
      run(state, field([10, 20, 10, 10], { SessionLapsRemainEx: 2, SessionTimeRemain: 20 }));

      // Both the lap edge (2 → 1) AND the timed edge (clock expired + leader
      // crossed) are true on this exact tick — exactly one event fires.
      expect(run(state, field([10, 21, 10, 10], { SessionLapsRemainEx: 1, SessionTimeRemain: 0 }))).toEqual([RAISED]);
      expect(state.leaderWhiteFired).toBe(true);

      // A later tick that would ALSO satisfy the timed edge on its own never re-fires.
      expect(run(state, field([10, 22, 10, 10], { SessionLapsRemainEx: 1, SessionTimeRemain: 0 }))).toEqual([]);
    });
  });

  describe("gates", () => {
    it("stays silent outside live races and absorbs a gated lap-limited edge", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }));
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { isRace: false });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }), { isRace: false })).toEqual([]);
      expect(state.leaderWhiteLastLapsRemainEx).toBe(1); // baseline advanced despite the gate

      // Gate reopens — the edge already happened under the gate; absorbed, not replayed.
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 1 }))).toEqual([]);
      expect(state.leaderWhiteFired).toBe(false); // never actually detected — the gate ate it
    });

    it("stays silent during a replay-only session, baselines still advance", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }), { replay: true });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { replay: true })).toEqual([]);
      expect(state.leaderWhiteLastLapsRemainEx).toBe(2);
    });

    it("stays silent pre-green, baselines still advance", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }), { preGreen: true });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { preGreen: true })).toEqual([]);
      expect(state.leaderWhiteLastLapsRemainEx).toBe(2);
    });

    it("stays silent post-race, baselines still advance", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }), { postRace: true });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { postRace: true })).toEqual([]);
      expect(state.leaderWhiteLastLapsRemainEx).toBe(2);
    });

    it("stays silent when the player carIdx is unresolved, baselines still advance", () => {
      run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 3 }), { player: -1 });
      expect(run(state, field([10, 10, 10, 10], { SessionLapsRemainEx: 2 }), { player: -1 })).toEqual([]);
      expect(state.leaderWhiteLastLapsRemainEx).toBe(2);
    });
  });
});
