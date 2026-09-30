/**
 * Unit tests for the damage diff translator (issue #489).
 *
 * Pins:
 *   - first-tick seeding (no fire when connecting mid-damage)
 *   - rising edge fires after the debounce window
 *   - sub-window blip is filtered (no fire)
 *   - clear → damaged cycles re-fire on each new rising edge
 *   - falling edge does not emit anything
 *   - either MandRepNeeded or OptRepNeeded (or both) fires the same event
 *   - the settled edge is held behind an incident burst (#1211): it emits
 *     after DAMAGE_INCIDENT_GRACE_MS when no burst comes, or on the flush
 *     tick of a burst that was open or opened during the hold, after that
 *     flush's incident events; a repair bit falling while held emits nothing
 *
 * `settle()` drives a rising edge to its settle and then past the grace, so
 * the tests that pin the edge detection itself stay about the edge.
 */
import { EngineWarnings, IncidentFlags, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { DAMAGE_DEBOUNCE_MS, DAMAGE_INCIDENT_GRACE_MS, diffDamage } from "./damage.js";
import { diffIncidents, INCIDENT_BURST_QUIET_MS } from "./incidents.js";
import type { EmitFn, PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    EngineWarnings: 0,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function damageEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "damage.repairNeeded.raised");
}

/**
 * Hold `warnings` from `at` through the debounce settle and on past the
 * grace, so a rising edge emits by the last tick. Returns the last tick's
 * timestamp.
 */
function settle(state: TranslatorState, warnings: number, at: number, emit: EmitFn): number {
  diffDamage(state, tick({ EngineWarnings: warnings }), at, emit);
  diffDamage(state, tick({ EngineWarnings: warnings }), at + DAMAGE_DEBOUNCE_MS, emit);
  const end = at + DAMAGE_DEBOUNCE_MS + DAMAGE_INCIDENT_GRACE_MS;
  diffDamage(state, tick({ EngineWarnings: warnings }), end, emit);

  return end;
}

describe("diffDamage — seeding", () => {
  it("does not emit on the first tick when clean", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);

    expect(damageEvents(events)).toHaveLength(0);
    expect(state.damageInitialized).toBe(true);
    expect(state.damageBaseline).toBe(false);
  });

  it("does not emit on the first tick when already damaged (mid-damage connect)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 0, emit);

    expect(damageEvents(events)).toHaveLength(0);
    expect(state.damageBaseline).toBe(true);
  });
});

describe("diffDamage — rising edge", () => {
  it("settles after the debounce window when MandRepNeeded stays set, then emits once the grace has passed", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);

    expect(damageEvents(events)).toHaveLength(0);

    const settledAt = 100 + DAMAGE_DEBOUNCE_MS;
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), settledAt, emit);

    // Settled but held (#1211): no incident burst is open, so the emit waits
    // out the grace in case the crash's count increment is still to come.
    expect(damageEvents(events)).toHaveLength(0);
    expect(state.damageBaseline).toBe(true);
    expect(state.damageHeldAt).toBe(settledAt);

    const graceEnd = settledAt + DAMAGE_INCIDENT_GRACE_MS;
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), graceEnd - 1, emit);
    expect(damageEvents(events)).toHaveLength(0);

    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), graceEnd, emit);
    expect(damageEvents(events)).toHaveLength(1);
    expect(state.damageHeldAt).toBe(0);
  });

  it("emits when OptRepNeeded crosses the threshold", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    settle(state, EngineWarnings.OptRepNeeded, 100, emit);

    expect(damageEvents(events)).toHaveLength(1);
  });

  it("emits when both repair bits are set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    settle(state, EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded, 100, emit);

    expect(damageEvents(events)).toHaveLength(1);
  });

  it("ignores other EngineWarnings bits (water/oil/limiter) without firing", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(
      state,
      tick({
        EngineWarnings:
          EngineWarnings.WaterTempWarning | EngineWarnings.OilTempWarning | EngineWarnings.PitSpeedLimiter,
      }),
      DAMAGE_DEBOUNCE_MS + 1,
      emit,
    );

    expect(damageEvents(events)).toHaveLength(0);
  });
});

describe("diffDamage — debounce filtering", () => {
  it("does not emit when damage clears before the debounce window elapses", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);
    // Cleared 1 second later — well below the 3000 ms window.
    diffDamage(state, tick({ EngineWarnings: 0 }), 1100, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), 5000, emit);

    expect(damageEvents(events)).toHaveLength(0);
    expect(state.damageBaseline).toBe(false);
  });

  it("does not emit when the bit oscillates within the window", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), 500, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 1000, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), 1500, emit);
    // The pending flip resets on every direction change — the most recent
    // "damaged" sample at t=1000 is still inside the window when we settle
    // back to clean at t=1500, so nothing fires.
    diffDamage(state, tick({ EngineWarnings: 0 }), 5000, emit);

    expect(damageEvents(events)).toHaveLength(0);
  });
});

