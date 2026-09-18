import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { resolveCautionLineup } from "./caution-lineup.js";
import { diffCaution, LAST_LAP_CHECKPOINT_PCT } from "./caution.js";
import type { PendingEvent } from "./types.js";

const ticks = JSON.parse(
  readFileSync(new URL("./__fixtures__/caution-restart-20260917.json", import.meta.url), "utf-8"),
) as Array<{
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxLapCompleted: number[];
  CarIdxTrackSurface: number[];
}>;

/** The road-course capture, cut the same way — see `__fixtures__/README.md`. */
const roadTicks = JSON.parse(
  readFileSync(new URL("./__fixtures__/caution-road-20260918.json", import.meta.url), "utf-8"),
) as typeof ticks;

const PACE = 64;
const sessionInfo = { DriverInfo: { PaceCarIdx: PACE, Drivers: [] } } as Record<string, unknown>;

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

/** A tick where only the pace car's surface matters. 3 = OnTrack, 2 = AproachingPits. */
function paceTick(surface: number): TelemetryData {
  const arr = new Array(72).fill(3);
  arr[PACE] = surface;

  return { SessionFlags: 0, SessionState: 4, CarIdxTrackSurface: arr } as unknown as TelemetryData;
}

/**
 * A fixture tick widened back to real telemetry: the capture trimmed the car
 * slots to the 20 cars at their own indices plus the pace car (index 64 in the
 * raw telemetry) appended as slot 20, so every per-car array is rebuilt at 72
 * slots with slot 20 written back to {@link PACE}.
 */
function replayTick(tick: (typeof ticks)[number]): TelemetryData {
  const surfaces = new Array(72).fill(3);
  const lines = new Array(72).fill(-1);
  const rows = new Array(72).fill(-1);
  const laps = new Array(72).fill(-1);

  tick.CarIdxTrackSurface.forEach((v, i) => (surfaces[i === 20 ? PACE : i] = v));
  tick.CarIdxPaceLine.forEach((v, i) => (lines[i === 20 ? PACE : i] = v));
  tick.CarIdxPaceRow.forEach((v, i) => (rows[i === 20 ? PACE : i] = v));
  tick.CarIdxLapCompleted.forEach((v, i) => (laps[i === 20 ? PACE : i] = v));

  return {
    ...tick,
    CarIdxTrackSurface: surfaces,
    CarIdxPaceLine: lines,
    CarIdxPaceRow: rows,
    CarIdxLapCompleted: laps,
  } as unknown as TelemetryData;
}

/** `SessionFlags` values lifted verbatim from the capture. */
const RACING = 0x10040000; // Servicible|StartHidden — green-flag running
const WAVING = 0x10048000; // +CautionWaving — the caution is thrown
const STATIC = 0x10044000; // +Caution — the pace car has the field
const ONE_TO_GO = 0x10044200; // +OneLapToGreen
const GREEN_HELD = 0x10044600; // +GreenHeld — 15 s before the green
const RESTART = 0x80040004 | 0; // Green|Servicible|StartGo — StartGo is the sign bit

/** A tick where only the flags matter; the pace car stays on track throughout. */
function flagTick(flags: number, extra: Record<string, unknown> = {}): TelemetryData {
  return {
    SessionFlags: flags,
    SessionState: 4,
    CarIdxTrackSurface: new Array(72).fill(3),
    ...extra,
  } as unknown as TelemetryData;
}

/**
 * A caution lineup: each car's pace row, pace line and scored laps. Rows are
 * numbered PER LINE, so two cars share a row number once the field re-forms
 * double file — which is why the line belongs in every entry.
 */
function lineup(
  ...cars: Array<[carIdx: number, row: number, line: number, lapCompleted: number]>
): Record<string, unknown> {
  const rows = new Array(72).fill(-1);
  const lines = new Array(72).fill(-1);
  const laps = new Array(72).fill(-1);

  for (const [carIdx, row, line, lapCompleted] of cars) {
    rows[carIdx] = row;
    lines[carIdx] = line;
    laps[carIdx] = lapCompleted;
  }

  return { CarIdxPaceRow: rows, CarIdxPaceLine: lines, CarIdxLapCompleted: laps };
}

/** The single-file shorthand: one car at the front of the lineup, on the inside line. */
function leader(carIdx: number, lapCompleted: number): Record<string, unknown> {
  return lineup([carIdx, 1, 0, lapCompleted]);
}

