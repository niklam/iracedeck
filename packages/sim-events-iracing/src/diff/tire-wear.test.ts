/**
 * Unit tests for the tire-wear diff (issue #1108).
 *
 * Pins:
 *   - the zone mapping on both sides of the car, percent scaling, the tread and
 *     both tie-breaks (`buildTireWearReport`)
 *   - no report for missing / non-finite / all-zero readings
 *   - a stop the driver drove into reports once, behind the exit readback
 *   - a garage start, a tow and a teleport into the stall report nothing
 *   - a report whose exit fire was cancelled by a re-entry never rides out
 *   - the 2026-09-19 capture, replayed through the real pit-lane → readback →
 *     tire-wear chain: two stops, the first after a four-tire change
 */
import type { TireWearReport } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { TrackType } from "../track-type.js";
import { diffPitLane } from "./pit-lane.js";
import { diffPitReadback, PIT_READBACK_EXIT_DELAY_MS } from "./pit-readback.js";
import { buildTireWearReport, diffTireWear } from "./tire-wear.js";
import type { PendingEvent } from "./types.js";

/** Twelve readings in the sim's order: LF L/M/R, RF L/M/R, LR L/M/R, RR L/M/R. */
type Wear12 = [number, number, number, number, number, number, number, number, number, number, number, number];

const WEAR_FIELDS = [
  "LFwearL",
  "LFwearM",
  "LFwearR",
  "RFwearL",
  "RFwearM",
  "RFwearR",
  "LRwearL",
  "LRwearM",
  "LRwearR",
  "RRwearL",
  "RRwearM",
  "RRwearR",
] as const;

function wear(values: Wear12): Partial<TelemetryData> {
  return Object.fromEntries(WEAR_FIELDS.map((field, i) => [field, values[i]])) as Partial<TelemetryData>;
}

/** A plausible stint's worth of wear, every zone distinct. */
const STINT: Wear12 = [0.95, 0.93, 0.9, 0.91, 0.94, 0.96, 0.97, 0.96, 0.98, 0.985, 0.975, 0.99];

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    ...wear(STINT),
    ...overrides,
  } as TelemetryData;
}

const onCircuit = (overrides: Partial<TelemetryData> = {}): TelemetryData => telemetry(overrides);
const onPitRoad = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits, ...overrides });
const inStall = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall, ...overrides });

const EXIT: PendingEvent = { event: "pitService.readbackRequested", data: { reason: "exit" } };
const PIT_ENTERED: PendingEvent = { event: "pitLane.entered", data: {} };
const STALL_ENTERED: PendingEvent = { event: "pitStall.entered", data: {} };
const STALL_DEPARTED: PendingEvent = { event: "pitStall.departed", data: {} };

/** Run one tick of the diff alone; returns what it emitted. */
function step(
  state: TranslatorState,
  t: TelemetryData,
  pending: PendingEvent[] = [],
  replayOnlySession = false,
): PendingEvent[] {
  const emitted: PendingEvent[] = [];

  diffTireWear(state, t, (e) => emitted.push(e), pending, replayOnlySession);

  return emitted;
}

function reports(events: PendingEvent[]): TireWearReport[] {
  return events.flatMap((e) => (e.event === "tireWear.reported" ? [e.data] : []));
}

/**
 * A stop the driver drove into, up to the tick the car leaves its box. The
 * last element is the departure tick's telemetry so a test can vary it.
 */
function driveIntoStop(state: TranslatorState, departure: TelemetryData = inStall({ PlayerCarInPitStall: false })) {
  const emitted: PendingEvent[] = [];

  emitted.push(...step(state, onCircuit()));
  emitted.push(...step(state, onPitRoad(), [PIT_ENTERED]));
  emitted.push(...step(state, inStall(), [STALL_ENTERED]));
  emitted.push(...step(state, inStall()));
  emitted.push(...step(state, departure, [STALL_DEPARTED]));

  return emitted;
}