describe("diffDamage — falling edge and re-rising", () => {
  it("does not emit on the falling edge when damage clears", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    const emittedAt = settle(state, EngineWarnings.MandRepNeeded, 100, emit);

    expect(damageEvents(events)).toHaveLength(1);

    // Repaired in pits — bit clears for longer than the debounce window.
    const t0 = emittedAt + 1000;
    diffDamage(state, tick({ EngineWarnings: 0 }), t0, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), t0 + DAMAGE_DEBOUNCE_MS, emit);

    // No second event from the falling edge.
    expect(damageEvents(events)).toHaveLength(1);
    expect(state.damageBaseline).toBe(false);
  });

  it("re-fires on a fresh damage edge after a clean window", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    const emittedAt = settle(state, EngineWarnings.MandRepNeeded, 100, emit);
    expect(damageEvents(events)).toHaveLength(1);

    // Repair window — clean for ≥ debounce so baseline drops to false.
    const t0 = emittedAt + 1000;
    diffDamage(state, tick({ EngineWarnings: 0 }), t0, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), t0 + DAMAGE_DEBOUNCE_MS, emit);
    expect(state.damageBaseline).toBe(false);

    // Fresh hit — second rising edge fires another event.
    settle(state, EngineWarnings.OptRepNeeded, t0 + DAMAGE_DEBOUNCE_MS + 1000, emit);

    expect(damageEvents(events)).toHaveLength(2);
  });

  it("does not re-fire if the bit stays set after the first emit", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    const emittedAt = settle(state, EngineWarnings.MandRepNeeded, 100, emit);
    expect(damageEvents(events)).toHaveLength(1);

    // Many more ticks with the bit still set — no new events.
    for (let t = emittedAt + 1000; t < emittedAt + 30_000; t += 1000) {
      diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), t, emit);
    }

    expect(damageEvents(events)).toHaveLength(1);
  });
});

/**
 * The hold behind an incident burst (#1211). These drive `diffIncidents` and
 * then `diffDamage` with ONE shared emit per tick, the order the translator
 * runs them in (`translator.ts`), so a tick's emits read in publish order.
 */
