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
  const rows = new Array(72).fill(-1);
  const laps = new Array(72).fill(-1);

  tick.CarIdxTrackSurface.forEach((v, i) => (surfaces[i === 20 ? PACE : i] = v));
  tick.CarIdxPaceRow.forEach((v, i) => (rows[i === 20 ? PACE : i] = v));
  tick.CarIdxLapCompleted.forEach((v, i) => (laps[i === 20 ? PACE : i] = v));

  return {
    ...tick,
    CarIdxTrackSurface: surfaces,
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

/** Puts the car leading the pace order on row 1, with `lapCompleted` laps scored. */
function leader(carIdx: number, lapCompleted: number): Record<string, unknown> {
  const rows = new Array(72).fill(-1);
  const laps = new Array(72).fill(-1);

  rows[carIdx] = 1;
  laps[carIdx] = lapCompleted;

  return { CarIdxPaceRow: rows, CarIdxLapCompleted: laps };
}

describe("pace car edges", () => {
  it("emits paceCar.deployed when the pace car reaches the track", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(1), sessionInfo, emit); // seed: in its stall
    diffCaution(state, paceTick(3), sessionInfo, emit);

    expect(events).toEqual([{ event: "paceCar.deployed", data: {} }]);
  });

  it("emits paceCar.off when it heads for the pits", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(3), sessionInfo, emit); // seed: on track
    diffCaution(state, paceTick(2), sessionInfo, emit);

    expect(events).toEqual([{ event: "paceCar.off", data: {} }]);
  });

  it("says nothing on the first tick, whatever the pace car is doing", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, paceTick(3), sessionInfo, emit);

    expect(events).toEqual([]);
  });

  it("matches the captured pace-car edges: deployed twice, off twice", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    for (const tick of ticks) {
      diffCaution(state, replayTick(tick), sessionInfo, emit);
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

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
  });

  it("does not report a pickup for a caution that begins static", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);

    // The phase assertion is the positive control: with nothing emitted either
    // way, an empty `events` alone would pass against a diff that does nothing.
    expect(events).toEqual([]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("reports one to go, carrying the file", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);
    diffCaution(state, flagTick(ONE_TO_GO, { PaceMode: 3 }), sessionInfo, emit);

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: { restartPosition: null } },
      { event: "caution.oneLapToGreen", data: { file: "double" } },
    ]);
  });

  it("reports a single-file restart as single file", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);
    diffCaution(state, flagTick(ONE_TO_GO, { PaceMode: 2 }), sessionInfo, emit);

    expect(events.at(-1)).toEqual({ event: "caution.oneLapToGreen", data: { file: "single" } });
  });

  it("does not count the leader crossing the pickup itself landed on", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, emit); // its own crossing, scored

    expect(events).toEqual([{ event: "caution.fieldCaught", data: { restartPosition: null } }]);
  });

  it("reports an extra lap when the leader crosses again without the one-to-go flag", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING, leader(3, 10)), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC, leader(3, 10)), sessionInfo, emit); // the pickup
    diffCaution(state, flagTick(STATIC, leader(3, 11)), sessionInfo, emit); // its own crossing, scored
    diffCaution(state, flagTick(STATIC, leader(3, 12)), sessionInfo, emit); // a lap the caution did not need

    expect(events).toEqual([
      { event: "caution.fieldCaught", data: { restartPosition: null } },
      { event: "caution.extraLap", data: {} },
    ]);
  });

  it("reports the restart on the green, even though it carries the start signal", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffCaution(state, flagTick(RACING), sessionInfo, emit); // seed
    diffCaution(state, flagTick(WAVING), sessionInfo, emit);
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);
    diffCaution(state, flagTick(GREEN_HELD), sessionInfo, emit);
    diffCaution(state, flagTick(RESTART), sessionInfo, emit);

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

    diffCaution(state, flagTick(STATIC), sessionInfo, emit); // seed, mid-caution
    diffCaution(state, flagTick(STATIC), sessionInfo, emit);

    expect(events).toEqual([]);
    expect(state.cautionPhase).toBe("caught");
  });

  it("replays the captured cautions and reports each moment once", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const fired: Array<{ t: number; event: string }> = [];

    for (const tick of ticks) {
      const before = events.length;

      diffCaution(state, replayTick(tick), sessionInfo, emit);

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
