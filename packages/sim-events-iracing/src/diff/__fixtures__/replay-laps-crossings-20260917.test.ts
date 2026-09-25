import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type FixtureTick = {
  t: number;
  CarIdxLapCompleted: number[];
};

const ticks = JSON.parse(
  readFileSync(new URL("./replay-laps-crossings-20260917.json", import.meta.url), "utf-8"),
) as FixtureTick[];

describe("the 2026-09-17 lap-crossings fixture", () => {
  it("starts with every counter at −1 and carries three crossings of every car, one of the pace car", () => {
    expect(ticks[0].CarIdxLapCompleted).toEqual(Array<number>(21).fill(-1));

    const crossings = Array<number>(21).fill(0);
    let other = 0;

    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1].CarIdxLapCompleted;
      const cur = ticks[i].CarIdxLapCompleted;

      for (let c = 0; c < cur.length; c++) {
        if (cur[c] === prev[c]) continue;

        if ((prev[c] >= 0 && cur[c] === prev[c] + 1) || (prev[c] === -1 && cur[c] === 0)) crossings[c] += 1;
        else other += 1;
      }
    }

    expect(crossings.slice(0, 20)).toEqual(Array<number>(20).fill(3));
    expect(crossings[20]).toBe(1); // the pace car — slot 20 — crosses once, at 333.38 s
    expect(other).toBe(0); // no tow, reset or drop in this window
  });

  it("keeps the pace car at −1 through both field crossings", () => {
    const beforePaceCar = ticks.filter((tick) => tick.t < 333);

    expect(beforePaceCar.length).toBe(ticks.length - 1);
    expect(beforePaceCar.every((tick) => tick.CarIdxLapCompleted[20] === -1)).toBe(true);
  });

  it("records one change per tick in sessionTime order", () => {
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].t).toBeGreaterThan(ticks[i - 1].t);
      expect(ticks[i].CarIdxLapCompleted).not.toEqual(ticks[i - 1].CarIdxLapCompleted);
    }
  });
});
