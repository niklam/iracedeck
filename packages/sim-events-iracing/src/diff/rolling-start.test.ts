/**
 * Unit tests for the rolling-start "pace car is moving" diff (issue #660).
 *
 * The cue fires once at the `*→ParadeLaps` entry edge of a rolling start (the
 * field released into the formation lap), never on a standing start, and
 * re-fires on a genuine re-entry into ParadeLaps (a re-grid). The first tick
 * after connect seeds without firing.
 *
 * Since issue #1167 the diff also holds the formation as a state — opened on
 * that edge or adopted on the first tick, closed when the session leaves
 * ParadeLaps or the green is held or out — and reports a change to the car the
 * player forms up behind while it runs.
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffRollingStart } from "./rolling-start.js";
import type { PendingEvent } from "./types.js";

/** Rolling start (StandingStart not set). */
const ROLLING: Record<string, unknown> | null = null;
/** Standing start. */
const STANDING: Record<string, unknown> = { WeekendInfo: { WeekendOptions: { StandingStart: 1 } } };

function feed(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  sessionState: number,
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const telemetry = { SessionState: sessionState } as TelemetryData;
  diffRollingStart(state, telemetry, sessionInfo, (e) => events.push(e));

  return events;
}

const PACE_CAR_MOVING = { event: "rollingStart.pace-car-moving.raised", data: {} } as const;

describe("diffRollingStart", () => {
  it("seeds on the first tick without firing (connecting mid-parade)", () => {
    const state = createInitialState();
    const events = feed(state, ROLLING, SessionState.ParadeLaps);

    expect(events).toEqual([]);
    expect(state.rollingStartInitialized).toBe(true);
  });

  it("fires once at the Warmup→ParadeLaps entry edge on a rolling start", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    const events = feed(state, ROLLING, SessionState.ParadeLaps);

    expect(events).toEqual([PACE_CAR_MOVING]);
  });

  it("never fires on a standing start", () => {
    const state = createInitialState();
    feed(state, STANDING, SessionState.Warmup); // seed
    const events = feed(state, STANDING, SessionState.ParadeLaps);

    expect(events).toEqual([]);
  });

  it("does not re-fire while staying in ParadeLaps", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    feed(state, ROLLING, SessionState.ParadeLaps); // fires

    const again = feed(state, ROLLING, SessionState.ParadeLaps);
    expect(again).toEqual([]);
  });

  it("re-fires when leaving ParadeLaps then re-entering (re-grid)", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    feed(state, ROLLING, SessionState.ParadeLaps); // fires

    feed(state, ROLLING, SessionState.Racing); // race underway
    const events = feed(state, ROLLING, SessionState.ParadeLaps); // re-grid

    expect(events).toEqual([PACE_CAR_MOVING]);
  });

  it("does not fire on a non-ParadeLaps transition (Warmup→Racing)", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    const events = feed(state, ROLLING, SessionState.Racing);

    expect(events).toEqual([]);
  });
});

// ── The formation as a state, and its lineup (issue #1167) ────────────────

/** The pace car's index in real telemetry. */
const PACE = 64;
const GREEN_HELD = Flags.GreenHeld | Flags.OneLapToGreen | Flags.Servicible | Flags.StartReady;
const GREEN = Flags.Green | Flags.Servicible | Flags.StartGo;
/** What the formation's own ticks carry before the green is held (capture: `0x20040200`). */
const FORMATION_FLAGS = Flags.OneLapToGreen | Flags.Servicible | Flags.StartReady;

/** A rolling start whose session info names the player and the pace car. */
function rolling(playerCarIdx: number): Record<string, unknown> {
  return {
    DriverInfo: { DriverCarIdx: playerCarIdx, PaceCarIdx: PACE, Drivers: [] },
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
  };
}

/**
 * A double-file grid: the pace car without a row, P1 = line 0 row 0, P2 =
 * line 1 row 0, P3 = line 0 row 1 — cars 1..6 in grid order.
 */
const GRID: Array<[carIdx: number, line: number, row: number]> = [
  [1, 0, 0],
  [2, 1, 0],
  [3, 0, 1],
  [4, 1, 1],
  [5, 0, 2],
  [6, 1, 2],
];

