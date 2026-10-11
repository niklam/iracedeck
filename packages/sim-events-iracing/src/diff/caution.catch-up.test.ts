/**
 * The catch-up episode machine (issue #1168): `diffCatchUp` in `caution.ts`,
 * driven through `diffCaution` with synthetic ticks and its own clock.
 *
 * A file of its own, beside `caution.test.ts`, because it wraps the lineup
 * reader in a spy: "the lineup is resolved once per tick, by its one reader,
 * and never under green" is a property of the wiring between `diffLineup` and
 * `diffCatchUp`, and counting the resolutions is the only way to pin it.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { measureCautionGap } from "./caution-gap.js";
import {
  CATCH_UP_CLEAR_MULTIPLE,
  CATCH_UP_DWELL_MS,
  CATCH_UP_MAX_REMINDERS,
  CATCH_UP_PIT_EXIT_GRACE_MS,
  CATCH_UP_RAISE_MULTIPLE,
  CATCH_UP_REMINDER_MS,
  CATCH_UP_SETTLE_MS,
  CATCH_UP_UNJUDGED_TOLERANCE_MS,
  type CatchUpBlock,
  diffCaution,
  isHardCatchUpBlock,
  resolveCatchUpBlocks,
} from "./caution.js";
import { resolvePaceLineup } from "./pace-lineup.js";

vi.mock("./pace-lineup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pace-lineup.js")>();

  return { ...actual, resolvePaceLineup: vi.fn(actual.resolvePaceLineup) };
});

const PACE = 64;
const PLAYER = 6;
/** A 1000 m lap, so metres read off the page. */
const LAP = 1000;

const RACING = 0x10040000; // Servicible | StartHidden — green-flag running
const WAVING = 0x10048000; // + CautionWaving
const STATIC = 0x10044000; // + Caution
const ONE_TO_GO = 0x10044200; // + OneLapToGreen
const GREEN = 0x4;
const GREEN_HELD = 0x400;

const INFO: Record<string, unknown> = { DriverInfo: { DriverCarIdx: PLAYER, PaceCarIdx: PACE, Drivers: [] } };

const OPENED = "caution.gapOpened";
const STILL_OPEN = "caution.gapStillOpen";

type World = {
  flags?: number;
  /** How far the player — and the cars behind him, who keep station — has dropped back, in metres. */
  back?: number;
  /** Metres the player ALONE has driven forward past his slot. */
  forward?: number;
  onPitRoad?: boolean;
  paceCarSurface?: number;
  /** The player's `CarIdxPaceFlags` bits. */
  paceFlags?: number;
  /** Which car holds the slot directly ahead of the player (car 5's, by default). */
  ahead?: number;
  /** The player holds no pace row — in the pits. */
  unlined?: boolean;
  /** How many cars are lined up behind the pace car. */
  cars?: number;
  /** The first row that has dropped back — the player's, unless a test puts another car in his place. */
  backFrom?: number;
  /** The tick carries no per-car lap distance: the lineup still reads, and no gap can be measured. */
  noLapDistance?: boolean;
  /** Cars that hold their row and are not in the world this tick. */
  gone?: number[];
};

/**
 * One tick of a single-file caution on a 1000 m lap: the pace car at line 0
 * row 0, the leader 20 m behind it and every car after 10 m apart, so the
 * pack spacing is 10 m and the player's ratio is `(10 + back) / 10`.
 */
function world({
  flags = STATIC,
  back = 0,
  forward = 0,
  onPitRoad = false,
  paceCarSurface = TrkLoc.OnTrack,
  paceFlags = 0,
  ahead = 5,
  unlined = false,
  cars = 10,
  backFrom = PLAYER,
  noLapDistance = false,
  gone = [],
}: World = {}): TelemetryData {
  const lines = new Array(72).fill(-1);
  const rows = new Array(72).fill(-1);
  const dist = new Array(72).fill(-1);
  const surface = new Array(72).fill(TrkLoc.NotInWorld);
  const pace = new Array(72).fill(0);
  const place = (carIdx: number, row: number, at: number): void => {
    lines[carIdx] = 0;
    rows[carIdx] = row;
    dist[carIdx] = (((at % LAP) + LAP) % LAP) / LAP;
    surface[carIdx] = TrkLoc.OnTrack;
  };

  place(PACE, 0, 500);
  surface[PACE] = paceCarSurface;

  for (let row = 1; row <= cars; row++) {
    // `ahead` takes car 5's slot and car 5 takes its.
    const carIdx = row === 5 ? ahead : row === ahead ? 5 : row;

    place(carIdx, row, 480 - 10 * (row - 1) - (row >= backFrom ? back : 0) + (carIdx === PLAYER ? forward : 0));
  }

  if (unlined) {
    lines[PLAYER] = -1;
    rows[PLAYER] = -1;
  }

  for (const carIdx of gone) {
    dist[carIdx] = -1;
    surface[carIdx] = TrkLoc.NotInWorld;
  }

  pace[PLAYER] = paceFlags;

  return {
    SessionFlags: flags,
    OnPitRoad: onPitRoad,
    CarIdxPaceLine: lines,
    CarIdxPaceRow: rows,
    CarIdxPaceFlags: pace,
    ...(noLapDistance ? {} : { CarIdxLapDistPct: dist }),
    CarIdxTrackSurface: surface,
  } as unknown as TelemetryData;
}

/** Dropped back to 4× the pack spacing: 40 m behind car 5. */
const OPEN: World = { back: 30 };
/** At 2× — between the clear and the raise multiple. */
const BAND: World = { back: 10 };
/** In place. */
const CLOSED: World = { back: 0 };

type Rig = {
  state: TranslatorState;
  /** The rig's clock, ms. */
  now: () => number;
  /** One tick, `ms` after the last. Returns the catch-up events it emitted. */
  tick: (w?: World, ms?: number, info?: Record<string, unknown> | null) => string[];
  /** The same world on every tick for `ms`. Returns each event with the time since `hold` began. */
  hold: (w: World, ms: number, step?: number) => Array<[event: string, at: number]>;
  /** Seed, wave, pick up, and sit in `w` through the settle window. */
  caught: (w?: World) => void;
};

function rig(trackLengthMeters: number | null = LAP): Rig {
  const state = createInitialState();
  let now = 5_000_000;

  const tick: Rig["tick"] = (w = {}, ms = 100, info = INFO) => {
    const events: string[] = [];

    now += ms;
    diffCaution(
      state,
      world(w),
      info,
      null,
      (e) => {
        if (e.event === OPENED || e.event === STILL_OPEN) events.push(e.event);
      },
      { now, trackLengthMeters },
    );

    return events;
  };

  const hold: Rig["hold"] = (w, ms, step = 100) => {
    const out: Array<[string, number]> = [];

    for (let elapsed = step; elapsed <= ms; elapsed += step) {
      for (const event of tick(w, step)) out.push([event, elapsed]);
    }

    return out;
  };

  const caught: Rig["caught"] = (w = CLOSED) => {
    tick({ ...w, flags: RACING }); // seed
    tick({ ...w, flags: WAVING });
    tick({ ...w, flags: STATIC }); // the pickup
    hold(w, CATCH_UP_SETTLE_MS);
  };

  return { state, now: () => now, tick, hold, caught };
}

/** What blocks catch-up for a rig's state in a given world, right now. */
function resolveCatchUpBlocksOf(r: Rig, w: World): CatchUpBlock[] {
  const telemetry = world(w);
  const lineup = resolvePaceLineup(telemetry, INFO, false);

  if (lineup === null) throw new Error("the player is not lined up");

  return resolveCatchUpBlocks(r.state, telemetry, measureCautionGap(telemetry, INFO, lineup, LAP), r.now());
}

/** A rig with the field caught, settled, and the player's gap open and called. */
function opened(): Rig {
  const r = rig();

  r.caught();
  expect(r.hold(OPEN, CATCH_UP_DWELL_MS + 100)).toEqual([[OPENED, CATCH_UP_DWELL_MS + 100]]);

  return r;
}