describe("diffDamage — held behind an incident burst (issue #1211)", () => {
  const DAMAGED = EngineWarnings.MandRepNeeded;

  function fullTick(overrides: Partial<TelemetryData> = {}): TelemetryData {
    return {
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerTrackSurface: TrkLoc.OnTrack,
      PlayerTrackSurfaceMaterial: 0,
      PlayerCarMyIncidentCount: 0,
      PlayerIncidents: 0,
      EngineWarnings: 0,
      ...overrides,
    } as unknown as TelemetryData;
  }

  /** Run one translator-ordered tick and return that tick's event names. */
  function step(state: TranslatorState, telemetry: TelemetryData, now: number, all: PendingEvent[]): string[] {
    const tickEvents: PendingEvent[] = [];
    const emit: EmitFn = (e) => {
      tickEvents.push(e);
      all.push(e);
    };
    diffIncidents(state, telemetry, now, emit);
    diffDamage(state, telemetry, now, emit);

    return tickEvents.map((e) => e.event);
  }

  it("emits after DAMAGE_INCIDENT_GRACE_MS when no incident comes, and not before", () => {
    const state = createInitialState();
    const all: PendingEvent[] = [];
    step(state, fullTick(), 0, all);
    step(state, fullTick({ EngineWarnings: DAMAGED }), 1_000, all);

    const settledAt = 1_000 + DAMAGE_DEBOUNCE_MS;
    expect(step(state, fullTick({ EngineWarnings: DAMAGED }), settledAt, all)).toEqual([]);

    for (let t = settledAt + 100; t < settledAt + DAMAGE_INCIDENT_GRACE_MS; t += 100) {
      expect(step(state, fullTick({ EngineWarnings: DAMAGED }), t, all)).toEqual([]);
    }

    const graceEnd = settledAt + DAMAGE_INCIDENT_GRACE_MS;
    expect(step(state, fullTick({ EngineWarnings: DAMAGED }), graceEnd, all)).toEqual(["damage.repairNeeded.raised"]);
    expect(damageEvents(all)).toHaveLength(1);
  });

  it("holds a settle made during an open burst to the flush tick, after incident.scored and incident.occurred", () => {
    const state = createInitialState();
    const all: PendingEvent[] = [];
    step(state, fullTick(), 0, all);
    step(state, fullTick({ EngineWarnings: DAMAGED }), 1_000, all);

    // The crash is counted just before the damage settles, so the burst is
    // open on the settle tick.
    const crashed = { EngineWarnings: DAMAGED, PlayerCarMyIncidentCount: 4 };
    const incrementAt = 1_000 + DAMAGE_DEBOUNCE_MS - 200;
    step(state, fullTick({ ...crashed, PlayerIncidents: IncidentFlags.RepCollisionWithCar }), incrementAt, all);

    const settledAt = 1_000 + DAMAGE_DEBOUNCE_MS;
    expect(step(state, fullTick(crashed), settledAt, all)).toEqual([]);
    expect(state.damageHeldAt).toBe(settledAt);

    const flushAt = incrementAt + INCIDENT_BURST_QUIET_MS;
    expect(step(state, fullTick(crashed), flushAt - 1, all)).toEqual([]);
    expect(step(state, fullTick(crashed), flushAt, all)).toEqual([
      "incident.scored",
      "incident.occurred",
      "damage.repairNeeded.raised",
    ]);
    expect(damageEvents(all)).toHaveLength(1);
  });

  it("holds the emit to the flush of a burst that opens inside the grace (the 14:54 log timings)", () => {
    // 14:54:14.520 damage settled; 14:54:15.157 report byte; 14:54:15.422
    // count +1 (0.9 s after the settle); 14:54:16.934 flush. The flush lands
    // 2.4 s after the settle, past the 2 s grace, so the grace alone would
    // have released the damage line first.
    const state = createInitialState();
    const all: PendingEvent[] = [];
    step(state, fullTick(), 0, all);

    const bitsRoseAt = 10_000;
    const settledAt = bitsRoseAt + DAMAGE_DEBOUNCE_MS;
    const byteAt = settledAt + 637;
    const incrementAt = settledAt + 902;
    const flushAt = incrementAt + INCIDENT_BURST_QUIET_MS;
    expect(flushAt - settledAt).toBeGreaterThan(DAMAGE_INCIDENT_GRACE_MS);

    step(state, fullTick({ EngineWarnings: DAMAGED }), bitsRoseAt, all);
    expect(step(state, fullTick({ EngineWarnings: DAMAGED }), settledAt, all)).toEqual([]);

    const crashed = { EngineWarnings: DAMAGED, PlayerCarMyIncidentCount: 2 };
    step(
      state,
      fullTick({ EngineWarnings: DAMAGED, PlayerIncidents: IncidentFlags.RepCollisionWithWorld }),
      byteAt,
      all,
    );
    step(state, fullTick(crashed), incrementAt, all);

    // Every tick between the increment and the flush stays silent, the one
    // where the grace expires among them.
    for (let t = incrementAt + 100; t < flushAt; t += 100) {
      expect(step(state, fullTick(crashed), t, all)).toEqual([]);
    }

    expect(step(state, fullTick(crashed), flushAt, all)).toEqual([
      "incident.scored",
      "incident.occurred",
      "damage.repairNeeded.raised",
    ]);
  });

  it("emits nothing when the repair bit falls while the emit is held, and resets the baseline", () => {
    const state = createInitialState();
    const all: PendingEvent[] = [];
    step(state, fullTick(), 0, all);
    step(state, fullTick({ EngineWarnings: DAMAGED }), 1_000, all);

    const settledAt = 1_000 + DAMAGE_DEBOUNCE_MS;
    step(state, fullTick({ EngineWarnings: DAMAGED }), settledAt, all);

    // The bit drops inside the grace and stays down, past the grace and past
    // the falling edge's own debounce.
    const fellAt = settledAt + 500;

    for (let t = fellAt; t <= fellAt + DAMAGE_DEBOUNCE_MS + DAMAGE_INCIDENT_GRACE_MS; t += 100) {
      step(state, fullTick(), t, all);
    }

    expect(damageEvents(all)).toHaveLength(0);
    expect(state.damageBaseline).toBe(false);
    expect(state.damageHeldAt).toBe(0);
  });

  it("defers, not cancels, the held emit on a tick where the repair bit reads clear", () => {
    // A one-tick flicker as the grace expires moves the emit to the next tick
    // the bit reads set.
    const state = createInitialState();
    const all: PendingEvent[] = [];
    step(state, fullTick(), 0, all);
    step(state, fullTick({ EngineWarnings: DAMAGED }), 1_000, all);

    const settledAt = 1_000 + DAMAGE_DEBOUNCE_MS;
    step(state, fullTick({ EngineWarnings: DAMAGED }), settledAt, all);

    const graceEnd = settledAt + DAMAGE_INCIDENT_GRACE_MS;
    expect(step(state, fullTick(), graceEnd, all)).toEqual([]);
    expect(step(state, fullTick({ EngineWarnings: DAMAGED }), graceEnd + 10, all)).toEqual([
      "damage.repairNeeded.raised",
    ]);
  });

  it("starts with nothing held", () => {
    const state = createInitialState();
    expect(state.damageHeldAt).toBe(0);
    expect(state.damageHeldSawBurst).toBe(false);
  });
});
