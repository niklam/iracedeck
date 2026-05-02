/**
 * Unit tests for the pit-readback diff translator (issue #476, #481).
 *
 * Pins:
 *   - first-tick seeding (no spurious entry from boot-on-pit-road)
 *   - `pitLane.approaching` in pending emits "entry"
 *   - reset/teleport (OnPitRoad off→on with no approach event) stays silent
 *   - on-pit-road + user toggle in the same tick emits "entry-refire"
 *   - on→off schedules an exit fire that emits after the delay elapses
 *   - re-approach during the delay window cancels the scheduled exit
 *   - issue #481: event payload carries only `reason` (the
 *     queued-services snapshot is read at fire time by the audio side
 *     via `getReadbackSnapshot()`)
 */
import { EngineWarnings, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { buildSnapshot, diffPitReadback, PIT_READBACK_EXIT_DELAY_MS } from "./pit-readback.js";
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

describe("buildSnapshot", () => {
  it("decodes pit-service flags into the queued-services view", () => {
    expect(
      buildSnapshot(
        tick({
          PitSvFlags: PitSvFlags.FuelFill | PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
          EngineWarnings: 0,
        }),
      ),
    ).toMatchObject({
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: false, rr: false },
      compoundChange: null,
      limiterEngaged: false,
    });
  });

  it("captures limiterEngaged from EngineWarnings", () => {
    expect(buildSnapshot(tick({ EngineWarnings: EngineWarnings.PitSpeedLimiter }))).toMatchObject({
      limiterEngaged: true,
    });
  });

  it("flags a compound change when queued compound differs from player", () => {
    expect(
      buildSnapshot(
        tick({
          PitSvFlags:
            PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange,
          PitSvTireCompound: 1,
          PlayerTireCompound: 0,
        }),
      ),
    ).toMatchObject({ compoundChange: { from: 0, to: 1 } });
  });

  it("does not flag a compound change when the queued compound matches the fitted compound", () => {
    expect(
      buildSnapshot(
        tick({
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
          PitSvTireCompound: 0,
          PlayerTireCompound: 0,
        }),
      ),
    ).toMatchObject({ compoundChange: null });
  });
});

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
  it("emits 'entry' with reason-only payload when pitLane.approaching is in pending", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    // The car is still off pit road during the approach zone — the
    // approach event fires BEFORE OnPitRoad flips true.
    state.pitReadbackPrevOnPitRoad = false;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({
        PitSvFlags: PitSvFlags.FuelFill | PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
        EngineWarnings: 0,
      }),
      0,
      emit,
      [{ event: "pitLane.approaching", data: {} }],
    );

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    // Issue #481: the event payload carries only `reason`. The
    // queued-services snapshot is read at fire time by the audio side
    // via `getReadbackSnapshot()`, so it doesn't ride on the event.
    expect(readbacks[0]?.data).toEqual({ reason: "entry" });
  });

  it("stays silent on reset/teleport-to-pits (OnPitRoad off→on with no approach event)", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    // Car materialised on pit road this tick — `diffPitLane` would only
    // emit `pitLane.entered`, not `pitLane.approaching`, because the
    // approach zone was bypassed entirely.
    state.lastOnPitRoad = true;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 0, emit, [
      { event: "pitLane.entered", data: {} },
    ]);

    expect(readbackEvents(events)).toHaveLength(0);
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
    expect(readbacks[0]?.data).toEqual({ reason: "entry-refire" });
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

  it("emits 'exit' once the delay has elapsed", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    const fireDeadline = 1000 + PIT_READBACK_EXIT_DELAY_MS;
    state.pitReadbackExitFireAt = fireDeadline;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), fireDeadline, emit, []);

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    // Issue #481: the audio side reads queued-services state fresh at
    // fire time via `getReadbackSnapshot()`. The diff just emits the
    // trigger reason.
    expect(readbacks[0]?.data).toEqual({ reason: "exit" });
    expect(state.pitReadbackExitFireAt).toBe(0);
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

  it("re-approaching cancels the pending exit fire and emits a fresh entry", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    state.pitReadbackExitFireAt = 1000;
    // Approach fires while still off pit road — same as a fresh natural
    // entry, but the scheduled exit is still pending from the prior pit-out.
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(
      state,
      tick({ PitSvFlags: PitSvFlags.FuelFill }),
      // Time has advanced past the exit-fire deadline, but a fresh
      // approach pre-empts the queued exit.
      1000 + PIT_READBACK_EXIT_DELAY_MS,
      emit,
      [{ event: "pitLane.approaching", data: {} }],
    );

    const readbacks = readbackEvents(events);
    // Approach must take precedence over the overdue exit — exactly one
    // event fires this tick, and it's the entry. Asserting the full
    // shape (length + reason) catches a regression where both exit and
    // entry fire in the same tick.
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toEqual({ reason: "entry" });
    expect(state.pitReadbackExitFireAt).toBe(0);
  });

  it("clears the queued pre-start fire when a natural pit approach fires", () => {
    const state = createInitialState();
    state.pitReadbackInitialized = true;
    state.pitReadbackPrevOnPitRoad = false;
    // Driver was in formation/grid pre-start when the auto-readback got
    // scheduled, then dove into pit road for whatever reason. The
    // approach event fires before the pre-start timer would have.
    state.pitReadbackPreStartFireAt = 999_999;
    state.lastOnPitRoad = false;

    const { events, emit } = collect();
    diffPitReadback(state, tick({ PitSvFlags: PitSvFlags.FuelFill }), 0, emit, [
      { event: "pitLane.approaching", data: {} },
    ]);

    const readbacks = readbackEvents(events);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0]?.data).toEqual({ reason: "entry" });
    // Without the disarm, the pre-start timer would fire a duplicate
    // `entry` once the queued deadline elapsed.
    expect(state.pitReadbackPreStartFireAt).toBe(0);
  });
});
