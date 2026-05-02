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
 */
import { EngineWarnings, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { DAMAGE_DEBOUNCE_MS, diffDamage } from "./damage.js";
import type { PendingEvent } from "./types.js";

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
  it("emits after the debounce window when MandRepNeeded stays set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);

    expect(damageEvents(events)).toHaveLength(0);

    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100 + DAMAGE_DEBOUNCE_MS, emit);

    expect(damageEvents(events)).toHaveLength(1);
    expect(state.damageBaseline).toBe(true);
  });

  it("emits when OptRepNeeded crosses the threshold", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.OptRepNeeded }), 100, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.OptRepNeeded }), 100 + DAMAGE_DEBOUNCE_MS, emit);

    expect(damageEvents(events)).toHaveLength(1);
  });

  it("emits when both repair bits are set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded }), 100, emit);
    diffDamage(
      state,
      tick({ EngineWarnings: EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded }),
      100 + DAMAGE_DEBOUNCE_MS,
      emit,
    );

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
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100 + DAMAGE_DEBOUNCE_MS, emit);

    expect(damageEvents(events)).toHaveLength(1);

    // Repaired in pits — bit clears for longer than the debounce window.
    const t0 = 100 + DAMAGE_DEBOUNCE_MS + 1000;
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
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100 + DAMAGE_DEBOUNCE_MS, emit);
    expect(damageEvents(events)).toHaveLength(1);

    // Repair window — clean for ≥ debounce so baseline drops to false.
    const t0 = 100 + DAMAGE_DEBOUNCE_MS + 1000;
    diffDamage(state, tick({ EngineWarnings: 0 }), t0, emit);
    diffDamage(state, tick({ EngineWarnings: 0 }), t0 + DAMAGE_DEBOUNCE_MS, emit);
    expect(state.damageBaseline).toBe(false);

    // Fresh hit — second rising edge fires another event.
    const t1 = t0 + DAMAGE_DEBOUNCE_MS + 1000;
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.OptRepNeeded }), t1, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.OptRepNeeded }), t1 + DAMAGE_DEBOUNCE_MS, emit);

    expect(damageEvents(events)).toHaveLength(2);
  });

  it("does not re-fire if the bit stays set after the first emit", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffDamage(state, tick(), 0, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100, emit);
    diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), 100 + DAMAGE_DEBOUNCE_MS, emit);

    // Many more ticks with the bit still set — no new events.
    for (let t = 100 + DAMAGE_DEBOUNCE_MS + 1000; t < 100 + DAMAGE_DEBOUNCE_MS + 30_000; t += 1000) {
      diffDamage(state, tick({ EngineWarnings: EngineWarnings.MandRepNeeded }), t, emit);
    }

    expect(damageEvents(events)).toHaveLength(1);
  });
});