/** The same six cars single file on line 0, rows 0..5. */
const SINGLE_FILE_GRID: Array<[number, number, number]> = [1, 2, 3, 4, 5, 6].map((carIdx, row) => [carIdx, 0, row]);

type Tick = {
  state?: SessionState;
  flags?: number;
  cars?: Array<[number, number, number]> | null;
};

/** One tick: session state, flags, and (unless `null`) the pace arrays at real telemetry width. */
function tick({ state = SessionState.ParadeLaps, flags = FORMATION_FLAGS, cars = GRID }: Tick = {}): TelemetryData {
  const base = { SessionState: state, SessionFlags: flags };

  if (cars === null) return base as TelemetryData;

  const lines = new Array(72).fill(-1);
  const rows = new Array(72).fill(-1);

  for (const [carIdx, line, row] of cars) {
    lines[carIdx] = line;
    rows[carIdx] = row;
  }

  return { ...base, CarIdxPaceLine: lines, CarIdxPaceRow: rows } as unknown as TelemetryData;
}

/** {@link GRID} with two cars' slots exchanged — the cheapest way to put another car ahead of someone. */
function swapped(a: number, b: number, cars: Array<[number, number, number]> = GRID): Array<[number, number, number]> {
  const slotOf = (carIdx: number): [number, number] => {
    const [, line, row] = cars.find(([idx]) => idx === carIdx) as [number, number, number];

    return [line, row];
  };

  return cars.map(([carIdx, line, row]) =>
    carIdx === a ? [a, ...slotOf(b)] : carIdx === b ? [b, ...slotOf(a)] : [carIdx, line, row],
  );
}

function run(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  ...ticks: TelemetryData[]
): PendingEvent[] {
  const events: PendingEvent[] = [];

  for (const telemetry of ticks) diffRollingStart(state, telemetry, sessionInfo, (e) => events.push(e));

  return events;
}

const formationOf = (state: TranslatorState): { id: number | null; first: number | null } => ({
  id: state.rollingStartFormationId,
  first: state.rollingStartFirstFollowCarIdx,
});

const WARMUP = tick({ state: SessionState.Warmup });
const LINEUP_CHANGED = { event: "rollingStart.lineup.changed", data: {} } as const;

