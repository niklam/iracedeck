import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffCaution } from "./caution.js";
import type { PendingEvent } from "./types.js";

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
});