describe("buildTireWearReport", () => {
  it("maps L/M/R to outside/middle/inside on the left-side tires and inside/middle/outside on the right", () => {
    const report = buildTireWearReport(
      telemetry(wear([0.91, 0.92, 0.93, 0.81, 0.82, 0.83, 0.71, 0.72, 0.73, 0.61, 0.62, 0.63])),
    );

    expect(report?.corners.lf).toMatchObject({ outside: 91, middle: 92, inside: 93 });
    expect(report?.corners.lr).toMatchObject({ outside: 71, middle: 72, inside: 73 });
    expect(report?.corners.rf).toMatchObject({ inside: 81, middle: 82, outside: 83 });
    expect(report?.corners.rr).toMatchObject({ inside: 61, middle: 62, outside: 63 });
  });

  it("reports each zone in percent, unrounded", () => {
    const report = buildTireWearReport(telemetry(wear([0.983380913734436, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])));

    expect(report?.corners.lf.outside).toBeCloseTo(98.3380913734436, 10);
    expect(report?.corners.lf.inside).toBe(100);
  });

  it("takes the tread from the lowest zone, per tire", () => {
    // LF: L (outside) lowest; RF: L (inside) lowest; LR: M lowest; RR: R (outside) lowest.
    const report = buildTireWearReport(
      telemetry(wear([0.9, 0.95, 0.96, 0.9, 0.95, 0.96, 0.96, 0.9, 0.95, 0.96, 0.95, 0.9])),
    );

    expect(report?.corners.lf).toMatchObject({ tread: 90, zone: "outside" });
    expect(report?.corners.rf).toMatchObject({ tread: 90, zone: "inside" });
    expect(report?.corners.lr).toMatchObject({ tread: 90, zone: "middle" });
    expect(report?.corners.rr).toMatchObject({ tread: 90, zone: "outside" });
  });

  it("names the heaviest tire by its lowest tread", () => {
    const report = buildTireWearReport(telemetry(wear(STINT)));

    // LF inside (R) = 90 is the lowest reading on the car.
    expect(report?.heaviest).toEqual({ corner: "lf", zone: "inside" });
    expect(report?.corners.lf).toMatchObject({ tread: 90, zone: "inside" });
  });

  it("breaks a zone tie inside, then middle, then outside", () => {
    const report = buildTireWearReport(
      telemetry(
        wear([
          // LF: all three equal → inside.
          0.9,
          0.9,
          0.9,
          // RF: middle and outside (R) equal and lowest → middle.
          0.95,
          0.9,
          0.9,
          // LR: outside (L) and middle equal and lowest → middle.
          0.9,
          0.9,
          0.95,
          // RR: inside (L) and outside (R) equal and lowest → inside.
          0.9,
          0.95,
          0.9,
        ]),
      ),
    );

    expect(report?.corners.lf.zone).toBe("inside");
    expect(report?.corners.rf.zone).toBe("middle");
    expect(report?.corners.lr.zone).toBe("middle");
    expect(report?.corners.rr.zone).toBe("inside");
  });

  it("breaks a tire tie lf, then rf, then lr, then rr", () => {
    const allEqual = buildTireWearReport(telemetry(wear([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])));

    expect(allEqual?.heaviest).toEqual({ corner: "lf", zone: "inside" });

    // RF, LR and RR tie at 80; LF is fresher → rf, and within rf its outside (R).
    const rearTie = buildTireWearReport(
      telemetry(wear([0.9, 0.9, 0.9, 0.95, 0.9, 0.8, 0.95, 0.8, 0.95, 0.8, 0.9, 0.95])),
    );

    expect(rearTie?.heaviest).toEqual({ corner: "rf", zone: "outside" });

    // LR and RR tie → lr.
    const lrRr = buildTireWearReport(telemetry(wear([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.9, 0.9, 0.9, 0.9, 0.8])));

    expect(lrRr?.heaviest).toEqual({ corner: "lr", zone: "outside" });
  });

  it("returns null when any reading is missing", () => {
    for (const field of WEAR_FIELDS) {
      const t = telemetry();

      delete (t as unknown as Record<string, unknown>)[field];

      expect(buildTireWearReport(t), field).toBeNull();
    }
  });

  it("returns null when any reading is not a finite number", () => {
    for (const bad of [NaN, Infinity, -Infinity, "0.9" as unknown as number, null as unknown as number]) {
      expect(buildTireWearReport(telemetry({ RRwearM: bad })), String(bad)).toBeNull();
    }
  });

  it("returns null when all twelve readings are zero (no wear model)", () => {
    expect(buildTireWearReport(telemetry(wear([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))).toBeNull();
  });

  it("still reports when only some readings are zero", () => {
    const report = buildTireWearReport(telemetry(wear([0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])));

    expect(report?.heaviest).toEqual({ corner: "lf", zone: "outside" });
    expect(report?.corners.lf.tread).toBe(0);
  });
});

describe("diffTireWear — a stop the driver drove into", () => {
  it("reads the wear at departure but publishes nothing until the exit readback", () => {
    const state = createInitialState();

    expect(driveIntoStop(state)).toEqual([]);
    expect(state.tireWearReport?.heaviest).toEqual({ corner: "lf", zone: "inside" });

    // Pit exit, then the settle delay — nothing yet.
    expect(step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }])).toEqual([]);
    expect(step(state, onCircuit())).toEqual([]);

    const emitted = step(state, onCircuit(), [EXIT]);

    expect(reports(emitted)).toHaveLength(1);
    expect(reports(emitted)[0]).toEqual(buildTireWearReport(telemetry()));
    expect(state.tireWearReport).toBeNull();
  });

  it("publishes once — a second exit readback finds nothing stored", () => {
    const state = createInitialState();

    driveIntoStop(state);
    expect(reports(step(state, onCircuit(), [EXIT]))).toHaveLength(1);
    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("does not publish on an entry readback", () => {
    const state = createInitialState();

    driveIntoStop(state);

    for (const reason of ["entry", "entry-refire"] as const) {
      expect(step(state, onCircuit(), [{ event: "pitService.readbackRequested", data: { reason } }])).toEqual([]);
    }

    expect(state.tireWearReport).not.toBeNull();
  });

  it("reads the wear held at departure, not a later tick's", () => {
    const state = createInitialState();
    const atDeparture = inStall({ PlayerCarInPitStall: false, ...wear(STINT) });

    driveIntoStop(state, atDeparture);

    // Hypothetically different readings by the time the readback fires.
    const later = onCircuit(wear([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));

    expect(reports(step(state, later, [EXIT]))[0]).toEqual(buildTireWearReport(atDeparture));
  });

  it("does nothing on an exit readback with no stall visit (a drive-through)", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("stays silent when a reading is missing at departure", () => {
    const state = createInitialState();
    const departure = inStall({ PlayerCarInPitStall: false });

    delete (departure as unknown as Record<string, unknown>).LRwearM;
    driveIntoStop(state, departure);

    expect(state.tireWearReport).toBeNull();
    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("stays silent when all readings are zero at departure", () => {
    const state = createInitialState();

    driveIntoStop(state, inStall({ PlayerCarInPitStall: false, ...wear([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }));

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("is still a drive-in after running wide off the circuit before the lane", () => {
    const state = createInitialState();

    step(state, onCircuit({ PlayerTrackSurface: TrkLoc.OffTrack }));
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(), [STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(reports(step(state, onCircuit(), [EXIT]))).toHaveLength(1);
  });
});

describe("diffTireWear — a stall visit that is not a stop", () => {
  it("reports nothing after a garage start in the stall", () => {
    const state = createInitialState();

    // In the garage: out of the car.
    step(state, telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld }));
    // "Drive": in the car, already on pit road and in the stall, all on one tick.
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall());
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(state.tireWearReport).toBeNull();
    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("reports nothing after a garage start even when the driver had been on the circuit before the garage", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, telemetry({ IsOnTrack: false }));
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("reports nothing after a tow into the stall (NotInWorld on the way)", () => {
    const state = createInitialState();

    step(state, onCircuit());
    // Towed: the car leaves the world, then appears in its box.
    step(state, telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld }));
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("reports nothing when the car is put straight from the circuit into its box", () => {
    const state = createInitialState();

    step(state, onCircuit());
    // No NotInWorld tick in between: the car arrives on pit road already in the box.
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("reports nothing when that teleport's PlayerCarInPitStall lags the surface by a tick", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, inStall({ PlayerCarInPitStall: false }), [PIT_ENTERED]);
    step(state, inStall(), [STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("reports nothing when the translator first sees the car on pit road", () => {
    const state = createInitialState();

    step(state, onPitRoad());
    step(state, inStall(), [STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);

    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("the stop after a garage start is a drive-in again", () => {
    const state = createInitialState();

    step(state, telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld }));
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false }), [STALL_DEPARTED]);
    step(state, onCircuit(), [EXIT]);

    driveIntoStop(state);

    expect(reports(step(state, onCircuit(), [EXIT]))).toHaveLength(1);
  });
});

describe("diffTireWear — a report never outlives its visit", () => {
  it("drops the stored report when the car re-enters pit road before the exit fire, so a drive-through stays silent", () => {
    const state = createInitialState();

    driveIntoStop(state);
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);
    // Back onto pit road inside the settle delay — the readback's exit fire is
    // cancelled by the re-approach, and the report with it.
    step(state, onPitRoad(), [PIT_ENTERED]);
    expect(state.tireWearReport).toBeNull();

    // Straight through, no stop: the next exit readback has nothing to carry.
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);
    expect(step(state, onCircuit(), [EXIT])).toEqual([]);
  });

  it("a re-entry that stops again reports the second stop", () => {
    const state = createInitialState();

    driveIntoStop(state);
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);

    const second = wear([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);

    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(second), [STALL_ENTERED]);
    step(state, inStall({ PlayerCarInPitStall: false, ...second }), [STALL_DEPARTED]);

    const emitted = reports(step(state, onCircuit(), [EXIT]));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.corners.lf.tread).toBe(80);
  });

  it("reads and keeps nothing in a replay-only session", () => {
    const state = createInitialState();

    driveIntoStop(state);
    expect(state.tireWearReport).not.toBeNull();

    expect(step(state, onCircuit(), [EXIT], true)).toEqual([]);
    expect(state.tireWearReport).toBeNull();
    expect(state.tireWearDroveOnCircuit).toBe(false);
  });
});

// ── The 2026-09-19 capture ────────────────────────────────────────────────

type FixtureTick = {
  t: number;
  IsOnTrack: boolean;
  OnPitRoad: boolean;
  PlayerCarInPitStall: boolean;
  PlayerTrackSurface: number;
  PitSvFlags: number;
} & Record<(typeof WEAR_FIELDS)[number], number>;

const capture = JSON.parse(
  readFileSync(new URL("./__fixtures__/tire-wear-stops-20260919.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/**
 * The capture records a tick only when a value changes; the sim ticks at 60 Hz
 * in between with the same values. Re-send each record every `stepS` seconds
 * until the next one, and keep holding the last for `tailS` seconds — the
 * capture stops right at stop 2's pit exit, before its settle delay elapses.
 */
function held(ticks: FixtureTick[], stepS = 0.25, tailS = 6): Array<{ t: number; tick: FixtureTick }> {
  const out: Array<{ t: number; tick: FixtureTick }> = [];

  ticks.forEach((tick, i) => {
    const until = ticks[i + 1]?.t ?? tick.t + tailS;

    for (let t = tick.t; t < until - 1e-9; t += stepS) out.push({ t, tick });
  });

  return out;
}

type Emitted = { t: number; event: PendingEvent };

/** Replay the capture through the same three diffs the translator runs, in its order. */
function replayCapture(): Emitted[] {
  const state = createInitialState();
  const out: Emitted[] = [];

  for (const { t, tick } of held(capture)) {
    const now = t * 1000;
    const pending: PendingEvent[] = [];
    const emit = (e: PendingEvent): void => {
      pending.push(e);
    };
    const telemetryTick = tick as unknown as TelemetryData;

    diffPitLane(state, telemetryTick, TrackType.RoadCourse, now, emit);
    diffPitReadback(state, telemetryTick, now, emit, pending);
    diffTireWear(state, telemetryTick, emit, pending, false);

    for (const event of pending) out.push({ t, event });
  }

  return out;
}

describe("diffTireWear — the 2026-09-19 capture", () => {
  const emitted = replayCapture();
  const tireReports = emitted.filter((e) => e.event.event === "tireWear.reported");
  const exits = emitted.filter(
    (e) => e.event.event === "pitService.readbackRequested" && e.event.data.reason === "exit",
  );

  it("reports both stops, each on the tick of its exit readback and pushed right after it", () => {
    expect(exits).toHaveLength(2);
    expect(tireReports).toHaveLength(2);

    for (const [i, report] of tireReports.entries()) {
      const at = emitted.indexOf(report);

      expect(report.t).toBe(exits[i]?.t);
      expect(emitted[at - 1]).toBe(exits[i]);
    }
  });

  it("publishes stop 1's report the settle delay after pit exit, never at departure", () => {
    const departed = emitted.find((e) => e.event.event === "pitStall.departed");
    const exited = emitted.find((e) => e.event.event === "pitLane.exited");

    expect(departed?.t).toBe(469.13);
    expect(exited?.t).toBe(475.55);
    expect(tireReports[0]?.t).toBeGreaterThanOrEqual(475.55 + PIT_READBACK_EXIT_DELAY_MS / 1000);
    expect(tireReports[0]?.t).toBeLessThan(475.55 + PIT_READBACK_EXIT_DELAY_MS / 1000 + 0.25 + 1e-9);
  });

  it("stop 1 (four tires changed) reports the set that came off: LF 98.3 on the inside, the heaviest", () => {
    const report = tireReports[0]?.event.data as TireWearReport;

    expect(report.corners.lf.tread).toBeCloseTo(98.338, 3);
    expect(report.corners.lf.zone).toBe("inside");
    expect(report.corners.lf.outside).toBeCloseTo(99.15, 2);
    expect(report.corners.rf).toMatchObject({ zone: "inside" });
    expect(report.corners.rf.tread).toBeCloseTo(98.625, 3);
    expect(report.corners.lr).toMatchObject({ zone: "middle" });
    expect(report.corners.lr.tread).toBeCloseTo(98.554, 3);
    expect(report.corners.rr).toMatchObject({ zone: "inside" });
    expect(report.corners.rr.tread).toBeCloseTo(98.931, 3);
    expect(report.heaviest).toEqual({ corner: "lf", zone: "inside" });
  });

  it("stop 2 (no tires) reports the set still on the car", () => {
    const report = tireReports[1]?.event.data as TireWearReport;

    expect(report.corners.lf.tread).toBeCloseTo(99.265, 3);
    expect(report.corners.lf.zone).toBe("inside");
    expect(report.heaviest).toEqual({ corner: "lf", zone: "inside" });
  });
});
