import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type FixtureTick = {
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  PitsOpen: boolean;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxLapCompleted: number[];
  CarIdxTrackSurface: number[];
};

const ticks = JSON.parse(
  readFileSync(new URL("./caution-restart-20260917.json", import.meta.url), "utf-8"),
) as FixtureTick[];

describe("the 2026-09-17 caution capture fixture", () => {
  it("carries both cautions and both restarts, in order", () => {
    const flags: number[] = [];

    for (const tick of ticks) {
      const f = tick.SessionFlags >>> 0;

      if (flags.at(-1) !== f) flags.push(f);
    }

    // The restart shape, twice: caution → one to go → green held → Green|StartGo.
    expect(flags.filter((f) => f === 0x10048000)).toHaveLength(2); // CautionWaving
    expect(flags.filter((f) => f === 0x10044600)).toHaveLength(2); // Caution|OneLapToGreen|GreenHeld
    expect(flags.filter((f) => f === 0x80040004)).toHaveLength(2); // Green|StartGo — the restarts
  });

  it("assigns every pace row within one tick of the caution flag", () => {
    const i = ticks.findIndex((tick) => ((tick.SessionFlags >>> 0) & 0x8000) !== 0);

    expect(i).toBeGreaterThan(0);
    expect(ticks[i + 1].CarIdxPaceRow.filter((r) => r >= 0).length).toBeGreaterThan(19);
  });
});
