/**
 * Fuel warning scenarios — fire on `fuel.lapsRemaining.crossed` events
 * emitted by `@iracedeck/sim-events-iracing` at the 5 / 3 / 1 / 0 lap
 * descending thresholds.
 *
 * Priority mapping (preserved from the legacy pit-crew):
 *   - 5 laps: `priority: "normal"` — advisory, pit-lane messages still take
 *     precedence.
 *   - 3 / 1 / 0 laps: `priority: "urgent"` + `preempt: true` — these
 *     callouts interrupt lesser in-flight scenarios because the driver
 *     needs to hear them immediately.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

function fuelScenario(id: string, threshold: number, pool: string, options: { urgent: boolean }): Scenario {
  return {
    id,
    when: {
      event: "fuel.lapsRemaining.crossed",
      where: (e) => (e as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold === threshold,
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: options.urgent ? "urgent" : "normal",
    preempt: options.urgent ? true : undefined,
    sequence: ["@pit-crew.radio-open", `pool:${pool}`, "@pit-crew.radio-close"],
  };
}

export const FUEL_WARNINGS: readonly Scenario[] = [
  fuelScenario("pit-crew.fuel-low-5laps", 5, "fuel-low-5laps", { urgent: false }),
  fuelScenario("pit-crew.fuel-low-3laps", 3, "fuel-low-3laps", { urgent: true }),
  fuelScenario("pit-crew.fuel-critical", 1, "fuel-critical", { urgent: true }),
  fuelScenario("pit-crew.fuel-empty", 0, "fuel-empty", { urgent: true }),
];

export const FUEL_SCENARIO_IDS: readonly string[] = FUEL_WARNINGS.map((s) => s.id);
