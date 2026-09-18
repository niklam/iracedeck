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
  readFileSync(new URL("./caution-road-20260918.json", import.meta.url), "utf-8"),
) as FixtureTick[];

describe("the 2026-09-18 road-course caution capture fixture", () => {
  it("carries a caution whose waving flag goes static and one-to-go on ONE tick, and a second caution still waving at the end", () => {
    const flags: number[] = [];

    for (const tick of ticks) {
      const f = tick.SessionFlags >>> 0;

      if (flags.at(-1) !== f) flags.push(f);
    }

    // The road shape: CautionWaving → Caution|OneLapToGreen directly. There is
    // NO plain static caution (0x10044000) anywhere in the capture — that is
    // the tick the oval's "two to green" rides, and it does not exist here.
    expect(flags.filter((f) => f === 0x10048000)).toHaveLength(2); // CautionWaving, both cautions
    expect(flags.filter((f) => f === 0x10044000)).toHaveLength(0); // never static on its own
    expect(flags.filter((f) => f === 0x10044200)).toHaveLength(1); // Caution|OneLapToGreen
    expect(flags.filter((f) => f === 0x80040604)).toHaveLength(1); // Green|OneLapToGreen|GreenHeld|StartGo — the restart
    expect(ticks.at(-1)?.SessionFlags).toBe(0x10148000 | 0); // CautionWaving|Repair — the second caution, unresolved
  });

  it("lands the static caution and one to green on the same tick, at 309.33 s", () => {
    const i = ticks.findIndex((tick) => tick.SessionFlags >>> 0 === 0x10044200);
    const before = ticks[i - 1];

    expect(ticks[i].t).toBe(309.33);
    expect(before.SessionFlags >>> 0).toBe(0x10048000);
  });

  it("keeps the pace car — slot 20 — including its two mid-caution pit-exit blips and the real exit", () => {
    const offAt = ticks
      .filter((tick, i) => tick.CarIdxTrackSurface[20] === 2 && ticks[i - 1]?.CarIdxTrackSurface[20] === 3)
      .map((t) => t.t);
    const backAt = ticks
      .filter((tick, i) => tick.CarIdxTrackSurface[20] === 3 && ticks[i - 1]?.CarIdxTrackSurface[20] === 2)
      .map((t) => t.t);

    // AproachingPits for ~3 s and back on track, twice mid-caution; then the
    // real exit 5.7 s before the green (466.95), returning under green.
    expect(offAt).toEqual([152.23, 461.22, 562.07]);
    expect(backAt).toEqual([155.37, 494.18, 565.22]);
  });

  it("assigns every pace row within one tick of each caution flag", () => {
    const throws = ticks
      .map((tick, i) => i)
      .filter(
        (i) =>
          i > 0 && ((ticks[i].SessionFlags >>> 0) & 0x8000) !== 0 && ((ticks[i - 1].SessionFlags >>> 0) & 0x8000) === 0,
      );

    expect(throws).toHaveLength(2);

    for (const i of throws) {
      expect(ticks[i + 1].CarIdxPaceRow.filter((r) => r >= 0).length).toBeGreaterThan(19);
    }
  });
});