/**
 * Session info that also names the PLAYER, which the lineup half needs and the
 * episode half does not — hence the default `sessionInfo` above naming no
 * driver, so every test that predates the lineup keeps reading no lineup at all.
 */
function playerSessionInfo(
  playerCarIdx: number,
  options: { drivers?: Array<Record<string, unknown>>; oval?: boolean; paceCar?: boolean } = {},
): Record<string, unknown> {
  const driverInfo: Record<string, unknown> = {
    DriverCarIdx: playerCarIdx,
    Drivers: options.drivers ?? [],
  };

  if (options.paceCar !== false) driverInfo.PaceCarIdx = PACE;

  return {
    WeekendInfo: { TrackType: options.oval === false ? "road course" : "medium oval" },
    DriverInfo: driverInfo,
  };
}

/** A canonical race order (position per carIdx, 0 = unranked) naming `carIdx` the leader. */
function canonicalLeader(carIdx: number): number[] {
  const positions = new Array(72).fill(0);

  positions[carIdx] = 1;

  return positions;
}

describe("pace car edges", () => {
  it("emits paceCar.deployed when the pace car reaches the track", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(1), sessionInfo, null, emit); // seed: in its stall
    diffCaution(state, paceTick(3), sessionInfo, null, emit);

    expect(events).toEqual([{ event: "paceCar.deployed", data: {} }]);
  });

  it("emits paceCar.off when it heads for the pits", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(3), sessionInfo, null, emit); // seed: on track
    diffCaution(state, paceTick(2), sessionInfo, null, emit);

    expect(events).toEqual([{ event: "paceCar.off", data: {} }]);
  });

  it("says nothing on the first tick, whatever the pace car is doing", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(3), sessionInfo, null, emit);

    expect(events).toEqual([]);
  });

  it("keeps its baseline through a tick that cannot read the pace car, so an edge straddling the gap still reports", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(3), sessionInfo, null, emit); // seed: on track
    // Session info drops out for a tick — nothing names the pace car, so the
    // surface is unreadable. That is a gap, not a reading: a baseline written
    // to null here would make the next tick a fresh seed and swallow the edge.
    diffCaution(state, paceTick(3), null, null, emit);
    diffCaution(state, paceTick(2), sessionInfo, null, emit); // heads for the pits

    expect(events).toEqual([{ event: "paceCar.off", data: {} }]);
  });

  it("matches the captured pace-car edges: deployed twice, off twice", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    for (const tick of ticks) {
      diffCaution(state, replayTick(tick), sessionInfo, null, emit);
    }

    // The fixture window starts at t=218.88, AFTER the rolling start's own pace-car
    // pair (deployed t=132.35, off t=196.53). What remains is one pair per caution:
    // deployed 264.27 / off 488.07, then deployed 561.63 / off 866.98.
    expect(events.filter((e) => e.event === "paceCar.deployed")).toHaveLength(2);
    expect(events.filter((e) => e.event === "paceCar.off")).toHaveLength(2);
  });
});

