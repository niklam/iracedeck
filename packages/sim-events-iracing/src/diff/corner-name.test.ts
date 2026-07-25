import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffCornerName } from "./corner-name.js";
import type { EmitFn } from "./types.js";

const MARKERS: CornerMarker[] = [
  { startPct: 0.1, name: "Turn 1", slug: "turn-1" },
  { startPct: 0.5, name: "Eau Rouge", slug: "eau-rouge" },
  { startPct: 0.9, name: "Turn 3", slug: "turn-3" },
];

const TRACK_LENGTH = 5000;
const LEAD = () => 1;

function telemetry(overrides: Partial<TelemetryData>): TelemetryData {
  return { IsOnTrack: true, OnPitRoad: false, Speed: 50, ...overrides } as TelemetryData;
}

describe("diffCornerName", () => {
  let state: TranslatorState;
  let emit: EmitFn;

  beforeEach(() => {
    state = createInitialState();
    emit = vi.fn();
  });

  function tick(lapDistPct: number, overrides: Partial<TelemetryData> = {}): void {
    diffCornerName(state, telemetry({ LapDistPct: lapDistPct, ...overrides }), true, MARKERS, TRACK_LENGTH, LEAD, emit);
  }

  it("seeds silently on the first valid tick", () => {
    tick(0.05);
    expect(emit).not.toHaveBeenCalled();
  });

  it("fires when the lead point crosses a marker", () => {
    // Speed 50 m/s × 1 s / 5000 m = 0.01 lead. Lead point: 0.095 → 0.1005.
    tick(0.085);
    tick(0.0905);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ event: "cornerName.approaching", data: { name: "Turn 1", slug: "turn-1" } });
  });

  it("does not refire the same marker in the same lap", () => {
    tick(0.085);
    tick(0.0905);
    tick(0.0906);
    tick(0.0907);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("speaks only the marker nearest the lead point when several cross in one tick", () => {
    const dense: CornerMarker[] = [
      { startPct: 0.1, name: "A", slug: "a" },
      { startPct: 0.105, name: "B", slug: "b" },
    ];
    diffCornerName(state, telemetry({ LapDistPct: 0.08 }), true, dense, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.1 }), true, dense, TRACK_LENGTH, LEAD, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ event: "cornerName.approaching", data: { name: "B", slug: "b" } });
    // A was marked spoken too — moving on doesn't back-fire it.
    diffCornerName(state, telemetry({ LapDistPct: 0.101 }), true, dense, TRACK_LENGTH, LEAD, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("re-announces on the next lap (spoken set clears at S/F wrap)", () => {
    // Every step stays under the 0.05 teleport threshold.
    tick(0.85);
    tick(0.895); // lead point 0.905 — crosses Turn 3 at 0.9
    expect(emit).toHaveBeenCalledTimes(1);
    tick(0.94);
    tick(0.985);
    tick(0.02); // lead point wraps past S/F → spoken set clears
    tick(0.06);
    tick(0.0905); // lead point 0.1005 — Turn 1, new lap
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      event: "cornerName.approaching",
      data: { name: "Turn 1", slug: "turn-1" },
    });
  });

  it("re-anchors without firing on a teleport (reset to pits)", () => {
    tick(0.6);
    tick(0.05); // huge jump → teleport
    expect(emit).not.toHaveBeenCalled();
    // Fresh pass after the reset announces normally.
    tick(0.085);
    tick(0.0905);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("ignores backward motion", () => {
    tick(0.12);
    tick(0.095); // reversing
    tick(0.096);
    expect(emit).not.toHaveBeenCalled();
  });

  it("tracks but does not announce while on pit road", () => {
    tick(0.085, { OnPitRoad: true });
    tick(0.0905, { OnPitRoad: true });
    expect(emit).not.toHaveBeenCalled();
    // Marker was consumed — leaving pit road right after doesn't back-fire it.
    tick(0.0906);
    expect(emit).not.toHaveBeenCalled();
  });

  it("stays silent outside practice, off track, without markers or track length", () => {
    diffCornerName(state, telemetry({ LapDistPct: 0.085 }), false, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), false, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905, IsOnTrack: false }), true, MARKERS, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), true, null, TRACK_LENGTH, LEAD, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.0905 }), true, MARKERS, null, LEAD, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("clamps an absurd lead so a fast car on a short track cannot lap-wrap the lead point", () => {
    // 100 m/s × 5 s on a 1000 m track = 0.5 of a lap raw → clamped to 0.2.
    diffCornerName(state, telemetry({ LapDistPct: 0.0, Speed: 100 }), true, MARKERS, 1000, () => 5, emit);
    diffCornerName(state, telemetry({ LapDistPct: 0.001, Speed: 100 }), true, MARKERS, 1000, () => 5, emit);
    // Lead point moved 0.2 → 0.201; Turn 1 (0.1) is BEHIND the lead point
    // from the silent first-tick seed onward, so nothing crosses — no burst.
    expect(emit).not.toHaveBeenCalled();
  });
});
