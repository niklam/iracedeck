import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { computeFastestLapBisectionProbe, SESSION_STRIDE } from "./lap-walk.js";

/** A sample with `carIdx` 2 on `lap` at `dist`, in `sessionNum`. */
function sample(sessionNum: number | undefined, lap: number, dist: number): TelemetryData {
  return { SessionNum: sessionNum, CarIdxLap: [0, 0, lap], CarIdxLapDistPct: [0, 0, dist] } as unknown as TelemetryData;
}

describe("computeFastestLapBisectionProbe (#607)", () => {
  it("scores a car in the world by session first, then lap and distance", () => {
    expect(computeFastestLapBisectionProbe(sample(2, 7, 0.25), 2)).toEqual({
      kind: "in-world",
      sessionNum: 2,
      lap: 7,
      dist: 0.25,
      score: 2 * SESSION_STRIDE + 7.25,
    });

    const score = (telemetry: TelemetryData): number => {
      const probe = computeFastestLapBisectionProbe(telemetry, 2);

      if (probe.kind !== "in-world") throw new Error(`expected a car in the world, got ${probe.kind}`);

      return probe.score;
    };

    // The last lap of a long session still scores below the first of the next.
    expect(score(sample(1, 900, 0.99))).toBeLessThan(score(sample(2, 0, 0)));
  });

  it("reads a car whose lap or distance is below zero as out of the world, keeping the session", () => {
    expect(computeFastestLapBisectionProbe(sample(2, -1, 0.5), 2)).toEqual({ kind: "out-of-world", sessionNum: 2 });
    expect(computeFastestLapBisectionProbe(sample(2, 3, -1), 2)).toEqual({ kind: "out-of-world", sessionNum: 2 });
    // A car the arrays do not reach is not in the world either.
    expect(computeFastestLapBisectionProbe(sample(2, 3, 0.5), 9)).toEqual({ kind: "out-of-world", sessionNum: 2 });
  });

  it("is missing without a SessionNum, or without telemetry", () => {
    expect(computeFastestLapBisectionProbe(sample(undefined, 3, 0.5), 2)).toEqual({ kind: "missing" });
    expect(computeFastestLapBisectionProbe(null, 2)).toEqual({ kind: "missing" });
  });
});