describe("the caution episode", () => {
  it("reports the pickup when the waving caution turns static", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);
  });

  it("does not report a pickup for a caution that begins static", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);

    // The phase assertion is the positive control: with nothing emitted either
    // way, an empty `events` alone would pass against a diff that does nothing.
    expect(events).toEqual([]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("reports one to go when the flag rises on a caught field", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);
    diffCaution(state, flagTick(ONE_TO_GO, { PaceMode: 3 }), sessionInfo, null, emit);

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.oneLapToGreen", data: {} },
    ]);
    expect(state.cautionPhase).toBe("one-to-go");
  });

  it("returns to caught when one to go is withdrawn with the caution still out, and reports the real one to go later", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit); // its own crossing
    diffCaution(state, flagTick(ONE_TO_GO, leader(3, 12)), sessionInfo, null, emit); // one to go, at the crossing
    // A waved-off restart: the flag comes down, the caution stays. The phase
    // must not latch at "one-to-go" — every later branch needs "caught".
    diffCaution(state, flagTick(STATIC, leader(3, 12)), sessionInfo, null, emit);

    expect(state.cautionPhase).toBe("caught");

    // The field goes around again — a lap the caution did not need…
    diffCaution(state, flagTick(STATIC, leader(3, 13)), sessionInfo, null, emit);
    // …and the flag that comes with the NEXT crossing is the real one to go.
    diffCaution(state, flagTick(ONE_TO_GO, leader(3, 14)), sessionInfo, null, emit);

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.oneLapToGreen", data: {} },
      { event: "caution.extraLap", data: {} },
      { event: "caution.oneLapToGreen", data: {} },
    ]);
    expect(state.cautionPhase).toBe("one-to-go");
  });

  it("reports the pickup once per caution, even when the waving bit re-raises after it", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit); // its own crossing, consumed
    // The waving bit re-raises mid-caution (per-zone, like the yellow one) and
    // settles again. Neither tick is a new caution: no second pickup, and the
    // crossing baseline must stay where the first pickup left it — a
    // re-anchored one would swallow the genuine crossing below.
    diffCaution(state, flagTick(WAVING, leader(3, 11)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 12)), sessionInfo, null, emit); // a lap the caution did not need

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.extraLap", data: {} },
    ]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("does not count the leader crossing the pickup itself landed on", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit); // its own crossing, scored

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);
  });

  it("reports an extra lap when the leader crosses again without the one-to-go flag", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit); // its own crossing, scored
    diffCaution(state, flagTick(STATIC, leader(3, 12)), sessionInfo, null, emit); // a lap the caution did not need

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.extraLap", data: {} },
    ]);
  });

  it("counts the canonical race leader's crossings, not the front of the pace lineup", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const order = canonicalLeader(5);
    // Car 3 sits at the front of the lineup; car 5 leads the race. Only car 5's
    // crossings may count — the lineup is the RESTART order, and the capture
    // shows the two disagreeing for most of a lap.
    const tick = (flags: number, three: number, five: number) =>
      flagTick(flags, lineup([3, 1, 0, three], [5, 4, 0, five]));

    diffCaution(state, tick(RACING, 10, 20), sessionInfo, order, emit); // seed
    diffCaution(state, tick(WAVING, 10, 20), sessionInfo, order, emit);
    diffCaution(state, tick(STATIC, 10, 20), sessionInfo, order, emit); // the pickup
    diffCaution(state, tick(STATIC, 11, 20), sessionInfo, order, emit); // car 3 crosses three times
    diffCaution(state, tick(STATIC, 12, 20), sessionInfo, order, emit);
    diffCaution(state, tick(STATIC, 13, 20), sessionInfo, order, emit);
    diffCaution(state, tick(STATIC, 13, 21), sessionInfo, order, emit); // the pickup's own crossing
    diffCaution(state, tick(STATIC, 13, 22), sessionInfo, order, emit); // the leader's extra lap

    // Exactly one extra lap. Counting car 3 instead would report two — which is
    // what makes this assertion tell the two sources apart at all.
    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.extraLap", data: {} },
    ]);
  });

  it("falls back to the front of the lineup — line 0, row 1 — with no canonical order", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // The double-file re-form the capture shows: row 1 holds TWO cars, the
    // leader on line 0 and car 11 outside it. Picking the lower car index would
    // count the wrong car's laps.
    const tick = (flags: number, eleven: number, seventeen: number) =>
      flagTick(flags, lineup([11, 1, 1, eleven], [17, 1, 0, seventeen]));

    diffCaution(state, tick(RACING, 10, 10), sessionInfo, null, emit); // seed
    diffCaution(state, tick(WAVING, 10, 10), sessionInfo, null, emit);
    diffCaution(state, tick(STATIC, 10, 10), sessionInfo, null, emit); // the pickup
    diffCaution(state, tick(STATIC, 11, 10), sessionInfo, null, emit); // car 11 crosses twice
    diffCaution(state, tick(STATIC, 12, 10), sessionInfo, null, emit);

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);
  });

  it("re-anchors on a caution it never saw begin, rather than counting a stale baseline", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // With no canonical order the leader is readable only while a lineup
    // exists, so the baseline freezes through a green stretch. A caution that
    // arrives already static must re-anchor on it: the laps run since are not
    // laps this episode spent behind the pace car.
    diffCaution(state, flagTick(RACING, leader(3, 4)), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // lineup gone, baseline frozen at 4
    diffCaution(state, flagTick(STATIC, leader(3, 24)), sessionInfo, null, emit); // twenty green laps later

    expect(events).toEqual([]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("re-anchors at a pickup whose lineup only appears on the pickup tick", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // The same stale baseline reaching the pickup branch, where it would read
    // as twenty laps run under a caution the field has only just been caught by.
    diffCaution(state, flagTick(RACING, leader(3, 4)), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // lineup gone, baseline frozen at 4
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit); // still no lineup
    diffCaution(state, flagTick(STATIC, leader(3, 24)), sessionInfo, null, emit); // the pickup

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);

    // And the next genuine crossing still counts.
    diffCaution(state, flagTick(STATIC, leader(3, 25)), sessionInfo, null, emit);

    expect(events.at(-1)).toEqual({ event: "caution.extraLap", data: {} });
  });

  it("stops counting laps once the caution bits are gone", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    // The caution is gone with no green edge to end it — a re-seed tick can
    // swallow that edge, and a phase left standing would call every green-flag
    // lap of the rest of the session an extra lap under caution.
    diffCaution(state, flagTick(RACING, leader(3, 11)), sessionInfo, null, emit);
    diffCaution(state, flagTick(RACING, leader(3, 12)), sessionInfo, null, emit);

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);
    expect(state.cautionPhase).toBe("none");
  });

  it("reports the restart on the green, even though it carries the start signal", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);
    diffCaution(state, flagTick(GREEN_HELD), sessionInfo, null, emit);
    diffCaution(state, flagTick(RESTART), sessionInfo, null, emit);

    // GreenHeld arrives with OneLapToGreen already set — the capture never
    // holds the green without it — so one to go lands on that tick.
    expect(events).toEqual([
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.oneLapToGreen", data: {} },
      { event: "caution.restarted", data: {} },
    ]);
    expect(state.cautionPhase).toBe("none");
  });

  it("says nothing about a caution it never saw begin", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit); // seed, mid-caution
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);

    expect(events).toEqual([]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("replays the captured cautions and reports each moment once", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const fired: Array<{ t: number; event: string }> = [];

    for (const tick of ticks) {
      const before = events.length;

      diffCaution(state, replayTick(tick), sessionInfo, null, emit);

      for (const e of events.slice(before)) fired.push({ t: tick.t, event: e.event });
    }

    expect(events.map((e) => e.event)).toEqual([
      "paceCar.deployed",
      "caution.fieldCaught",
      "caution.oneLapToGreen",
      "paceCar.off",
      "caution.restarted",
      "paceCar.deployed",
      "caution.fieldCaught",
      "caution.extraLap",
      "caution.oneLapToGreen",
      "paceCar.off",
      "caution.restarted",
    ]);
    // And each one at the `SessionTime` the capture puts it at — the first
    // caution runs its default two laps, the second takes the `!pacelaps +1`
    // that iRacing accepted (the crossing at 712.97 brought no one-to-go).
    expect(fired).toEqual([
      { t: 264.27, event: "paceCar.deployed" },
      { t: 333.57, event: "caution.fieldCaught" },
      { t: 415.12, event: "caution.oneLapToGreen" },
      { t: 488.07, event: "paceCar.off" },
      { t: 492.82, event: "caution.restarted" },
      { t: 561.63, event: "paceCar.deployed" },
      { t: 630.95, event: "caution.fieldCaught" },
      { t: 712.97, event: "caution.extraLap" },
      { t: 793.93, event: "caution.oneLapToGreen" },
      { t: 866.98, event: "paceCar.off" },
      { t: 872.45, event: "caution.restarted" },
    ]);
  });

  it("replays the captured ROAD-COURSE cautions: the pickup and one to go on one tick, the pace car's two blips, no checkpoint", () => {
    // `__fixtures__/caution-road-20260918.json` — the first road caution
    // captured, cut like the oval one (the pace car at slot 20, PaceCarIdx 64
    // supplied here since the capture has no session YAML). What it shows:
    // the waving caution never goes static on its own — at 309.33 it drops
    // straight to Caution|OneLapToGreen, so the pickup and one to go land on
    // ONE tick, in that order (the contract layer keeps "Two to green" silent
    // there); the pace car blips to AproachingPits and back mid-caution
    // (152.23 → 155.37, 562.07 → 565.22) before its real exit at 461.22; and
    // no `caution.lastLapCheckpoint`, because the capture recorded no
    // `LapDistPct` — the checkpoint is proved by the synthetic ticks above,
    // not by this replay.
    const state = createInitialState();
    const { events, emit } = collect();
    const fired: Array<{ t: number; event: string }> = [];

    for (const tick of roadTicks) {
      const before = events.length;

      diffCaution(state, replayTick(tick), sessionInfo, null, emit);

      for (const e of events.slice(before)) fired.push({ t: tick.t, event: e.event });
    }

    expect(fired).toEqual([
      { t: 152.23, event: "paceCar.off" },
      { t: 155.37, event: "paceCar.deployed" },
      { t: 309.33, event: "caution.fieldCaught" },
      { t: 309.33, event: "caution.oneLapToGreen" },
      { t: 461.22, event: "paceCar.off" },
      { t: 466.95, event: "caution.restarted" },
      { t: 494.18, event: "paceCar.deployed" },
      { t: 562.07, event: "paceCar.off" },
      { t: 565.22, event: "paceCar.deployed" },
    ]);
  });
});

