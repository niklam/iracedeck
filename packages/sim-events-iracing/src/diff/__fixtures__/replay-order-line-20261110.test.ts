/**
 * The replay order across the start/finish line against what iRacing reported
 * (issue #1682): windows of a saved replay, camera on car 6, around the nine
 * ticks where the raw lap-progress ranking made the camera car blink
 * P5 → P6 → P5 — car 4's crossing on pit road among them — and one rewind in
 * which four cars cross the line backwards. Through the replay step and the
 * canonical order no car changes rank for a few ticks and back.
 */
import { calculateRacePositions, type TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { calculateCanonicalRacePositions } from "../../race-order.js";
import { createInitialState } from "../../state.js";
import { type CarProgressPolicy, LIVE_CAR_PROGRESS_POLICY } from "../car-progress.js";
import { REPLAY_CAR_PROGRESS_POLICY, stepReplayProgress } from "../replay-progress.js";

type Tick = TelemetryData & {
  sessionTime: number;
  ReplayFrameNum: number;
  CamCarIdx: number;
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
};

type Fixture = { source: string; windows: Tick[][] };

const fixture = JSON.parse(
  readFileSync(new URL("./replay-order-line-20261110.json", import.meta.url), "utf-8"),
) as Fixture;

/** The replay frames the raw ranking blinked the camera car on, the first being car 4's pit-lane crossing. */
const BLINK_FRAMES = [113102, 111209, 111240, 111352, 111617, 111872, 111877, 111905, 111941];

/** The longest rank change, in ticks, that counts as a blink rather than a pass. */
const MAX_BLINK_TICKS = 4;

const CAMERA_CAR = 6;
const CAR_COUNT = 29;
/** The window that rewinds: every other one plays forwards. */
const REWIND_WINDOW = 1;

/** A tick as the translator receives it: the capture's `sessionTime` is the telemetry's `SessionTime`. */
const telemetryOf = (tick: Tick): TelemetryData => ({ ...tick, SessionTime: tick.sessionTime }) as TelemetryData;

/** Every window's order, tick by tick: raw, or through the replay step against one state kept across windows. */
function rawOrders(window: readonly Tick[]): number[][] {
  return window.map((tick) => calculateRacePositions(telemetryOf(tick)));
}

function replayOrders(policy: CarProgressPolicy = REPLAY_CAR_PROGRESS_POLICY): number[][][] {
  const state = createInitialState();

  return fixture.windows.map((window) =>
    window.map((tick) => {
      const telemetry = telemetryOf(tick);
      const progress = stepReplayProgress(state.replayProgress, telemetry, policy);

      return calculateCanonicalRacePositions(state, telemetry, null, true, progress);
    }),
  );
}

/** Every car's blinks through the replay step under `policy`, as `car <n> at <frame>`. */
function allBlinks(policy: CarProgressPolicy = REPLAY_CAR_PROGRESS_POLICY): string[] {
  const orders = replayOrders(policy);
  const found: string[] = [];

  for (let car = 0; car < CAR_COUNT; car++) {
    fixture.windows.forEach((w, i) => {
      for (const frame of blinks(w, orders[i]!, car)) found.push(`car ${car} at ${frame}`);
    });
  }

  return found;
}

/** The frames on which a car's rank left its value and came back within {@link MAX_BLINK_TICKS} ticks. */
function blinks(window: readonly Tick[], orders: readonly number[][], car: number): number[] {
  const frames: number[] = [];

  for (let k = 1; k < orders.length; k++) {
    const before = orders[k - 1]![car];

    if (orders[k]![car] === before) continue;

    for (let len = 1; len <= MAX_BLINK_TICKS && k + len < orders.length; len++) {
      if (orders[k + len]![car] === before) {
        frames.push(window[k]!.ReplayFrameNum);
        break;
      }
    }
  }

  return frames;
}

describe("replay-order-line-20261110 fixture", () => {
  it("is nine windows of replay ticks, the camera on car 6 throughout", () => {
    expect(fixture.windows).toHaveLength(9);
    expect(fixture.windows.flat()).toHaveLength(142);

    for (const tick of fixture.windows.flat()) {
      expect(tick.CamCarIdx).toBe(CAMERA_CAR);
      expect(tick.CarIdxLapCompleted).toHaveLength(CAR_COUNT);
      expect(tick.CarIdxLapDistPct).toHaveLength(CAR_COUNT);
    }
  });

  it("plays forwards through every blink and rewinds 0.2 s a tick in the rewind window, each pausing a tick now and then", () => {
    const steps = (w: readonly Tick[]): number[] => w.slice(1).map((tick, k) => tick.sessionTime - w[k]!.sessionTime);
    const forward = fixture.windows.filter((_, i) => i !== REWIND_WINDOW).flatMap(steps);
    const rewind = steps(fixture.windows[REWIND_WINDOW]!);

    expect(forward.every((d) => d >= 0 && d < 0.1)).toBe(true);
    expect(forward.some((d) => d === 0)).toBe(true);
    expect(rewind.every((d) => d === 0 || (d > -0.21 && d < -0.19))).toBe(true);
    expect(rewind.some((d) => d === 0)).toBe(true);
  });

  it("rewind window: four cars' lap counts step back across the line, the arrays agreeing on every tick", () => {
    const window = fixture.windows[REWIND_WINDOW]!;
    const crossed: number[] = [];

    for (let k = 1; k < window.length; k++) {
      for (let car = 0; car < CAR_COUNT; car++) {
        const before = window[k - 1]!;
        const after = window[k]!;

        if (after.CarIdxLapCompleted[car]! < before.CarIdxLapCompleted[car]!) {
          crossed.push(car);
          // Rewinding across the line, the sum stays continuous: no disagreement to correct.
          const sumBefore = before.CarIdxLapCompleted[car]! + before.CarIdxLapDistPct[car]!;
          const sumAfter = after.CarIdxLapCompleted[car]! + after.CarIdxLapDistPct[car]!;

          expect(Math.abs(sumAfter - sumBefore)).toBeLessThan(0.01);
        }
      }
    }

    expect(crossed).toEqual([23, 5, 28, 17]);
  });

  it("raw: the camera car blinks at exactly the nine frames (the positive control)", () => {
    const frames = fixture.windows.flatMap((w) => blinks(w, rawOrders(w), CAMERA_CAR));

    expect(frames.sort()).toEqual([...BLINK_FRAMES].sort());
  });

  it("raw: car 4 reads a fraction a hair below zero the tick after its pit-lane crossing", () => {
    const window = fixture.windows[0]!;
    const k = window.findIndex((tick) => tick.ReplayFrameNum === 113102);

    expect(window[k]!.CarIdxLapCompleted[4]).toBe(7);
    expect(window[k + 1]!.CarIdxLapDistPct[4]).toBeLessThan(0);
    expect(window[k + 1]!.CarIdxLapDistPct[4]).toBeGreaterThan(-0.001);
    // Raw, the car drops out of the order for that tick.
    expect(calculateRacePositions(telemetryOf(window[k + 1]!))[4]).toBe(0);
  });

  it("through the replay step: the camera car never blinks", () => {
    const orders = replayOrders();
    const frames = fixture.windows.flatMap((w, i) => blinks(w, orders[i]!, CAMERA_CAR));

    expect(frames).toEqual([]);
  });

  it("through the replay step: no car changes rank for one to four ticks and back", () => {
    expect(allBlinks()).toEqual([]);
  });

  it("without the run of three, nothing confirms a crossing car read inside the band from its window's start: all nine blink again", () => {
    const noRun = replayOrders({ ...REPLAY_CAR_PROGRESS_POLICY, confirmByRun: false });
    const frames = fixture.windows.flatMap((w, i) => blinks(w, noRun[i]!, CAMERA_CAR));

    expect(frames.sort()).toEqual([...BLINK_FRAMES].sort());
  });

  it("with the live >= 0 fraction test, car 4 drops out for the tick it reads below zero and two cars move up", () => {
    const liveFraction = { ...REPLAY_CAR_PROGRESS_POLICY, readLapFraction: LIVE_CAR_PROGRESS_POLICY.readLapFraction };

    expect(allBlinks(liveFraction)).toEqual(["car 4 at 113103", "car 12 at 113103", "car 26 at 113103"]);
  });

  it("through the replay step: car 4 stays ranked across the tick its fraction reads below zero", () => {
    const orders = replayOrders();
    const window = fixture.windows[0]!;
    const k = window.findIndex((tick) => tick.ReplayFrameNum === 113102);

    expect(orders[0]![k + 1]![4]).toBeGreaterThan(0);
    expect(orders[0]![k + 1]![4]).toBe(orders[0]![k + 2]![4]);
  });
});
