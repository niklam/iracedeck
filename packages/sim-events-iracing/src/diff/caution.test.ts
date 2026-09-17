import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffCaution } from "./caution.js";
import type { PendingEvent } from "./types.js";

const ticks = JSON.parse(
  readFileSync(new URL("./__fixtures__/caution-restart-20260917.json", import.meta.url), "utf-8"),
) as Array<{ t: number; SessionFlags: number; SessionState: number; CarIdxTrackSurface: number[] }>;

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
      const surfaces = new Array(72).fill(3);

      tick.CarIdxTrackSurface.forEach((s, i) => (surfaces[i === 20 ? PACE : i] = s));
      diffCaution(state, { ...tick, CarIdxTrackSurface: surfaces } as unknown as TelemetryData, sessionInfo, emit);
    }

    // The fixture window starts at t=218.88, AFTER the rolling start's own pace-car
    // pair (deployed t=132.35, off t=196.53). What remains is one pair per caution:
    // deployed 264.27 / off 488.07, then deployed 561.63 / off 866.98.
    expect(events.filter((e) => e.event === "paceCar.deployed")).toHaveLength(2);
    expect(events.filter((e) => e.event === "paceCar.off")).toHaveLength(2);
  });
});
