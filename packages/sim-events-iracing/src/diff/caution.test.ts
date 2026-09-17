import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffCaution } from "./caution.js";
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

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
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

  it("reports one to go, carrying the file", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);
    diffCaution(state, flagTick(ONE_TO_GO, { PaceMode: 3 }), sessionInfo, null, emit);

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: { restartPosition: null } },
      { event: "caution.oneLapToGreen", data: { file: "double" } },
    ]);
  });

  it("reports a single-file restart as single file", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, null, emit);
    diffCaution(state, flagTick(ONE_TO_GO, { PaceMode: 2 }), sessionInfo, null, emit);

    expect(events.at(-1)).toEqual({ event: "caution.oneLapToGreen", data: { file: "single" } });
  });

  it("does not count the leader crossing the pickup itself landed on", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, null, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, null, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, null, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, null, emit); // its own crossing, scored

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
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
      { event: "caution.fieldCaught", data: { restartPosition: null } },
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
      { event: "caution.fieldCaught", data: { restartPosition: null } },
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

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
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

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);

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

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
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
      { event: "caution.fieldCaught", data: { restartPosition: null } },
      { event: "caution.oneLapToGreen", data: { file: "single" } },
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
    // Both restarts re-formed the field double file (`PaceMode` 3 at each rise).
    expect(events.filter((e) => e.event === "caution.oneLapToGreen")).toEqual([
      { event: "caution.oneLapToGreen", data: { file: "double" } },
      { event: "caution.oneLapToGreen", data: { file: "double" } },
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
});