describe("diffRollingStart — the formation", () => {
  it("opens on the ParadeLaps entry edge, on the tick the cue fires, with the car ahead as its first follow car", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP); // seed
    expect(formationOf(state)).toEqual({ id: null, first: null });

    // Car 5 is line 0 row 2, behind car 3.
    expect(run(state, rolling(5), tick())).toEqual([PACE_CAR_MOVING]);
    expect(formationOf(state)).toEqual({ id: expect.any(Number), first: 3 });
  });

  it("has the formation and its first follow car in place BEFORE the cue is emitted", () => {
    // A callout's speak gate is asked when the event is published, not only
    // after a wait: the cue must not arrive ahead of the formation it opens,
    // or the pace-car call would refuse itself on that very event.
    const state = createInitialState();
    const seenAtEmit: Array<{ event: string; id: number | null; first: number | null }> = [];

    run(state, rolling(5), WARMUP);
    diffRollingStart(state, tick(), rolling(5), (e) => seenAtEmit.push({ event: e.event, ...formationOf(state) }));

    expect(seenAtEmit).toEqual([{ event: "rollingStart.pace-car-moving.raised", id: expect.any(Number), first: 3 }]);
  });

  it("has moved on to the new car BEFORE the change is emitted", () => {
    const state = createInitialState();
    const seenAtEmit: Array<{ event: string; id: number | null; follow: number | null }> = [];

    run(state, rolling(5), WARMUP, tick());
    diffRollingStart(state, tick({ cars: swapped(3, 1) }), rolling(5), (e) =>
      seenAtEmit.push({ event: e.event, id: state.rollingStartFormationId, follow: state.rollingStartFollowCarIdx }),
    );

    expect(seenAtEmit).toEqual([{ event: "rollingStart.lineup.changed", id: expect.any(Number), follow: 1 }]);
  });

  it("runs unchanged for as long as the session stays in ParadeLaps with the green neither held nor out", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP, tick());

    const opened = formationOf(state);

    expect(run(state, rolling(5), tick(), tick(), tick())).toEqual([]);
    expect(formationOf(state)).toEqual(opened);
  });

  it.each([
    ["the session leaves ParadeLaps", tick({ state: SessionState.Racing })],
    ["the green is held", tick({ flags: GREEN_HELD })],
    ["the green is out", tick({ flags: GREEN })],
    ["the green is held and out on one tick, as at the captured start", tick({ flags: GREEN | Flags.GreenHeld })],
  ])("ends when %s", (_label, ending) => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP, tick());
    expect(state.rollingStartFormationId).not.toBeNull();

    expect(run(state, rolling(5), ending)).toEqual([]);
    expect(formationOf(state)).toEqual({ id: null, first: null });
    expect(state.rollingStartFollowCarIdx).toBeNull();
  });

  it("stays ended when the green-held bit is withdrawn inside ParadeLaps — a latch, not a reading of the bits", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP, tick(), tick({ flags: GREEN_HELD }));

    expect(run(state, rolling(5), tick(), tick())).toEqual([]);
    expect(state.rollingStartFormationId).toBeNull();
  });

  it("gives a re-grid a formation of its own", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP, tick());

    const first = state.rollingStartFormationId;

    run(state, rolling(5), tick({ state: SessionState.Racing }));
    expect(run(state, rolling(5), tick())).toEqual([PACE_CAR_MOVING]);

    expect(state.rollingStartFormationId).not.toBeNull();
    expect(state.rollingStartFormationId).not.toBe(first);
  });

  it("never numbers two formations alike, even across a fresh state — the id outlives a session change", () => {
    const one = createInitialState();
    const two = createInitialState();

    run(one, rolling(5), WARMUP, tick());
    run(two, rolling(5), WARMUP, tick());

    expect(one.rollingStartFormationId).not.toBeNull();
    expect(two.rollingStartFormationId).not.toBe(one.rollingStartFormationId);
  });

  it("never opens on a standing start", () => {
    const standing = { ...rolling(5), ...STANDING };
    const state = createInitialState();

    expect(run(state, standing, WARMUP, tick(), tick())).toEqual([]);
    expect(state.rollingStartFormationId).toBeNull();
  });

  it("does not open when the green is already held on the entry tick, though the cue still fires", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP);

    expect(run(state, rolling(5), tick({ flags: GREEN_HELD }))).toEqual([PACE_CAR_MOVING]);
    expect(state.rollingStartFormationId).toBeNull();
  });

  describe("on the diff's first tick", () => {
    it("adopts a formation that is already running, silently — a plugin started mid-formation", () => {
      const state = createInitialState();

      expect(run(state, rolling(5), tick())).toEqual([]);
      expect(formationOf(state)).toEqual({ id: expect.any(Number), first: 3 });
    });

    it("reports a change of the car ahead after adopting one", () => {
      const state = createInitialState();

      run(state, rolling(5), tick());

      expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([LINEUP_CHANGED]);
    });

    it.each([
      ["the green is already held", rolling(5), tick({ flags: GREEN_HELD })],
      ["the green is already out", rolling(5), tick({ flags: GREEN })],
      ["the session is not in ParadeLaps", rolling(5), WARMUP],
      ["the start is a standing one", { ...rolling(5), ...STANDING }, tick()],
    ])("adopts nothing when %s", (_label, sessionInfo, first) => {
      const state = createInitialState();

      expect(run(state, sessionInfo, first)).toEqual([]);
      expect(state.rollingStartFormationId).toBeNull();
    });

    it("keeps a formation carried in from before a replay glance, id and first follow car — and re-reads the car ahead without reporting it", () => {
      // What `wipeStateForReplay` hands the first tick back: a fresh state
      // with the formation's identity carried over and every baseline gone.
      const state = createInitialState();

      state.rollingStartFormationId = 41;
      state.rollingStartFirstFollowCarIdx = 3;

      // The car ahead changed during the glance: car 1 is there now.
      expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([]);
      expect(formationOf(state)).toEqual({ id: 41, first: 3 });
      expect(state.rollingStartFollowCarIdx).toBe(1);

      // ...and from there on a change is a change again.
      expect(run(state, rolling(5), tick())).toEqual([LINEUP_CHANGED]);
    });

    it("never reports a change, even handed a follow car from before — the first tick's lineup is the baseline", () => {
      // The replay wipe does not carry the follow car over; this is the diff
      // holding that line itself rather than relying on its caller.
      const state = createInitialState();

      state.rollingStartFormationId = 41;
      state.rollingStartFirstFollowCarIdx = 3;
      state.rollingStartFollowCarIdx = 3;

      expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([]);
      expect(state.rollingStartFollowCarIdx).toBe(1);
    });

    it.each([
      ["the green was held meanwhile", tick({ flags: GREEN_HELD })],
      ["the race is under way", tick({ state: SessionState.Racing, flags: GREEN })],
    ])("closes a carried-in formation that ended during the glance — %s", (_label, back) => {
      const state = createInitialState();

      state.rollingStartFormationId = 41;
      state.rollingStartFirstFollowCarIdx = 3;

      expect(run(state, rolling(5), back)).toEqual([]);
      expect(formationOf(state)).toEqual({ id: null, first: null });
    });
  });
});

