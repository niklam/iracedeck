/**
 * Unit tests for the pit-service status diff translator (issue #479).
 *
 * Pins:
 *   - first-tick seeding (no fire when connecting mid-stop)
 *   - off-track / in-pit-stall re-seeding (no phantom callouts on garage
 *     return or replay scrubs)
 *   - one event per non-`None` target, with correct `from` / `to`
 *   - `* → None` closing transitions are silent (baseline still advances)
 *   - positioning corrections (`TooFarLeft → TooFarRight`) emit with the
 *     direct from/to pair
 *   - re-emit on subsequent transitions after a closing-to-`None`
 */
import { PitSvStatus, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffPitStatus } from "./pit-status.js";
import type { PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    PlayerCarInPitStall: false,
    PlayerCarPitSvStatus: PitSvStatus.None,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function statusEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitService.statusChanged");
}

describe("diffPitStatus — seeding", () => {
  it("does not emit on the first tick when idle", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);

    expect(statusEvents(events)).toHaveLength(0);
    expect(state.pitStatusInitialized).toBe(true);
    expect(state.lastPitSvStatus).toBe(PitSvStatus.None);
  });

  it("does not emit when connecting mid-stop (status already InProgress)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);

    expect(statusEvents(events)).toHaveLength(0);
    expect(state.lastPitSvStatus).toBe(PitSvStatus.InProgress);
  });

  it("does not emit while off-track (garage / replay scrub)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick({ IsOnTrack: false, PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);
    diffPitStatus(state, tick({ IsOnTrack: false, PlayerCarPitSvStatus: PitSvStatus.Complete }), emit);

    expect(statusEvents(events)).toHaveLength(0);
  });
});

describe("diffPitStatus — emission inside pit stall (production case)", () => {
  // Every one of the eight callouts only fires while parked in the stall.
  // Production-captured telemetry confirms `IsOnTrack: true,
  // PlayerCarInPitStall: true, PlayerCarPitSvStatus: 1` (InProgress) during
  // an active stop. The diff must NOT re-seed silently on `inPitStall`.
  it("emits InProgress and Complete during a normal stop", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: idle on pit road, just before the stall.
    diffPitStatus(state, tick(), emit);
    // Crew starts working.
    diffPitStatus(state, tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);
    // Crew finishes.
    diffPitStatus(state, tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.Complete }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
    expect(fired[1].data).toEqual({ from: PitSvStatus.InProgress, to: PitSvStatus.Complete });
  });

  it("matches the production-captured snapshot — IsOnTrack:true + InPitStall:true + status=1 fires InProgress", () => {
    // Pinned against `master/local/telemetry-snapshot-20260505-192236.json`
    // (lines 27, 57, 58). Regression guard for the original bug where
    // `inPitStall` re-seeded silently and swallowed every callout.
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit); // seed at None outside stall
    diffPitStatus(
      state,
      tick({
        IsOnTrack: true,
        PlayerCarInPitStall: true,
        PlayerCarPitSvStatus: 1, // PitSvStatus.InProgress, exactly as captured
      }),
      emit,
    );

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
  });

  it("emits a positioning correction while in the stall", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.TooFarLeft }), emit);
    diffPitStatus(state, tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.TooFarRight }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.TooFarLeft, to: PitSvStatus.TooFarRight });
  });
});

describe("diffPitStatus — emission", () => {
  it.each([
    PitSvStatus.InProgress,
    PitSvStatus.Complete,
    PitSvStatus.TooFarLeft,
    PitSvStatus.TooFarRight,
    PitSvStatus.TooFarForward,
    PitSvStatus.TooFarBack,
    PitSvStatus.BadAngle,
    PitSvStatus.CantFixThat,
  ])("emits one statusChanged event when transitioning None → %s", (target) => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: target }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: target });
    expect(state.lastPitSvStatus).toBe(target);
  });

  it("emits with direct from/to on a positioning correction (TooFarLeft → TooFarRight)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarLeft }), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarRight }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.TooFarLeft, to: PitSvStatus.TooFarRight });
  });

  it("does not emit on duplicate ticks of the same status", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);

    expect(statusEvents(events)).toHaveLength(1);
  });
});

describe("diffPitStatus — silent close", () => {
  it("absorbs `* → None` without emitting but still advances the baseline", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.Complete }), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.None }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.Complete });
    expect(state.lastPitSvStatus).toBe(PitSvStatus.None);
  });

  it("re-fires on the next pit stop after a `* → None` close", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.None }), emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
  });
});
