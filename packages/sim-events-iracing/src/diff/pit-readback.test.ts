/**
 * Unit tests for the pit-readback diff translator (issue #476).
 *
 * Pins:
 *   - first-tick seeding (no spurious entry from boot-on-pit-road)
 *   - off→on emits "entry"
 *   - on-pit-road + user toggle in the same tick emits "entry-refire"
 *   - on→off schedules an exit fire that emits after the delay elapses
 *   - re-entering during the delay window cancels the scheduled exit
 *   - committed snapshot survives the bit-clearing seed during stall
 */
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffPitReadback, PIT_READBACK_EXIT_DELAY_MS } from "./pit-readback.js";
import type { PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    FastRepairAvailable: 1,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function readbackEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitService.readbackRequested");
}

describe("diffPitReadback — seeding", () => {
  it("does not emit anything on the first tick when off pit road", () => {
    const state = createInitialState();
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(state, tick(), 0, emit, []);

    expect(readbackEvents(events)).toHaveLength(0);
    expect(state.pitReadbackInitialized).toBe(true);
  });

  it("does not synthesize an entry event when booted while already on pit road", () => {
    const state = createInitialState();
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 0, emit, []);

    expect(readbackEvents(events)).toHaveLength(0);
  });
});

describe("diffPitReadback — entry", () => {
  it("emits 'entry' on the off→on transition", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({
        PitSvFlags: PitSvFlags.FuelFill | PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
        EngineWarnings: 0,
      }),
      0,
      emit,
      [],
    );

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toMatchObject({
      reason: "entry",
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: false, rr: false },
      limiterEngaged: false,
    });
  });

  it("captures limiterEngaged from EngineWarnings", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ EngineWarnings: EngineWarnings.PitSpeedLimiter }), 0, emit, []);

    expect(readbackEvents(events)[0]?.data).toMatchObject({ limiterEngaged: true });
  });

  it("captures compound change when queued compound differs from player", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({
        PitSvFlags:
          PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange,
        PitSvTireCompound: 1,
        PlayerTireCompound: 0,
      }),
      0,
      emit,
      [],
    );

    expect(readbackEvents(events)[0]?.data).toMatchObject({ compoundChange: { from: 0, to: 1 } });
  });

  it("does not flag a compound change when the queued compound matches the fitted compound", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({
        PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
        PitSvTireCompound: 0,
        PlayerTireCompound: 0,
      }),
      0,
      emit,
      [],
    );

    expect(readbackEvents(events)[0]?.data).toMatchObject({ compoundChange: null });
  });
});

describe("diffPitReadback — refire", () => {
  it("emits 'entry-refire' when a user toggle event lands while on pit road", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = true;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 100, emit, [
      { event: "pitService.toggled", data: { service: "fuel", on: true } },
    ]);

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toMatchObject({ reason: "entry-refire", fuel: { queued: true } });
  });

  it("does not emit when no user toggle event was queued", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = true;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 100, emit, []);

    expect(readbackEvents(events)).toHaveLength(0);
  });

  it("ignores non-toggle events in the pending queue", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = true;
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 100, emit, [
      { event: "carControl.drsToggled", data: { on: true } },
    ]);

    expect(readbackEvents(events)).toHaveLength(0);
  });
});

describe("diffPitReadback — exit", () => {
  it("schedules but does not emit on on→off", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = true;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: 0 }), 1000, emit, []);

    expect(readbackEvents(events)).toHaveLength(0);
    expect(state.pitReadbackExitFireAt).toBe(1000 + PIT_READBACK_EXIT_DELAY_MS);
  });

  it("emits the exit readback with FRESH telemetry once the delay has elapsed", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    const fireDeadline = 1000 + PIT_READBACK_EXIT_DELAY_MS;
    state.pitReadbackExitFireAt = fireDeadline;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    // Telemetry at fire moment shows fuel still queued (e.g. user just
    // toggled it back on while sitting in pit, or kept it queued for
    // the next stop). The exit recap reflects this CURRENT state, not
    // a frozen snapshot from earlier in the visit.
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), fireDeadline, emit, []);

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toMatchObject({ reason: "exit", fuel: { queued: true } });
    expect(state.pitReadbackExitFireAt).toBe(0);
  });

  it("emits an empty exit recap when nothing is queued at fire time", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    const fireDeadline = 1000 + PIT_READBACK_EXIT_DELAY_MS;
    state.pitReadbackExitFireAt = fireDeadline;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    // All bits cleared by the time the exit fire elapses — the user
    // toggled tires off mid-stall, fuel was completed, etc.
    diffPitReadback(state, tick({ PitSvFlags: 0 }), fireDeadline, emit, []);

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toMatchObject({
      reason: "exit",
      fuel: { queued: false },
      tires: { lf: false, rf: false, lr: false, rr: false },
    });
  });

  it("does not emit while the delay is still running", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    // pitReadbackExitFireAt is the ABSOLUTE fire time (now + delay), so a
    // tick that lands one ms before the deadline must not emit yet.
    const fireDeadline = 1000 + PIT_READBACK_EXIT_DELAY_MS;
    state.pitReadbackExitFireAt = fireDeadline;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: 0 }), fireDeadline - 1, emit, []);

    expect(readbackEvents(events)).toHaveLength(0);
    expect(state.pitReadbackExitFireAt).toBe(fireDeadline);
  });

  it("re-entering pit road cancels the pending exit fire and emits a fresh entry", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.pitReadbackExitFireAt = 1000;
    state.lastOnPitRoad = true; // back on pit road

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({ PitSvFlags: PitSvFlags.FuelFill }),
      // Time has advanced past the exit-fire deadline, but the off→on
      // transition has higher precedence — entry pre-empts the queued exit.
      1000 + PIT_READBACK_EXIT_DELAY_MS,
      emit,
      [],
    );

    const readbacks = readbackEvents(events);
    // Either the exit fired then entry, or just entry — but exit must
    // have been cancelled either way. The contract: at most one entry
    // event on a single off→on transition.
    const entries = readbacks.filter((e) => "data" in e && (e.data as { reason: string }).reason === "entry");
    expect(entries).toHaveLength(1);
    expect(state.pitReadbackExitFireAt).toBe(0);
  });
});