describe("diffRollingStart — the car ahead changing (rollingStart.lineup.changed)", () => {
  /** A formation running for car 5 (line 0 row 2, behind car 3), opened on a real entry edge. */
  function inFormation(sessionInfo: Record<string, unknown> | null = rolling(5)): TranslatorState {
    const state = createInitialState();

    run(state, sessionInfo, WARMUP, tick());

    return state;
  }

  it("says nothing across a formation whose lineup never moves", () => {
    const state = inFormation();

    expect(run(state, rolling(5), tick(), tick(), tick())).toEqual([]);
  });

  it("reports a change of the car ahead, with nothing in the payload", () => {
    const state = inFormation();

    expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([LINEUP_CHANGED]);
    expect(state.rollingStartFollowCarIdx).toBe(1);
  });

  it("reports it once, not on every tick the new car stays ahead", () => {
    const state = inFormation();
    const moved = tick({ cars: swapped(3, 1) });

    expect(run(state, rolling(5), moved, moved, moved)).toEqual([LINEUP_CHANGED]);
  });

  it("keeps the formation's first follow car through a change, so a return to it can be told from a new car", () => {
    const state = inFormation();

    run(state, rolling(5), tick({ cars: swapped(3, 1) }));
    expect(formationOf(state).first).toBe(3);

    expect(run(state, rolling(5), tick())).toEqual([LINEUP_CHANGED]);
    expect(formationOf(state).first).toBe(3);
  });

  it("does not report a change that is not the player's — another row reshuffles", () => {
    const state = inFormation();

    // Cars 2 and 4 swap on line 1; car 5 on line 0 still follows car 3.
    expect(run(state, rolling(5), tick({ cars: swapped(2, 4) }))).toEqual([]);
  });

  it("reports the pole-sitter's car ahead becoming a car — the pace car is a follow car like any other", () => {
    const state = createInitialState();

    run(state, rolling(1), WARMUP, tick());
    expect(formationOf(state).first).toBe(PACE);

    // Car 3 takes line 0 row 0; car 1 drops to row 1 behind it.
    expect(run(state, rolling(1), tick({ cars: swapped(1, 3) }))).toEqual([LINEUP_CHANGED]);
    expect(state.rollingStartFollowCarIdx).toBe(3);
  });

  it("reports a change in a single-file formation", () => {
    const state = createInitialState();
    const single = (cars = SINGLE_FILE_GRID): TelemetryData => tick({ cars });

    // Car 5 is row 4, behind car 4.
    expect(run(state, rolling(5), WARMUP, single())).toEqual([PACE_CAR_MOVING]);
    expect(formationOf(state).first).toBe(4);

    expect(run(state, rolling(5), single(), single(swapped(4, 2, SINGLE_FILE_GRID)))).toEqual([LINEUP_CHANGED]);
    expect(state.rollingStartFollowCarIdx).toBe(2);
  });

  describe("a tick that cannot read the lineup is a gap, not a change", () => {
    it.each([
      ["no pace arrays", rolling(5), tick({ cars: null })],
      ["no session info", null, tick()],
      ["a player the grid has not placed", rolling(5), tick({ cars: GRID.filter(([carIdx]) => carIdx !== 5) })],
    ])("%s", (_label, gapInfo, gapTick) => {
      const state = inFormation();

      expect(run(state, gapInfo, gapTick)).toEqual([]);
      // The car held is still the one last read...
      expect(state.rollingStartFollowCarIdx).toBe(3);
      // ...so the same lineup coming back is no news, and a different one is.
      expect(run(state, rolling(5), tick())).toEqual([]);
      expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([LINEUP_CHANGED]);
    });

    it("judges the lineup after a gap against the last one read, not against nothing", () => {
      const state = inFormation();

      expect(run(state, null, tick(), tick())).toEqual([]);
      expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([LINEUP_CHANGED]);
    });
  });

  it("ignores a follow car it cannot name — a stray line value on the player's own slot", () => {
    // A single-file formation, car 5 at row 4 behind car 4.
    const state = createInitialState();

    run(state, rolling(5), WARMUP, tick({ cars: SINGLE_FILE_GRID }));
    expect(state.rollingStartFollowCarIdx).toBe(4);

    // Car 5 alone on line 1 while the field is on line 0: the reader withholds
    // every answer for that tick, the follow car included.
    const stray = tick({
      cars: SINGLE_FILE_GRID.map(([carIdx, line, row]) => (carIdx === 5 ? [5, 1, 4] : [carIdx, line, row])),
    });

    expect(run(state, rolling(5), stray)).toEqual([]);
    expect(state.rollingStartFollowCarIdx).toBe(4);
    expect(run(state, rolling(5), tick({ cars: SINGLE_FILE_GRID }))).toEqual([]);
  });

  it("opens a formation whose entry tick cannot read the lineup, and takes the first readable car as its first follow car, silently", () => {
    const state = createInitialState();

    run(state, rolling(5), WARMUP);

    expect(run(state, rolling(5), tick({ cars: null }))).toEqual([PACE_CAR_MOVING]);
    expect(formationOf(state)).toEqual({ id: expect.any(Number), first: null });

    expect(run(state, rolling(5), tick())).toEqual([]);
    expect(formationOf(state).first).toBe(3);
  });

  it("says nothing once the formation has ended, however the rows move — the unwind", () => {
    const state = inFormation();

    expect(
      run(
        state,
        rolling(5),
        tick({ flags: GREEN_HELD }),
        tick({ flags: GREEN_HELD, cars: swapped(3, 1) }),
        tick({ state: SessionState.Racing, flags: GREEN, cars: swapped(3, 2) }),
        tick({ state: SessionState.Racing, flags: GREEN, cars: GRID.filter(([carIdx]) => carIdx !== 3) }),
      ),
    ).toEqual([]);
  });

  it("starts the next formation from nothing — its first lineup is not a change from the last one's", () => {
    const state = inFormation();

    run(state, rolling(5), tick({ state: SessionState.Racing, flags: GREEN }));

    // The re-grid puts car 1 ahead of car 5 where car 3 was.
    expect(run(state, rolling(5), tick({ cars: swapped(3, 1) }))).toEqual([PACE_CAR_MOVING]);
    expect(formationOf(state).first).toBe(1);
  });

  it("does not read the pace arrays at all outside a formation", () => {
    const state = createInitialState();
    let reads = 0;
    const watched = (base: TelemetryData): TelemetryData => {
      const lines = base.CarIdxPaceLine;

      return Object.defineProperty({ ...base }, "CarIdxPaceLine", {
        get: () => {
          reads++;

          return lines;
        },
      }) as TelemetryData;
    };
    const racing = tick({ state: SessionState.Racing, flags: GREEN });

    run(state, rolling(5), watched(WARMUP), watched(racing), watched(racing));
    expect(reads).toBe(0);

    // The positive control: the same telemetry IS read once a formation runs.
    run(state, rolling(5), watched(tick()));
    expect(reads).toBeGreaterThan(0);
  });
});