describe("the caution lineup", () => {
  /**
   * The field behind the pace car, single file: `front` leads, then the cars
   * named after it. Every car carries the same scored lap, so the episode
   * half's crossing detection stays quiet and only the lineup moves.
   */
  function singleFile(...order: number[]): Record<string, unknown> {
    return lineup(
      [PACE, 0, 0, 5],
      ...order.map((carIdx, at): [number, number, number, number] => [
        carIdx,
        at + 1,
        0,
        5,
      ]),
    );
  }

  it("carries nothing into the pickup — the position moved to the last lap's checkpoint", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, singleFile(1, 2, 3)), playerSessionInfo(3), null, emit);
    diffCaution(state, flagTick(STATIC, singleFile(1, 2, 3)), playerSessionInfo(3), null, emit);

    expect(events).toEqual([{ event: "caution.fieldCaught", data: {} }]);
  });

  /**
   * The one-to-green lap's checkpoint: the player's `LapDistPct` rising through
   * `LAST_LAP_CHECKPOINT_PCT` for the first time after one to go. Every case
   * below drives the SAME single-file lineup (the player 3rd) so the payload's
   * fallback position is readable, and moves only the flags and the distance.
   */
  describe("the last lap's checkpoint", () => {
    type Rig = {
      state: ReturnType<typeof createInitialState>;
      events: PendingEvent[];
      emit: (e: PendingEvent) => void;
    };
    const info = playerSessionInfo(3);
    const field = singleFile(1, 2, 3);

    function tick(rig: Rig, flags: number, at: number | undefined): void {
      diffCaution(rig.state, flagTick(flags, { ...field, LapDistPct: at }), info, null, rig.emit);
    }

    /** A caught field, one to go just raised, the player at `at` of the lap. */
    function throughOneToGo(at: number): Rig {
      const rig: Rig = { state: createInitialState(), ...collect() };

      tick(rig, RACING, 0.5); // seed
      tick(rig, WAVING, 0.6);
      tick(rig, STATIC, 0.7);
      tick(rig, ONE_TO_GO, at);

      return rig;
    }

    function checkpoints(rig: Rig): PendingEvent[] {
      return rig.events.filter((e) => e.event === "caution.lastLapCheckpoint");
    }

    it("fires once, the first time the player's distance rises through 35% after one to go, with the restart position", () => {
      // A mid-pack car: the flag rises at the LEADER's crossing, with this car
      // still at 0.95 of the previous lap. Its own crossing comes next, and the
      // checkpoint is the first upward crossing of 0.35 after that.
      const rig = throughOneToGo(0.95);

      tick(rig, ONE_TO_GO, 0.99);
      tick(rig, ONE_TO_GO, 0.02); // the wrap: 0.99 → 0.02 is not a rise through 0.35
      tick(rig, ONE_TO_GO, 0.2);
      tick(rig, ONE_TO_GO, 0.34);

      expect(checkpoints(rig)).toEqual([]);

      tick(rig, ONE_TO_GO, 0.36);
      tick(rig, ONE_TO_GO, 0.5);
      tick(rig, ONE_TO_GO, 0.9);
      // A second rise through 0.35 with the flag still up — the field going
      // round again under a one-to-go that is slow to turn green — is NOT a
      // second checkpoint. Without these two ticks a diff that never disarmed
      // after firing would pass the assertion below.
      tick(rig, ONE_TO_GO, 0.2);
      tick(rig, ONE_TO_GO, 0.4);

      expect(checkpoints(rig)).toEqual([{ event: "caution.lastLapCheckpoint", data: { restartPosition: 3 } }]);
      expect(LAST_LAP_CHECKPOINT_PCT).toBe(0.35);
    });

    it("lands on the same lap for the leader, whose distance is near zero when the flag rises", () => {
      const rig = throughOneToGo(0.01);

      tick(rig, ONE_TO_GO, 0.2);
      tick(rig, ONE_TO_GO, 0.4);

      expect(checkpoints(rig)).toHaveLength(1);
    });

    it("fires nothing when the green arrives before the checkpoint", () => {
      const rig = throughOneToGo(0.95);

      tick(rig, ONE_TO_GO, 0.99);
      tick(rig, RESTART, 0.05);
      tick(rig, RACING, 0.3);
      tick(rig, RACING, 0.4); // the crossing, under green

      expect(rig.events.map((e) => e.event)).toEqual([
        "caution.fieldCaught",
        "caution.oneLapToGreen",
        "caution.restarted",
      ]);
    });

    it("fires nothing before one to go — a crossing on an ordinary caution lap is not the checkpoint", () => {
      const rig: Rig = { state: createInitialState(), ...collect() };

      tick(rig, RACING, 0.5); // seed
      tick(rig, WAVING, 0.9);
      tick(rig, STATIC, 0.1);
      tick(rig, STATIC, 0.3);
      tick(rig, STATIC, 0.4);

      expect(rig.events.map((e) => e.event)).toEqual(["caution.fieldCaught"]);
    });

    it("re-arms when one to go is withdrawn and raised again, so the new final lap gets its own call", () => {
      const rig = throughOneToGo(0.1);

      tick(rig, ONE_TO_GO, 0.4); // the first final lap's checkpoint
      tick(rig, STATIC, 0.6); // a waved-off restart: the flag comes down, the caution stays
      tick(rig, STATIC, 0.99);
      tick(rig, STATIC, 0.1);
      tick(rig, STATIC, 0.4); // a crossing on the extra lap — not a checkpoint
      tick(rig, ONE_TO_GO, 0.99); // the real one to go
      tick(rig, ONE_TO_GO, 0.1);
      tick(rig, ONE_TO_GO, 0.4); // and its checkpoint

      expect(rig.events.map((e) => e.event)).toEqual([
        "caution.fieldCaught",
        "caution.oneLapToGreen",
        "caution.lastLapCheckpoint",
        "caution.oneLapToGreen",
        "caution.lastLapCheckpoint",
      ]);
    });

    it("owes nothing to a one to go withdrawn before the checkpoint, until the flag comes back", () => {
      const rig = throughOneToGo(0.95);

      tick(rig, STATIC, 0.99); // withdrawn before this car ever reached 0.35
      tick(rig, STATIC, 0.1);
      tick(rig, STATIC, 0.4);

      expect(rig.events.map((e) => e.event)).toEqual(["caution.fieldCaught", "caution.oneLapToGreen"]);
    });

    it("keeps its baseline through a tick that cannot read the distance, so a crossing straddling the gap still fires", () => {
      const rig = throughOneToGo(0.3);

      tick(rig, ONE_TO_GO, undefined);
      tick(rig, ONE_TO_GO, 0.4);

      expect(checkpoints(rig)).toHaveLength(1);
    });
  });

  it("says nothing about the first lineup it reads — that is the answer, not a change", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, singleFile(1, 2, 3)), playerSessionInfo(3), null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([]);
  });

  it("reports a mid-caution reorder once, naming the new car", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const drivers = [{ CarIdx: 1, CarNumber: "09" }];
    const info = playerSessionInfo(3, { drivers });

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(STATIC, singleFile(1, 2, 3)), info, null, emit);
    // Car 2 pits under caution, so the player now follows car 1 — the case the
    // capture could not produce, because nobody pitted in either caution.
    diffCaution(state, flagTick(STATIC, singleFile(1, 3)), info, null, emit);
    diffCaution(state, flagTick(STATIC, singleFile(1, 3)), info, null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([
      {
        event: "caution.lineup.changed",
        data: { followCarIdx: 1, followCarNumber: "09", line: null, isLeader: false },
      },
    ]);
  });

  it("names the line the player re-formed into on an oval", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const info = playerSessionInfo(4);
    const single = singleFile(1, 2, 3, 4);
    // The double-file re-form: P1/P3 on line 0, P2/P4 on line 1. Car 4 is P4,
    // so it lines up outside behind car 2 rather than behind car 3.
    const double = lineup([PACE, 0, 0, 5], [1, 1, 0, 5], [2, 0, 1, 5], [3, 2, 0, 5], [4, 1, 1, 5]);

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, single), info, null, emit);
    diffCaution(state, flagTick(STATIC, single), info, null, emit);
    diffCaution(state, flagTick(STATIC, double), info, null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([
      {
        event: "caution.lineup.changed",
        data: { followCarIdx: 2, followCarNumber: null, line: "outside", isLeader: false },
      },
    ]);
  });

  it("says nothing when the car to follow becomes one it cannot name", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Session info names no pace car, so nothing can be put in front of a
    // player who inherits the front of the OUTSIDE line — that slot's "one row
    // lower" does not exist, and the pace car has no index to fall back to.
    // Silence beats "follow nobody": the consumer re-reads the lineup at speak
    // time and would find the same nothing.
    const info = playerSessionInfo(4, { paceCar: false });
    const before = lineup([PACE, 0, 0, 5], [1, 1, 0, 5], [2, 0, 1, 5], [3, 2, 0, 5], [4, 1, 1, 5]);
    // Car 2 pits, so the player moves up to line 1 row 0.
    const after = lineup([PACE, 0, 0, 5], [1, 1, 0, 5], [3, 2, 0, 5], [4, 0, 1, 5]);

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, before), info, null, emit);
    diffCaution(state, flagTick(STATIC, before), info, null, emit);
    diffCaution(state, flagTick(STATIC, after), info, null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([]);
  });

  it("forgets the car to follow between cautions, so the next one never opens with a change", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const info = playerSessionInfo(3);

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(STATIC, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(RESTART, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(RACING), info, null, emit);
    // A second caution whose lineup puts a different car in front of the player.
    diffCaution(state, flagTick(WAVING, singleFile(2, 1, 3)), info, null, emit);
    diffCaution(state, flagTick(STATIC, singleFile(2, 1, 3)), info, null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([]);
  });

  it("says nothing while the lineup unwinds under a green that the caution bits outlived", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const info = playerSessionInfo(3);
    // A yellow-checkered finish leaves `Caution` set past the green, so the
    // phase is "caught" while the field is already racing away and the pace
    // arrays are collapsing car by car. Only the green test catches this — the
    // phase does not.
    const green = STATIC | 0x4;

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(STATIC, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(green, singleFile(1, 2, 3)), info, null, emit); // green rises
    diffCaution(state, flagTick(green, singleFile(1, 2, 3)), info, null, emit);
    diffCaution(state, flagTick(green, singleFile(2, 1, 3)), info, null, emit);
    diffCaution(state, flagTick(green, singleFile(1, 3)), info, null, emit);

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toEqual([]);
  });

  it("replays the capture: one change per caution, at the double-file re-form, and none after a restart", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const info = playerSessionInfo(0);
    const fired: Array<{ t: number; followCarIdx: number | null }> = [];
    const caught: Array<{ t: number; restartPosition: number | null }> = [];

    for (const tick of ticks) {
      const before = events.length;
      const telemetry = replayTick(tick);

      diffCaution(state, telemetry, info, null, emit);

      for (const e of events.slice(before)) {
        if (e.event === "caution.lineup.changed") fired.push({ t: tick.t, followCarIdx: e.data.followCarIdx });

        // The pickup carries no position any more (the checkpoint does); the
        // lineup at that tick is what a callout reading live would have seen.
        if (e.event === "caution.fieldCaught") {
          expect(e.data).toEqual({});
          caught.push({
            t: tick.t,
            restartPosition: resolveCautionLineup(telemetry, info, true)?.restartPosition ?? null,
          });
        }
      }
    }

    // The positions the player really restarts in, off the capture's own pace
    // rows: 9th at the first pickup, 3rd at the second. Both pickups are single
    // file with the pace car at the head of the lineup, so both are anchored.
    expect(caught).toEqual([
      { t: 333.57, restartPosition: 9 },
      { t: 630.95, restartPosition: 3 },
    ]);

    // Car 0 ran 9th. It followed car 4 single file and car 1 once the field
    // re-formed double file, then car 7 and car 16 in the second caution. Both
    // changes land one tick before their `caution.oneLapToGreen` (415.12 /
    // 793.93) — the field re-forms, then the flag follows. The capture's 60
    // post-green ticks, where the lineup collapses car by car, add none.
    expect(fired).toEqual([
      { t: 415.1, followCarIdx: 1 },
      { t: 793.92, followCarIdx: 16 },
    ]);
  });
});
