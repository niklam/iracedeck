/**
 * Pit Crew scenario catalog registration.
 *
 * The engine wires:
 *   - The directional radar (state-driven tick loop, not expressible in the
 *     scenario DSL — design doc §15)
 *   - The acknowledgment pool (used by every voice toggle scenario)
 *   - The radio-frame include scenarios (`@pit-crew.radio-open` / `…close`)
 *   - Fuel toggle scenarios (on/off via `pitService.toggled`)
 *   - Tire toggle scenarios (every meaningful tire-set selection, including
 *     singles, diagonals, and three-corner combos, via `tireService.changed`)
 *   - Tire compound scenarios (dry/wet via `tireService.compoundChanged`)
 *
 * Other voice scenarios (welcome, pit-approach, flag/fuel-warning/incident
 * alerts, limiter callouts, tips, windshield/fastRepair/drs/p2p toggles) stay
 * on disk and are re-registered one at a time as their voice/ content lands.
 *
 * `bus` is the event bus instance returned by `initializeEventBus(...)`;
 * passed through to `registerRadarEngine` so the radar engine and the
 * scenario engine share the same bus. Must be called once per plugin
 * startup, AFTER `initializeAudioScenarios(bus, …)`.
 */
import type { IEventBus } from "@iracedeck/event-bus";

import { getScenarioEngine } from "../../interpreter.js";
import { POOLS } from "./pools.js";
import { registerRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { FUEL_TOGGLE_SCENARIOS, TIRE_COMPOUND_SCENARIOS, TIRE_TOGGLE_SCENARIOS } from "./toggle-confirmations.js";

export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";

export function registerPitCrew(bus: IEventBus): void {
  registerRadarEngine(bus);

  const engine = getScenarioEngine();

  engine.definePool("acknowledgment", [...POOLS.acknowledgment]);

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of FUEL_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_COMPOUND_SCENARIOS) engine.defineScenario(s);
}
