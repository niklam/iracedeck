/**
 * Fuel laps-remaining threshold crossings.
 *
 * Maintains per-lap fuel-used history (conservative dual-window average)
 * and emits `fuel.lapsRemaining.crossed { threshold, laps }` exactly once
 * per descending crossing of FUEL_THRESHOLDS. Consumers (scenarios) filter
 * on `threshold` in their `where` predicate to react to specific tiers.
 *
 * Keeps the full fuel state machine from `pit-crew.handleFuelWarnings`
 * minus the audio dispatch — the action still owns pool selection and
 * radio-flow sequencing.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Descending thresholds (laps remaining). Each crosses once per stint. */
export const FUEL_THRESHOLDS = [5, 3, 1, 0] as const;

const MIN_HISTORY_FOR_CROSSINGS = 2;

export function diffFuel(state: TranslatorState, telemetry: TelemetryData, isRaceSession: boolean, emit: EmitFn): void {
  if (!isRaceSession) return;

  const fuelLevel = telemetry.FuelLevel;

  if (typeof fuelLevel !== "number" || fuelLevel < 0) return;

  const currentLap = typeof telemetry.Lap === "number" ? telemetry.Lap : -1;

  // Seed on first valid tick
  if (state.fuelAtLapStart === null) {
    state.fuelAtLapStart = fuelLevel;
    state.fuelLastLap = currentLap;

    return;
  }

  // Lap boundary → sample per-lap consumption
  if (currentLap !== state.fuelLastLap && currentLap > 0) {
    const used = state.fuelAtLapStart - fuelLevel;

    if (used > 0) {
      state.fuelHistory.push(used);

      if (state.fuelHistory.length > 5) state.fuelHistory.shift();
    }

    state.fuelAtLapStart = fuelLevel;
    state.fuelLastLap = currentLap;
  }

  if (state.fuelHistory.length < MIN_HISTORY_FOR_CROSSINGS) return;

  // Conservative (pessimistic) average — scenarios use this for warnings.
  const avgPerLap = state.fuelHistory.reduce((a, b) => Math.max(a, b), 0);

  if (avgPerLap <= 0) return;

  const laps = fuelLevel / avgPerLap;
  state.lastLapsRemaining = laps;

  // Emit one crossing per descending threshold, once per stint. A refuel
  // clears the fired set via the translator's refuel detector (not yet
  // implemented — for now, thresholds are sticky across the session).
  for (const threshold of FUEL_THRESHOLDS) {
    if (laps <= threshold && !state.fuelFiredThresholds.has(threshold)) {
      state.fuelFiredThresholds.add(threshold);
      emit({ event: "fuel.lapsRemaining.crossed", data: { threshold, laps } });
    }
  }
}