beforeEach(() => {
  vi.mocked(resolvePaceLineup).mockClear();
});

describe("the catch-up episode — the thresholds this file drives", () => {
  it("rests on the world's arithmetic: 40 m against a 10 m pack is 4×, 20 m is 2×, 10 m is 1×", () => {
    const ratio = (w: World): number | null => {
      const lineup = resolvePaceLineup(world(w), INFO, false);

      return lineup === null ? null : measureCautionGap(world(w), INFO, lineup, LAP).ratio;
    };

    expect(ratio(OPEN)).toBeCloseTo(4);
    expect(ratio(BAND)).toBeCloseTo(2);
    expect(ratio(CLOSED)).toBeCloseTo(1);
    expect(CATCH_UP_RAISE_MULTIPLE).toBe(2.5);
    expect(CATCH_UP_CLEAR_MULTIPLE).toBe(1.75);
    expect([CATCH_UP_SETTLE_MS, CATCH_UP_DWELL_MS, CATCH_UP_REMINDER_MS, CATCH_UP_PIT_EXIT_GRACE_MS]).toEqual([
      10_000,
      3_000,
      30_000,
      10_000,
    ]);
    expect(CATCH_UP_MAX_REMINDERS).toBe(2);
  });
});

describe("the catch-up episode — the dwell", () => {
  it("opens once the gap has stayed at the raise multiple for the whole dwell, and says so once", () => {
    const r = rig();

    r.caught();

    // The first open tick starts the dwell; the call comes a full dwell later.
    expect(r.hold(OPEN, 20_000)).toEqual([[OPENED, CATCH_UP_DWELL_MS + 100]]);
  });

  it("does not open one tick short of the dwell", () => {
    const r = rig();

    r.caught();

    expect(r.hold(OPEN, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([OPENED]);
  });

  it("swallows a transient: a gap that closes before the dwell is out says nothing, and the dwell starts over", () => {
    const r = rig();

    r.caught();

    expect(r.hold(OPEN, CATCH_UP_DWELL_MS - 500)).toEqual([]);
    expect(r.tick(CLOSED)).toEqual([]);
    // Open again: a FULL dwell from here, not the 500 ms that were left.
    expect(r.hold(OPEN, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([OPENED]);
  });

  it("restarts the dwell on a dip into the band as well — it has to be continuous at the raise multiple", () => {
    const r = rig();

    r.caught();

    r.hold(OPEN, CATCH_UP_DWELL_MS - 500);
    expect(r.tick(BAND)).toEqual([]);
    expect(r.hold(OPEN, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([OPENED]);
  });

  it("does not count time it could not judge: two readings ten seconds apart are not a dwell — the reported failure", () => {
    const r = rig();

    r.caught();

    expect(r.tick(OPEN)).toEqual([]);

    // Ten seconds with no readable lineup, then one more reading at 4×.
    for (let elapsed = 0; elapsed < 10_000; elapsed += 500) expect(r.tick(OPEN, 500, null)).toEqual([]);

    expect(r.tick(OPEN)).toEqual([]);

    // The dwell started over on that reading: a full three seconds from it.
    expect(r.hold(OPEN, CATCH_UP_DWELL_MS - 100)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([OPENED]);
  });

  it("restarts the dwell after an unjudged stretch just over the tolerance, and not after one just under", () => {
    const after = (gapMs: number): Array<[string, number]> => {
      const r = rig();

      r.caught();
      r.hold(OPEN, 1_000);
      r.tick(OPEN, gapMs, null);

      // The reading that ends the stretch, then the rest of what a dwell
      // running on would need.
      return r.hold(OPEN, CATCH_UP_DWELL_MS);
    };

    // 0.9 s served, 0.9 s unseen, bridged: the call comes when 3 s are up.
    expect(after(CATCH_UP_UNJUDGED_TOLERANCE_MS - 100)).toEqual([[OPENED, CATCH_UP_DWELL_MS - 900 - 900]]);
    // 1.1 s unseen: the reading after it starts a dwell of its own.
    expect(after(CATCH_UP_UNJUDGED_TOLERANCE_MS + 100)).toEqual([]);
    expect(CATCH_UP_UNJUDGED_TOLERANCE_MS).toBe(1_000);
  });

  it("is not fooled by a one-tick spike", () => {
    const r = rig();

    r.caught();

    for (let i = 0; i < 100; i++) {
      expect(r.tick(i % 10 === 0 ? { back: 100 } : CLOSED)).toEqual([]);
    }
  });
});

describe("the catch-up episode — both thresholds and the band between them", () => {
  it("opens just above the raise multiple", () => {
    const r = rig();

    r.caught();

    // 25.1 m against 10 m: 2.51×.
    expect(r.hold({ back: 15.1 }, CATCH_UP_DWELL_MS + 100)).toEqual([[OPENED, CATCH_UP_DWELL_MS + 100]]);
  });

  it("does not open just under it, however long the gap sits there", () => {
    const r = rig();

    r.caught();

    expect(r.hold({ back: 14.9 }, 120_000, 500)).toEqual([]); // 2.49×
    expect(r.hold(BAND, 120_000, 500)).toEqual([]);
  });

  it("keeps an open gap open through the band — and reminds there", () => {
    const r = opened();

    expect(r.state.cautionCatchUpOpen).toBe(true);
    // Closed up from 4× to 2×: not closed. 20 m shorter is "closing" at the
    // first reminder moment, so that one is skipped; the next one speaks.
    expect(r.hold(BAND, 2 * CATCH_UP_REMINDER_MS + 500, 500).map(([event]) => event)).toEqual([STILL_OPEN]);
    expect(r.state.cautionCatchUpOpen).toBe(true);
  });

  it("closes below the clear multiple, silently", () => {
    const r = opened();

    // 17.4 m against 10 m: 1.74×, just under 1.75×.
    expect(r.tick({ back: 7.4 })).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
    expect(r.hold({ back: 7.4 }, 3 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
  });

  it("stays open just above the clear multiple", () => {
    const r = opened();

    r.tick({ back: 7.6 }); // 1.76×
    expect(r.state.cautionCatchUpOpen).toBe(true);
  });

  it("gives a second drop-back a first call of its own, after a dwell of its own", () => {
    const r = opened();

    r.tick(CLOSED);

    expect(r.hold(OPEN, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([OPENED]);
    // …and its own two reminders.
    expect(r.hold(OPEN, 3 * CATCH_UP_REMINDER_MS + 500, 500).map(([event]) => event)).toEqual([STILL_OPEN, STILL_OPEN]);
  });
});

describe("the catch-up episode — reminders", () => {
  it("reminds every reminder interval while the gap sits open, twice, then never again", () => {
    const r = opened();

    expect(r.hold(OPEN, 5 * CATCH_UP_REMINDER_MS, 500)).toEqual([
      [STILL_OPEN, CATCH_UP_REMINDER_MS],
      [STILL_OPEN, 2 * CATCH_UP_REMINDER_MS],
    ]);
    expect(r.state.cautionCatchUpReminders).toBe(CATCH_UP_MAX_REMINDERS);
  });

  it("does not remind a driver who is closing — shorter by a pack spacing since the previous call", () => {
    const r = opened();

    // 40 m at the call; 29 m when the reminder comes due: more than a spacing closer.
    r.hold(OPEN, CATCH_UP_REMINDER_MS - 500, 500);
    expect(r.tick({ back: 19 }, 500)).toEqual([]);
    expect(r.state.cautionCatchUpReminders).toBe(0);
  });

  it("does remind one who has closed less than a pack spacing", () => {
    const r = opened();

    r.hold(OPEN, CATCH_UP_REMINDER_MS - 500, 500);
    // 40 m → 31 m: nine metres, against a 10 m pack.
    expect(r.tick({ back: 21 }, 500)).toEqual([STILL_OPEN]);
  });

  it("re-anchors on a skipped reminder: closing then, stalled since, he is reminded one interval later", () => {
    const r = opened();

    r.hold(OPEN, CATCH_UP_REMINDER_MS - 500, 500);
    expect(r.tick({ back: 19 }, 500)).toEqual([]); // closing: skipped
    // He stops at 29 m — 2.9×, still well off the pack, and still 11 m closer
    // than at the CALL. Judged against the skipped moment he is not closing.
    expect(r.hold({ back: 19 }, CATCH_UP_REMINDER_MS, 500)).toEqual([[STILL_OPEN, CATCH_UP_REMINDER_MS]]);
  });

  it("does not count a skipped reminder against the two", () => {
    const r = opened();

    r.hold(OPEN, CATCH_UP_REMINDER_MS - 500, 500);
    expect(r.tick({ back: 19 }, 500)).toEqual([]); // skipped

    expect(r.hold({ back: 19 }, 4 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([
      STILL_OPEN,
      STILL_OPEN,
    ]);
  });

  it("schedules the next reminder from the moment one fires, never from a missed due time — no burst after a stall", () => {
    const r = opened();

    // No tick at all for three and a half intervals: three reminders "missed".
    expect(r.tick(OPEN, 3.5 * CATCH_UP_REMINDER_MS)).toEqual([STILL_OPEN]);
    expect(r.hold(OPEN, CATCH_UP_REMINDER_MS - 500, 500)).toEqual([]);
    expect(r.tick(OPEN, 500)).toEqual([STILL_OPEN]);
  });

  it("does not fire before the interval is out", () => {
    const r = opened();

    expect(r.hold(OPEN, CATCH_UP_REMINDER_MS - 100)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([STILL_OPEN]);
  });
});

describe("the catch-up episode — the car ahead changing", () => {
  it("gives the new car a first call of its own exactly one dwell after the change, with its own reminders", () => {
    const r = opened();

    expect(r.state.cautionCatchUpFollowCarIdx).toBe(5);

    // Car 3 now holds the slot ahead; the gap is as open as it was.
    const behindCar3: World = { ...OPEN, ahead: 3 };

    // For a dwell the change is only a disturbance: the old car's episode is
    // suspended, intact, and the new car's dwell is being counted meanwhile.
    expect(r.hold(behindCar3, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.state.cautionCatchUpFollowCarIdx).toBe(5);
    expect(r.state.cautionCatchUpOpen).toBe(true);
    expect(r.state.cautionCatchUpCandidateCarIdx).toBe(3);

    // One dwell after the lineup first named car 3: the old episode ends and
    // the new car's first call is made, on the same tick — not a dwell later.
    expect(r.tick(behindCar3)).toEqual([OPENED]);
    expect(r.state.cautionCatchUpFollowCarIdx).toBe(3);
    expect(r.hold(behindCar3, 3 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([STILL_OPEN, STILL_OPEN]);
  });

  it("forgets the reminders already made for the old car — once the change has held, not before", () => {
    const r = opened();

    r.hold(OPEN, 2 * CATCH_UP_REMINDER_MS, 500);
    expect(r.state.cautionCatchUpReminders).toBe(2);

    r.tick({ ...OPEN, ahead: 3 });
    expect(r.state.cautionCatchUpReminders).toBe(2);

    r.hold({ ...OPEN, ahead: 3 }, CATCH_UP_DWELL_MS);
    expect(r.state.cautionCatchUpReminders).toBe(0);
    expect(r.state.cautionCatchUpFollowCarIdx).toBe(3);
  });

  it("waits one dwell from when the gap to the new car opens, if that is later than the change", () => {
    const r = opened();
    // Car 3 takes the slot ahead with the player right behind it: no gap to it yet.
    const closeBehindCar3: World = { ...CLOSED, ahead: 3 };
    const farBehindCar3: World = { ...OPEN, ahead: 3 };

    r.hold(closeBehindCar3, 1_000);
    // He drops back from car 3 a second after the change: one dwell from HERE.
    expect(r.hold(farBehindCar3, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.tick(farBehindCar3)).toEqual([OPENED]);
  });

  it("says nothing more about the old car when the new one is close ahead", () => {
    const r = opened();

    expect(r.hold({ ...CLOSED, ahead: 3 }, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });
});

describe("the catch-up episode — an ending condition has to hold before it ends anything", () => {
  /** An episode that has made its call and both reminders: nothing more is owed for this gap to this car. */
  function spent(): Rig {
    const r = opened();

    expect(r.hold(OPEN, 2 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([STILL_OPEN, STILL_OPEN]);

    return r;
  }

  it("does not start over when the car ahead is out of the world for one tick — six calls for one gap to one car", () => {
    // The reported failure. With car 5 gone for a tick the lineup names the
    // next car up, car 4; the episode used to reset on that tick and again on
    // the next, and three seconds later the driver got a second "first call"
    // and two more reminders.
    const r = spent();

    expect(r.tick({ ...OPEN, gone: [5] })).toEqual([]);
    expect(r.state.cautionCatchUpCandidateCarIdx).toBe(4);
    expect(r.hold(OPEN, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state).toMatchObject({
      cautionCatchUpOpen: true,
      cautionCatchUpFollowCarIdx: 5,
      cautionCatchUpReminders: 2,
      cautionCatchUpSuspendedSince: null,
      cautionCatchUpCandidateCarIdx: null,
    });
  });

  it("rides out a lineup that flickers for a second — the 1.07 s of the road capture", () => {
    const r = spent();

    for (let elapsed = 0; elapsed < 1_100; elapsed += 100) {
      expect(r.tick(elapsed % 200 === 0 ? { ...OPEN, gone: [5] } : { ...OPEN, ahead: 3 })).toEqual([]);
    }

    expect(r.hold(OPEN, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state.cautionCatchUpReminders).toBe(2);
  });

  it("keeps the reminder on the first call's clock through a flicker", () => {
    const r = opened();

    r.hold(OPEN, CATCH_UP_REMINDER_MS - 2_000, 500);
    r.hold({ ...OPEN, gone: [5] }, 1_000, 500);

    // One second of flicker inside the interval: the reminder is still due
    // thirty seconds after the call, not thirty-three after the flicker.
    expect(r.hold(OPEN, 1_000, 500)).toEqual([[STILL_OPEN, 1_000]]);
  });

  const SOFT: Array<[block: CatchUpBlock, world: World]> = [
    ["green-held", { ...OPEN, flags: STATIC | GREEN_HELD }],
    ["pit-road", { ...OPEN, onPitRoad: true }],
    ["procedure", { ...OPEN, paceFlags: 0x4 }],
    ["pace-car-off", { ...OPEN, paceCarSurface: TrkLoc.AproachingPits }],
    ["ahead-of-slot", { forward: 300 }],
  ];

  it.each(SOFT)("suspends on %s for a tick and resumes exactly as it was", (block, blocked) => {
    const r = spent();

    expect(isHardCatchUpBlock(block)).toBe(false);
    expect(r.tick(blocked)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(true);
    expect(r.state.cautionCatchUpSuspendedSince).not.toBeNull();

    expect(r.hold(OPEN, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state).toMatchObject({ cautionCatchUpOpen: true, cautionCatchUpReminders: 2 });
  });

  it.each(SOFT)("ends on %s once it has held for a dwell, and not a tick sooner", (_block, blocked) => {
    const r = spent();

    expect(r.hold(blocked, CATCH_UP_DWELL_MS)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(true);

    expect(r.tick(blocked)).toEqual([]);
    expect(r.state).toMatchObject({
      cautionCatchUpOpen: false,
      cautionCatchUpFollowCarIdx: null,
      cautionCatchUpReminders: 0,
    });
  });

  it.each(SOFT)("says nothing while %s lasts, however long", (_block, blocked) => {
    const r = opened();

    expect(r.hold(blocked, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
  });

  it("ends at once on a hard block — the caution over, or a green flying", () => {
    for (const hard of [
      { ...OPEN, flags: RACING },
      { ...OPEN, flags: STATIC | GREEN },
    ]) {
      const r = spent();

      r.tick(hard);
      expect(r.state).toMatchObject({ cautionCatchUpOpen: false, cautionCatchUpFollowCarIdx: null });
    }

    expect((["phase", "green", "settling", "pit-exit-grace"] as const).every(isHardCatchUpBlock)).toBe(true);
  });

  it("does not count a suspense across a stretch it could not see: the disturbance has to be OBSERVED to hold", () => {
    const r = spent();

    const blocked: World = { ...OPEN, paceCarSurface: TrkLoc.AproachingPits };

    // Blocked for a tick, then four seconds with no readable lineup, then
    // blocked again: two sightings, not a block that held for a dwell.
    r.tick(blocked);
    r.tick(OPEN, 2_000, null);
    r.tick(OPEN, 2_000, null);
    r.tick(blocked);

    expect(r.state.cautionCatchUpOpen).toBe(true);

    // The positive control: seen continuously from here, it ends a dwell later.
    r.hold(blocked, CATCH_UP_DWELL_MS);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });

  it("does not add separate blinks up into a disturbance that held — a judged tick between them starts the count again", () => {
    const r = spent();
    const blink: World = { ...OPEN, paceCarSurface: TrkLoc.AproachingPits };

    // A blink every half second for ten seconds, a good reading between each.
    for (let i = 0; i < 20; i++) {
      expect(r.tick(blink, 250)).toEqual([]);
      expect(r.tick(OPEN, 250)).toEqual([]);
    }

    expect(r.state).toMatchObject({ cautionCatchUpOpen: true, cautionCatchUpReminders: 2 });
  });

  it("bridges a one-tick flicker in a dwell that is still running — the first call is not put back", () => {
    const r = rig();

    r.caught();
    r.hold(OPEN, 1_500);
    r.tick({ ...OPEN, gone: [5] });

    // 1.5 s served, one tick away, 1.4 s more: the dwell completes on time.
    expect(r.hold(OPEN, CATCH_UP_DWELL_MS - 1_500)).toEqual([[OPENED, CATCH_UP_DWELL_MS - 1_500]]);
  });
});

describe("the catch-up episode — pit road", () => {
  it("says nothing while the player is on pit road, whatever the gap", () => {
    const r = rig();

    r.caught();

    expect(r.hold({ ...OPEN, onPitRoad: true }, 60_000, 500)).toEqual([]);
    expect(r.hold({ ...OPEN, onPitRoad: true, unlined: true }, 60_000, 500)).toEqual([]);
  });

  it("ends an open episode when he pits — once he has been on pit road for a dwell", () => {
    const r = opened();

    r.tick({ ...OPEN, onPitRoad: true });
    expect(r.state.cautionCatchUpOpen).toBe(true);
    expect(r.hold({ ...OPEN, onPitRoad: true }, 2 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });

  it("takes one tick on the pit lane's edge for neither a stop nor an exit", () => {
    const r = opened();

    r.tick({ ...OPEN, onPitRoad: true });
    r.tick(OPEN);

    // No pit-exit episode — which would silence the reminders — and the
    // ordinary one goes on where it was.
    expect(r.state.cautionCatchUpPitExitAt).toBeNull();
    expect(r.hold(OPEN, 2 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([STILL_OPEN, STILL_OPEN]);
  });

  describe("pit exit", () => {
    /** A rig with the player stopped in the pits under a settled caution, about to leave. */
    function inThePits(): Rig {
      const r = rig();

      r.caught();
      r.hold({ back: 300, onPitRoad: true, unlined: true }, 20_000, 500);

      return r;
    }

    /** Out of the pits a long way behind the tail: 310 m against a 10 m pack. */
    const REJOINED: World = { back: 300 };

    it("gives one call, after the grace and then the dwell", () => {
      const r = inThePits();

      // The exit tick starts the grace; the dwell starts on the first tick past it.
      expect(r.hold(REJOINED, 60_000)).toEqual([[OPENED, 100 + CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS]]);
    });

    it("judges nothing during the grace", () => {
      const r = inThePits();

      expect(r.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS)).toEqual([]);
      expect(r.state.cautionCatchUpRaisedSince).toBeNull();
    });

    it("gives no reminders — he is catching the field on purpose", () => {
      const r = inThePits();

      r.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS + 200);
      expect(r.state.cautionCatchUpOpen).toBe(true);
      expect(r.hold(REJOINED, 4 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    });

    it("waives the ahead-of-slot rule — the tail can be anywhere up the road after a stop", () => {
      const r = inThePits();
      // He rejoins 640 m behind the car he follows: over half a lap.
      const farBehind: World = { back: 630 };

      expect(r.hold(farBehind, 60_000).map(([event]) => event)).toEqual([OPENED]);
    });

    it("…which, for a car that never pitted, is silence — the positive control", () => {
      const r = rig();

      r.caught();
      expect(r.hold({ back: 630 }, 60_000, 500)).toEqual([]);
    });

    it("does not call again when the car ahead changes on the way round", () => {
      const r = inThePits();

      expect(r.hold(REJOINED, 20_000).map(([event]) => event)).toEqual([OPENED]);
      expect(r.hold({ ...REJOINED, ahead: 3 }, 60_000, 500)).toEqual([]);
    });

    it("is over once he has caught the field: a later drop-back is an ordinary one, reminders and all", () => {
      const r = inThePits();

      r.hold(REJOINED, 20_000);
      r.tick(CLOSED);
      expect(r.state.cautionCatchUpPitExitAt).toBeNull();

      expect(r.hold(OPEN, 3 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([
        OPENED,
        STILL_OPEN,
        STILL_OPEN,
      ]);
    });

    it("says nothing at all when he rejoins in place", () => {
      const r = inThePits();

      expect(r.hold(CLOSED, 60_000, 500)).toEqual([]);
      expect(r.state.cautionCatchUpPitExitAt).toBeNull();
    });

    it("starts over if he goes back onto pit road", () => {
      const r = inThePits();

      r.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS - 1_000);
      r.hold({ ...REJOINED, onPitRoad: true }, 5_000, 500);
      // A second exit: a full grace again.
      expect(r.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS)).toEqual([]);
      expect(r.tick(REJOINED)).toEqual([OPENED]);
    });

    it("is not opened by the diff's first sight of a car already off pit road", () => {
      // A seed is never an exit: the pit-road baseline starts unknown.
      const r = rig();

      r.caught();
      expect(r.state.cautionCatchUpPitExitAt).toBeNull();
    });
  });
});

describe("the catch-up episode — a drive-round procedure", () => {
  const FLAGS: Array<[name: string, bits: number]> = [
    ["EndOfLine", 0x1],
    ["FreePass", 0x2],
    ["WavedAround", 0x4],
  ];

  it.each(FLAGS)("%s suppresses the call while the car is on its way to its slot", (_name, bits) => {
    const r = rig();

    r.caught({ ...OPEN, paceFlags: bits });

    expect(r.hold({ ...OPEN, paceFlags: bits }, 120_000, 500)).toEqual([]);
    expect(r.state.cautionProcedureJoined).toBe(false);
  });

  it.each(FLAGS)("%s stops suppressing once he has taken his slot, though the flag stays set", (_name, bits) => {
    const r = rig();

    r.caught({ ...OPEN, paceFlags: bits });
    r.hold({ ...OPEN, paceFlags: bits }, 20_000, 500);

    // He reaches the tail: the gap reads under the clear multiple, flag and all.
    r.tick({ ...CLOSED, paceFlags: bits });
    expect(r.state.cautionProcedureJoined).toBe(true);

    // From here he is an ordinary car: a drop-back is called, and reminded.
    expect(r.hold({ ...OPEN, paceFlags: bits }, 2 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([
      OPENED,
      STILL_OPEN,
    ]);
  });

  it("does not take the band for the slot — joining needs the gap under the clear multiple", () => {
    const r = rig();

    r.caught({ ...OPEN, paceFlags: 0x4 });
    r.hold({ ...BAND, paceFlags: 0x4 }, 20_000, 500);

    expect(r.state.cautionProcedureJoined).toBe(false);
    expect(r.hold({ ...OPEN, paceFlags: 0x4 }, 60_000, 500)).toEqual([]);
  });

  it("registers the join while the caution still waves, where catch-up itself is not live", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING }); // seed
    r.tick({ ...OPEN, flags: WAVING, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(false);

    r.tick({ ...CLOSED, flags: WAVING, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(true);

    r.tick({ ...CLOSED, flags: STATIC, paceFlags: 0x4 }); // the pickup
    r.hold({ ...CLOSED, paceFlags: 0x4 }, CATCH_UP_SETTLE_MS);

    expect(r.hold({ ...OPEN, paceFlags: 0x4 }, 10_000).map(([event]) => event)).toEqual([OPENED]);
  });

  it("does not join on the tick the flag appears with the car still in its OLD slot — the reported failure", () => {
    // The flag is seen one tick before the rows move: at normal spacing
    // behind car 5, under the clear multiple, flag set. A latch set there
    // lifted the suppression for the whole drive round.
    const r = rig();

    r.caught();
    r.tick({ ...CLOSED, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(false);

    // The next tick his row is the tail's, and car 3 — put in the slot ahead
    // of him — is 400 m up the road: under half a lap, so not ahead of his slot.
    const onTheWay: World = { back: 390, ahead: 3, paceFlags: 0x4 };

    expect(r.hold(onTheWay, 60_000, 500)).toEqual([]);
    expect(r.state.cautionProcedureJoined).toBe(false);
    expect(resolveCatchUpBlocksOf(r, onTheWay)).toEqual(["procedure"]);

    // He arrives: the drive round was seen, and this is its end.
    r.tick({ ...CLOSED, ahead: 3, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(true);
    expect(r.hold({ ...OPEN, ahead: 3, paceFlags: 0x4 }, 10_000).map(([event]) => event)).toEqual([OPENED]);
  });

  it("joins a car that was at the tail all along once it has been in place behind ONE car for the settle window", () => {
    // The plugin started mid-caution with the player already there and still
    // carrying the flag. No drive round is ever seen; ten seconds in place is
    // what says there is none in progress.
    const r = rig();
    const inPlace: World = { ...CLOSED, paceFlags: 0x4 };

    r.tick({ ...inPlace, flags: STATIC }); // seed
    r.tick(inPlace); // caught, silently: the first reading in place
    r.hold(inPlace, CATCH_UP_SETTLE_MS - 100);
    expect(r.state.cautionProcedureJoined).toBe(false);

    r.tick(inPlace);
    expect(r.state.cautionProcedureJoined).toBe(true);

    // From here a drop-back is an ordinary one.
    expect(r.hold({ ...OPEN, paceFlags: 0x4 }, 10_000).map(([event]) => event)).toEqual([OPENED]);
  });

  it("joins the same way when the flag appears on a tick he is already in his slot and stays there — the same-tick control", () => {
    const r = rig();

    r.caught();
    r.hold({ ...CLOSED, paceFlags: 0x4 }, CATCH_UP_SETTLE_MS);
    expect(r.state.cautionProcedureJoined).toBe(false);

    r.tick({ ...CLOSED, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(true);
  });

  it("starts the in-place clock over when the car ahead changes, the gap leaves the clear multiple, or the reading drops out", () => {
    const inPlace: World = { ...CLOSED, paceFlags: 0x4 };
    const almost = (): Rig => {
      const r = rig();

      r.caught();
      r.hold(inPlace, CATCH_UP_SETTLE_MS - 1_000);

      return r;
    };
    const stillWaiting = (r: Rig): void => {
      // A second short of the window before the interruption, so two more
      // seconds would have joined him had the clock run on.
      r.hold(inPlace, 2_000);
      expect(r.state.cautionProcedureJoined).toBe(false);
      // …and a full window from the interruption does.
      r.hold(inPlace, CATCH_UP_SETTLE_MS);
      expect(r.state.cautionProcedureJoined).toBe(true);
    };

    // Another car ahead.
    const moved = almost();

    moved.tick({ ...CLOSED, ahead: 3, paceFlags: 0x4 });
    moved.tick(inPlace);
    stillWaiting(moved);

    // The band: neither away nor in place.
    const drifted = almost();

    drifted.tick({ ...BAND, paceFlags: 0x4 });
    drifted.tick(inPlace);
    stillWaiting(drifted);

    // No reading for longer than the tolerance.
    const dropped = almost();

    dropped.tick(inPlace, CATCH_UP_UNJUDGED_TOLERANCE_MS + 500, null);
    dropped.tick(inPlace);
    stillWaiting(dropped);
  });

  it("bridges one dropped reading in the in-place clock", () => {
    const r = rig();
    const inPlace: World = { ...CLOSED, paceFlags: 0x4 };

    r.caught();
    r.hold(inPlace, CATCH_UP_SETTLE_MS - 1_000);
    r.tick(inPlace, 100, null);
    r.hold(inPlace, 1_000);

    expect(r.state.cautionProcedureJoined).toBe(true);
  });

  it("counts a car ahead of its slot as away, like one far behind it", () => {
    const r = rig();

    r.caught();
    r.tick({ forward: 300, paceFlags: 0x4 });
    expect(r.state.cautionProcedureAwaySeen).toBe(true);

    r.tick({ ...CLOSED, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(true);
  });

  it("forgets what it observed when the flag drops — the next flag is a procedure of its own", () => {
    const r = rig();

    r.caught();
    r.tick({ ...OPEN, paceFlags: 0x4 });
    expect(r.state.cautionProcedureAwaySeen).toBe(true);

    r.tick(OPEN);
    expect(r.state.cautionProcedureAwaySeen).toBe(false);

    // Flagged again, in place: no drive round seen under THIS flag.
    r.tick({ ...CLOSED, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(false);
  });

  it("never sets the latch for a car that carries no flag", () => {
    const r = rig();

    r.caught();
    r.hold(CLOSED, 5_000, 500);

    expect(r.state.cautionProcedureJoined).toBe(false);
  });

  it("clears the latch with the caution, so the next one starts unjoined", () => {
    const r = rig();

    r.caught({ ...CLOSED, paceFlags: 0x4 });
    expect(r.state.cautionProcedureJoined).toBe(true);

    r.tick({ flags: RACING });
    expect(r.state.cautionProcedureJoined).toBe(false);
    expect(r.state.cautionCaughtAt).toBeNull();
  });
});

describe("the catch-up episode — ahead of your slot", () => {
  it("is silent when the car to follow is nearer behind than ahead, with no flag set", () => {
    // He has driven 300 m on round: the car he follows is 710 m forward, 290 m back.
    const r = rig();

    r.caught();

    expect(r.hold({ forward: 300 }, 120_000, 500)).toEqual([]);
  });

  it("ends an open episode once it has been true for a dwell", () => {
    const r = opened();

    r.tick({ forward: 300 });
    expect(r.state.cautionCatchUpOpen).toBe(true);

    r.hold({ forward: 300 }, CATCH_UP_DWELL_MS);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });
});

describe("the catch-up episode — the pace car leaving", () => {
  it("is silent once the pace car is off the track surface, however open the gap", () => {
    const r = rig();

    r.caught();

    for (const paceCarSurface of [TrkLoc.AproachingPits, TrkLoc.InPitStall]) {
      expect(r.hold({ ...OPEN, paceCarSurface }, 60_000, 500), TrkLoc[paceCarSurface]).toEqual([]);
    }
  });

  it("ends an open episode — no reminder follows the pace car off", () => {
    const r = opened();

    r.hold(OPEN, CATCH_UP_REMINDER_MS - 1_000, 500);

    // The reminder that was a second away is never made.
    expect(r.hold({ ...OPEN, paceCarSurface: TrkLoc.AproachingPits }, 60_000, 500)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });
});

describe("the catch-up episode — the phases", () => {
  it("is silent while the caution waves", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING }); // seed
    expect(r.hold({ ...OPEN, flags: WAVING }, 120_000, 500)).toEqual([]);
  });

  it("is silent under green, and outside a caution reads no lineup at all", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING }); // seed
    expect(r.hold({ ...OPEN, flags: RACING }, 60_000, 500)).toEqual([]);
    expect(r.hold({ ...OPEN, flags: RACING | GREEN }, 60_000, 500)).toEqual([]);
    expect(vi.mocked(resolvePaceLineup)).not.toHaveBeenCalled();
  });

  it("does not stop at one to green — the last caution lap is when being in place matters", () => {
    const r = rig();

    r.caught();
    r.tick({ flags: ONE_TO_GO });

    expect(r.hold({ ...OPEN, flags: ONE_TO_GO }, 2 * CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([
      OPENED,
      STILL_OPEN,
    ]);
  });

  it("evaluates nothing on a yellow-checkered tick — a Green bit with a caution bit still set", () => {
    const r = opened();
    const before = vi.mocked(resolvePaceLineup).mock.calls.length;

    // The phase survives (a caution bit is set), and no lineup is resolved.
    expect(r.hold({ ...OPEN, flags: STATIC | GREEN }, 2 * CATCH_UP_REMINDER_MS, 500)).toEqual([]);
    expect(r.state.cautionPhase).toBe("caught");
    expect(vi.mocked(resolvePaceLineup).mock.calls.length).toBe(before);
    // …and the open episode ended there, without closing.
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });

  it("is silent while the green is held — the pace car may pull away on purpose, and the green-held line owns the moment", () => {
    const r = rig();

    r.caught();
    r.tick({ flags: ONE_TO_GO });

    expect(r.hold({ ...OPEN, flags: ONE_TO_GO | GREEN_HELD }, 60_000, 500)).toEqual([]);
    expect(resolveCatchUpBlocksOf(r, { ...OPEN, flags: ONE_TO_GO | GREEN_HELD })).toEqual(["green-held"]);
  });

  it("is silent under a held green for the front of the field too — the leader dropping off the pace car", () => {
    const leader = { DriverInfo: { DriverCarIdx: 1, PaceCarIdx: PACE, Drivers: [] } };
    const r = rig();
    // The whole field 60 m further back from the pace car: the leader at 80 m, 4× his 20 m.
    const dropped: World = { back: 60, backFrom: 1 };
    const feed = (w: World, ms: number): string[] => {
      const out: string[] = [];

      for (let elapsed = 0; elapsed < ms; elapsed += 500) out.push(...r.tick(w, 500, leader));

      return out;
    };

    feed({ flags: RACING }, 500);
    feed({ flags: WAVING }, 500);
    feed({}, CATCH_UP_SETTLE_MS + 500);

    expect(feed({ ...dropped, flags: STATIC | GREEN_HELD }, 60_000)).toEqual([]);
    // The positive control: the same gap with no green held is called.
    expect(feed(dropped, 10_000)).toEqual([OPENED]);
  });

  it("ends with the caution: the restart leaves nothing open", () => {
    const r = opened();

    r.tick({ ...OPEN, flags: RACING | GREEN });

    expect(r.state.cautionPhase).toBe("none");
    expect(r.state.cautionCatchUpOpen).toBe(false);
    expect(r.state.cautionCatchUpRaisedSince).toBeNull();
  });
});

describe("the catch-up episode — one lineup resolution per tick", () => {
  it("resolves the lineup exactly once on a live tick, for diffLineup and diffCatchUp together", () => {
    const r = rig();

    r.caught();
    vi.mocked(resolvePaceLineup).mockClear();

    r.hold(OPEN, CATCH_UP_DWELL_MS + 500);

    // One per tick, through a dwell, an opening and its aftermath.
    expect(vi.mocked(resolvePaceLineup)).toHaveBeenCalledTimes((CATCH_UP_DWELL_MS + 500) / 100);
  });

  it("resolves none on the seed tick, under green, or with no caution out", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: STATIC }); // the seed, a caution already out
    expect(vi.mocked(resolvePaceLineup)).not.toHaveBeenCalled();

    r.tick({ ...OPEN, flags: STATIC }); // caught, silently
    expect(vi.mocked(resolvePaceLineup)).toHaveBeenCalledTimes(1);

    r.tick({ ...OPEN, flags: STATIC | GREEN });
    r.tick({ ...OPEN, flags: RACING });
    expect(vi.mocked(resolvePaceLineup)).toHaveBeenCalledTimes(1);
  });

  it("measures on the lineup it was handed — the measurement resolves none of its own", () => {
    const telemetry = world(OPEN);
    const lineup = resolvePaceLineup(telemetry, INFO, false);

    vi.mocked(resolvePaceLineup).mockClear();
    measureCautionGap(telemetry, INFO, lineup as NonNullable<typeof lineup>, LAP);

    expect(vi.mocked(resolvePaceLineup)).not.toHaveBeenCalled();
  });
});

describe("the catch-up episode — the settle window", () => {
  it("judges nothing for the settle window after the pickup, then runs the dwell", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING }); // seed
    r.tick({ ...OPEN, flags: WAVING });
    r.tick({ ...OPEN, flags: STATIC }); // the pickup: the settle clock starts here

    // The gap was open all along. The first call lands settle + dwell after
    // the pickup — the dwell starts on the first tick past the window.
    expect(r.hold(OPEN, 20_000)).toEqual([[OPENED, CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS]]);
  });

  it("starts the dwell only once the window is out", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING });
    r.tick({ ...OPEN, flags: WAVING });
    r.tick({ ...OPEN, flags: STATIC });
    r.hold(OPEN, CATCH_UP_SETTLE_MS - 100);

    expect(r.state.cautionCatchUpRaisedSince).toBeNull();
  });

  it("settles from a caution that arrives already static, too", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: RACING }); // seed
    r.tick({ ...OPEN, flags: STATIC }); // caught without ever waving

    expect(r.hold(OPEN, 20_000)).toEqual([[OPENED, CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS]]);
  });

  it("does not start the window over when one to go is withdrawn and the phase returns to caught", () => {
    const r = rig();

    r.caught();
    r.tick({ flags: ONE_TO_GO });
    r.tick({ flags: STATIC });

    expect(r.hold(OPEN, 10_000).map(([event]) => event)).toEqual([OPENED]);
  });
});

describe("the catch-up episode — re-seeding (level-armed, not edge-armed)", () => {
  it("emits nothing on the seed tick, with a caution out and the gap wide open", () => {
    const r = rig();

    expect(r.tick({ ...OPEN, flags: STATIC })).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
    expect(r.state.cautionCatchUpLastOnPitRoad).toBeNull();
  });

  it("finds a gap that was open before the plugin started — settle, dwell, call", () => {
    const r = rig();

    r.tick({ ...OPEN, flags: STATIC }); // seed
    r.tick({ ...OPEN, flags: STATIC }); // caught, silently: the settle clock starts

    expect(r.hold(OPEN, 20_000)).toEqual([[OPENED, CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS]]);
  });

  it("re-derives the episode after a replay wipe within one dwell, keeping the phase's own two fields", () => {
    const r = opened();

    r.hold(OPEN, 2 * CATCH_UP_REMINDER_MS, 500);
    expect(r.state.cautionCatchUpReminders).toBe(2);

    // What `wipeStateForReplay` hands the first tick back: a fresh state with
    // the phase, the pickup's time and the drive-round latch carried over, and
    // the whole episode gone.
    const back = rig();

    back.state.cautionPhase = r.state.cautionPhase;
    back.state.cautionCaughtAt = back.now() - 60_000;
    back.state.cautionProcedureJoined = r.state.cautionProcedureJoined;

    expect(back.tick(OPEN)).toEqual([]); // the seed
    // No settle window again: the dwell, then a FRESH first call — the cost the
    // design accepts for a driver who had already been reminded twice.
    expect(back.hold(OPEN, 20_000)).toEqual([[OPENED, CATCH_UP_DWELL_MS + 100]]);
  });

  it("keeps a waved-around car that has joined ordinary across the wipe, and one that has not suppressed", () => {
    for (const joined of [true, false]) {
      const back = rig();

      back.state.cautionPhase = "caught";
      back.state.cautionCaughtAt = back.now() - 60_000;
      back.state.cautionProcedureJoined = joined;

      back.tick({ ...OPEN, paceFlags: 0x4 }); // the seed

      expect(
        back.hold({ ...OPEN, paceFlags: 0x4 }, 20_000).map(([event]) => event),
        `joined: ${joined}`,
      ).toEqual(joined ? [OPENED] : []);
    }
  });

  it("drops both carried fields on the seed when the caution ended during the glance", () => {
    const back = rig();

    back.state.cautionPhase = "caught";
    back.state.cautionCaughtAt = back.now() - 60_000;
    back.state.cautionProcedureJoined = true;

    back.tick({ flags: RACING }); // the seed: no caution bit, so the phase expires

    expect(back.state.cautionPhase).toBe("none");
    expect(back.state.cautionProcedureJoined).toBe(false);
    expect(back.state.cautionCaughtAt).toBeNull();
  });
});

describe("the catch-up episode — a tick that cannot be judged is a gap, not an end", () => {
  it("holds an open episode through a tick whose lineup cannot be read — no second first call", () => {
    const r = opened();

    // No session info for a tick: the lineup reader answers nothing.
    expect(r.tick(OPEN, 100, null)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(true);

    // The reminder still comes on the first call's clock; no fresh "first call".
    expect(r.hold(OPEN, CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([STILL_OPEN]);
  });

  it("holds an open episode through a tick whose gap cannot be measured, the lineup read and all", () => {
    const r = opened();
    const calls = vi.mocked(resolvePaceLineup).mock.calls.length;

    // The lineup resolves — the player still follows car 5 — and there is no
    // lap distance to measure anything with.
    expect(r.tick({ ...OPEN, noLapDistance: true })).toEqual([]);
    expect(vi.mocked(resolvePaceLineup).mock.calls.length).toBe(calls + 1);
    expect(r.state.cautionCatchUpOpen).toBe(true);
    expect(r.state.cautionCatchUpFollowCarIdx).toBe(5);

    expect(r.hold(OPEN, CATCH_UP_REMINDER_MS, 500).map(([event]) => event)).toEqual([STILL_OPEN]);
  });

  it("makes a reminder that came due during a long hold on the first tick that can judge again — on a real reading", () => {
    const r = opened();

    // Forty seconds with no readable lineup: the reminder came due ten seconds ago.
    for (let elapsed = 0; elapsed < 40_000; elapsed += 500) expect(r.tick(OPEN, 500, null)).toEqual([]);

    expect(r.state).toMatchObject({ cautionCatchUpOpen: true, cautionCatchUpReminders: 0 });
    // The gap is read, it is still open and he is not closing: the reminder is made.
    expect(r.tick(OPEN)).toEqual([STILL_OPEN]);
    // And one more, an interval after THAT, not a burst.
    expect(r.hold(OPEN, CATCH_UP_REMINDER_MS - 100)).toEqual([]);
    expect(r.tick(OPEN)).toEqual([STILL_OPEN]);
  });

  it("makes no reminder on that tick if he closed up during the hold", () => {
    const r = opened();

    for (let elapsed = 0; elapsed < 40_000; elapsed += 500) r.tick(OPEN, 500, null);

    expect(r.tick(CLOSED)).toEqual([]);
    expect(r.state.cautionCatchUpOpen).toBe(false);
  });

  it("holds a running dwell through one of those too", () => {
    const r = rig();

    r.caught();
    r.hold(OPEN, 1_000);

    const since = r.state.cautionCatchUpRaisedSince;

    expect(since).not.toBeNull();
    r.tick({ ...OPEN, noLapDistance: true });
    expect(r.state.cautionCatchUpRaisedSince).toBe(since);
  });

  it("holds a running dwell through one, without counting it as open or as closed", () => {
    const r = rig();

    r.caught();
    r.hold(OPEN, 1_000);

    const since = r.state.cautionCatchUpRaisedSince;

    r.tick(OPEN, 100, null);
    expect(r.state.cautionCatchUpRaisedSince).toBe(since);
  });

  it("says nothing with too few cars for a spacing — a field of five", () => {
    // Five cars with the player last and 40 m off the car ahead: three pairs
    // beside his own, one short of a reading.
    const five: World = { cars: 5, back: 30, backFrom: 5 };
    const lastOfFive = { DriverInfo: { DriverCarIdx: 5, PaceCarIdx: PACE, Drivers: [] } };
    const small = rig();

    for (let i = 0; i < 600; i++) {
      expect(small.tick({ ...five, flags: i === 0 ? RACING : STATIC }, 100, lastOfFive)).toEqual([]);
    }

    expect(small.state.cautionPhase).toBe("caught");

    // The positive control: one car more gives four pairs, and the same drop is called.
    const six: World = { cars: 6, back: 30 };
    const r = rig();

    r.caught({ cars: 6 });
    expect(r.hold(six, 10_000).map(([event]) => event)).toEqual([OPENED]);
  });

  it("says nothing without a track length", () => {
    const r = rig(null);

    r.caught();

    expect(r.hold(OPEN, 60_000, 500)).toEqual([]);
  });
});

describe("the catch-up episode — the state is in place before an event is emitted", () => {
  it("reads live and at or above the clear multiple from inside the emit of both events", () => {
    const state = createInitialState();
    let now = 9_000_000;
    const atEmit: Array<Record<string, unknown>> = [];

    const tick = (w: World, ms = 500): void => {
      now += ms;

      const telemetry = world(w);

      diffCaution(
        state,
        telemetry,
        INFO,
        null,
        (e) => {
          if (e.event !== OPENED && e.event !== STILL_OPEN) return;

          const lineup = resolvePaceLineup(telemetry, INFO, false);
          const measurement = measureCautionGap(telemetry, INFO, lineup as NonNullable<typeof lineup>, LAP);

          atEmit.push({
            event: e.event,
            open: state.cautionCatchUpOpen,
            blocks: resolveCatchUpBlocks(state, telemetry, measurement, now),
            aboveClear: (measurement.ratio as number) >= CATCH_UP_CLEAR_MULTIPLE,
          });
        },
        { now, trackLengthMeters: LAP },
      );
    };

    tick({ flags: RACING });
    tick({ flags: WAVING });
    tick({ flags: STATIC });

    for (
      let elapsed = 0;
      elapsed < CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS + CATCH_UP_REMINDER_MS + 2_000;
      elapsed += 500
    ) {
      tick(OPEN);
    }

    expect(atEmit).toEqual([
      { event: OPENED, open: true, blocks: [], aboveClear: true },
      { event: STILL_OPEN, open: true, blocks: [], aboveClear: true },
    ]);
  });
});

describe("resolveCatchUpBlocks — why catch-up cannot be judged", () => {
  /** A state in a settled caught phase, `now` a minute after the pickup. */
  function settled(): { state: TranslatorState; now: number } {
    const state = createInitialState();
    const now = 7_000_000;

    state.cautionPhase = "caught";
    state.cautionCaughtAt = now - 60_000;

    return { state, now };
  }

  function blocks(w: World, prepare: (state: TranslatorState, now: number) => void = () => {}): string[] {
    const { state, now } = settled();
    const telemetry = world(w);
    const lineup = resolvePaceLineup(telemetry, INFO, false);

    prepare(state, now);

    return resolveCatchUpBlocks(
      state,
      telemetry,
      measureCautionGap(telemetry, INFO, lineup as NonNullable<typeof lineup>, LAP),
      now,
    );
  }

  it("is empty when catch-up is live", () => {
    expect(blocks(OPEN)).toEqual([]);
    expect(blocks(CLOSED)).toEqual([]);
  });

  it("names each reason on its own", () => {
    expect(blocks(OPEN, (state) => (state.cautionPhase = "waving"))).toEqual(["phase"]);
    expect(blocks(OPEN, (state) => (state.cautionPhase = "none"))).toEqual(["phase"]);
    expect(blocks({ ...OPEN, flags: STATIC | GREEN })).toEqual(["green"]);
    expect(blocks({ ...OPEN, flags: STATIC | GREEN_HELD })).toEqual(["green-held"]);
    expect(blocks(OPEN, (state, now) => (state.cautionCaughtAt = now - CATCH_UP_SETTLE_MS + 1))).toEqual(["settling"]);
    expect(blocks({ ...OPEN, paceCarSurface: TrkLoc.AproachingPits })).toEqual(["pace-car-off"]);
    expect(blocks({ ...OPEN, onPitRoad: true })).toEqual(["pit-road"]);
    expect(blocks(OPEN, (state, now) => (state.cautionCatchUpPitExitAt = now - 1_000))).toEqual(["pit-exit-grace"]);
    expect(blocks({ ...OPEN, paceFlags: 0x4 })).toEqual(["procedure"]);
    expect(blocks({ forward: 300 })).toEqual(["ahead-of-slot"]);
  });

  it("lifts each one when its own condition clears — the positive controls", () => {
    expect(blocks(OPEN, (state) => (state.cautionPhase = "one-to-go"))).toEqual([]);
    expect(blocks(OPEN, (state, now) => (state.cautionCaughtAt = now - CATCH_UP_SETTLE_MS))).toEqual([]);
    expect(blocks(OPEN, (state, now) => (state.cautionCatchUpPitExitAt = now - CATCH_UP_PIT_EXIT_GRACE_MS))).toEqual(
      [],
    );
    expect(blocks({ ...OPEN, paceFlags: 0x4 }, (state) => (state.cautionProcedureJoined = true))).toEqual([]);
    // Ahead of the slot is waived inside a pit-exit episode, grace over.
    expect(
      blocks({ forward: 300 }, (state, now) => (state.cautionCatchUpPitExitAt = now - CATCH_UP_PIT_EXIT_GRACE_MS)),
    ).toEqual([]);
  });

  it("treats a caught phase with no pickup time as still settling, never as settled", () => {
    expect(blocks(OPEN, (state) => (state.cautionCaughtAt = null))).toEqual(["settling"]);
  });
});

// ── The captures ───────────────────────────────────────────────────────────

type SnapshotTick = {
  snapshot?: string;
  SessionFlags: number;
  OnPitRoad?: boolean;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxPaceFlags: number[];
  CarIdxLapDistPct: number[];
  CarIdxTrackSurface: number[];
};

function readTicks(name: string): SnapshotTick[] {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as SnapshotTick[];
}

/** A fixture tick widened back to real telemetry: slot 20 is the pace car, raw index 64. */
function widened(tick: SnapshotTick): TelemetryData {
  const widen = (values: number[], fill: number): number[] => {
    const out = new Array(72).fill(fill);

    values.forEach((v, i) => (out[i === 20 ? PACE : i] = v));

    return out;
  };

  return {
    SessionFlags: tick.SessionFlags,
    OnPitRoad: tick.OnPitRoad ?? false,
    CarIdxPaceLine: widen(tick.CarIdxPaceLine, -1),
    CarIdxPaceRow: widen(tick.CarIdxPaceRow, -1),
    CarIdxPaceFlags: widen(tick.CarIdxPaceFlags, 0).map((flags) => Math.max(flags, 0)),
    CarIdxLapDistPct: widen(tick.CarIdxLapDistPct, -1),
    CarIdxTrackSurface: widen(tick.CarIdxTrackSurface, TrkLoc.NotInWorld),
  } as unknown as TelemetryData;
}

describe("the catch-up episode — the Homestead snapshots, held still", () => {
  const HOMESTEAD = 2381.5;
  const SNAPSHOT_INFO: Record<string, unknown> = { DriverInfo: { DriverCarIdx: 0, PaceCarIdx: PACE, Drivers: [] } };
  const gapTicks = readTicks("caution-gap-20260919.json");
  const [oneToGo] = readTicks("caution-lineup-20260919.json");
  const named = (name: string): SnapshotTick => {
    const tick = gapTicks.find((candidate) => candidate.snapshot === name);

    if (!tick) throw new Error(`no snapshot ${name}`);

    return tick;
  };

  /** The same snapshot on every tick for two minutes: what the machine says about a field frozen there. */
  function heldStill(tick: SnapshotTick): { events: string[]; state: TranslatorState } {
    const state = createInitialState();
    const telemetry = widened(tick);
    const events: string[] = [];
    let now = 3_000_000;

    for (let elapsed = 0; elapsed <= 120_000; elapsed += 500) {
      now += 500;
      diffCaution(
        state,
        telemetry,
        SNAPSHOT_INFO,
        null,
        (e) => {
          if (e.event === OPENED || e.event === STILL_OPEN) events.push(e.event);
        },
        { now, trackLengthMeters: HOMESTEAD },
      );
    }

    return { events, state };
  }

  it("calls 093300 and 093306 — dropped back at 4.7× and 3.4× — and reminds twice", () => {
    for (const name of ["20260919-093300", "20260919-093306"]) {
      expect(heldStill(named(name)).events, name).toEqual([OPENED, STILL_OPEN, STILL_OPEN]);
    }
  });

  it("says nothing for 131947 and 094304 — in place at 1.2× and 1.3×", () => {
    expect(heldStill(named("20260919-131947")).events).toEqual([]);
    expect(heldStill(oneToGo).events).toEqual([]);
  });

  it("takes 094304's waved-around player, at the tail at normal spacing, for a car that has joined", () => {
    // The flag is still set; the gap says he has taken his slot.
    expect(heldStill(oneToGo).state.cautionProcedureJoined).toBe(true);
  });

  it("says nothing for 094029, for three independent reasons at once", () => {
    const tick = named("20260919-094029");
    const { events, state } = heldStill(tick);

    expect(events).toEqual([]);
    // The caution is waving, he carries WavedAround and has not joined, and
    // his tail car is 0.76 of a lap forward.
    expect(state.cautionPhase).toBe("waving");
    expect(state.cautionProcedureJoined).toBe(false);

    const telemetry = widened(tick);
    const lineup = resolvePaceLineup(telemetry, SNAPSHOT_INFO, true);
    const measurement = measureCautionGap(telemetry, SNAPSHOT_INFO, lineup as NonNullable<typeof lineup>, HOMESTEAD);

    expect(resolveCatchUpBlocks(state, telemetry, measurement, 4_000_000)).toEqual([
      "phase",
      "procedure",
      "ahead-of-slot",
    ]);
  });

  it("is silenced by each of those three alone: the same tick with the other two taken away", () => {
    const tick = named("20260919-094029");
    const telemetry = widened(tick);
    const lineup = resolvePaceLineup(telemetry, SNAPSHOT_INFO, true) as NonNullable<
      ReturnType<typeof resolvePaceLineup>
    >;
    const measurement = measureCautionGap(telemetry, SNAPSHOT_INFO, lineup, HOMESTEAD);
    const now = 4_000_000;
    /** A state in which nothing but what the test leaves in place blocks: caught, settled, joined. */
    const clear = (): TranslatorState => {
      const state = createInitialState();

      state.cautionPhase = "caught";
      state.cautionCaughtAt = now - 60_000;
      state.cautionProcedureJoined = true;

      return state;
    };
    const inSlot = { ...measurement, aheadOfSlot: false };
    const waving = clear();
    const unjoined = clear();

    waving.cautionPhase = "waving";
    unjoined.cautionProcedureJoined = false;

    // The waving caution alone.
    expect(resolveCatchUpBlocks(waving, telemetry, inSlot, now)).toEqual(["phase"]);
    // The procedure alone.
    expect(resolveCatchUpBlocks(unjoined, telemetry, inSlot, now)).toEqual(["procedure"]);
    // Ahead of his slot alone.
    expect(resolveCatchUpBlocks(clear(), telemetry, measurement, now)).toEqual(["ahead-of-slot"]);
    // And with all three taken away, nothing blocks — the control.
    expect(resolveCatchUpBlocks(clear(), telemetry, inSlot, now)).toEqual([]);
  });
});
