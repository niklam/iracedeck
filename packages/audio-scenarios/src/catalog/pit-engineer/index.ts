/**
 * Pit-engineer scenario catalog registration.
 *
 * `registerPitEngineer(bus)` registers pools, defines the `{{name}}` driver
 * variable, and registers every pit-engineer scenario with the shared
 * scenario engine. The `bus` is the event bus instance returned by
 * `initializeEventBus(...)` — passed through to `registerSpotterEngine`
 * so the spotter engine and scenario engine share the exact same bus.
 * Must be called once per plugin startup, after
 * `initializeAudioScenarios(bus, ...)`.
 *
 * The driver-name resolver is injected by the pit-engineer action through
 * `setDriverNameResolver(getter)` so the scenario can read the latest PI
 * setting at fire time without the catalog owning action-specific state.
 */
import type { IEventBus } from "@iracedeck/event-bus";

import { getScenarioEngine } from "../../interpreter.js";
import { FLAG_ALERTS } from "./flag-alerts.js";
import { FUEL_WARNINGS } from "./fuel-warnings.js";
import { INCIDENT_ALERTS } from "./incident-alerts.js";
import { OVERTAKE } from "./overtake.js";
import { PIT_APPROACH } from "./pit-approach.js";
import { PIT_EXIT } from "./pit-exit.js";
import { PIT_LIMITER_SCENARIOS } from "./pit-limiter.js";
import { POOLS } from "./pools.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { SERVICE_REMINDER } from "./service-reminder.js";
import { registerSpotterEngine } from "./spotter-engine.js";
import { STALL_DEPARTURE } from "./stall-departure.js";
import { RACING_TIPS } from "./tips.js";
import { TOGGLE_CONFIRMATIONS } from "./toggle-confirmations.js";
import { WELCOME } from "./welcome.js";

export { FLAG_SCENARIO_IDS } from "./flag-alerts.js";
export { FUEL_SCENARIO_IDS } from "./fuel-warnings.js";
export { PIT_LIMITER_SCENARIO_IDS } from "./pit-limiter.js";
export {
  getSpotterVisualState,
  playSpotterTest,
  setSpotterEnabled,
  type SpotterVisualState,
  subscribeSpotterVisualState,
} from "./spotter-engine.js";
export { TOGGLE_SCENARIO_IDS } from "./toggle-confirmations.js";

let driverNameResolver: () => string | null = () => null;

/**
 * Register the pit-engineer scenario catalog with the scenario engine.
 *
 * Order matters:
 *   1. Pools are defined first so scenarios referencing them validate cleanly.
 *   2. `{{name}}` variable is registered before any scenario uses it.
 *   3. Include targets (`radio-open`, `radio-close`) are defined before
 *      their referencing scenarios so validation can resolve them.
 *   4. Event-driven scenarios (`welcome`, ...) are defined last.
 */
export function registerPitEngineer(bus: IEventBus): void {
  const engine = getScenarioEngine();

  for (const [name, clips] of Object.entries(POOLS)) {
    engine.definePool(name, [...clips]);
  }

  engine.defineVar("name", () => driverNameResolver());

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  engine.defineScenario(WELCOME);
  engine.defineScenario(PIT_APPROACH);
  engine.defineScenario(PIT_EXIT);
  engine.defineScenario(STALL_DEPARTURE);
  engine.defineScenario(SERVICE_REMINDER);
  engine.defineScenario(INCIDENT_ALERTS);
  engine.defineScenario(OVERTAKE);

  for (const flag of FLAG_ALERTS) engine.defineScenario(flag);

  for (const fuel of FUEL_WARNINGS) engine.defineScenario(fuel);

  for (const toggle of TOGGLE_CONFIRMATIONS) engine.defineScenario(toggle);

  for (const limiter of PIT_LIMITER_SCENARIOS) engine.defineScenario(limiter);

  engine.defineScenario(RACING_TIPS);

  // The spotter is a state-driven tick loop that the scenario DSL cannot
  // express (design doc §15). Registered here so plugin startup only has to
  // call `registerPitEngineer(bus)` once — the engine subscribes to
  // `spotter.changed` on the event bus and plays on AudioChannel.Spotter.
  registerSpotterEngine(bus);
}

/**
 * Inject a resolver for the `{{name}}` variable. The pit-engineer action
 * calls this with a closure over its current settings so scenarios pick
 * up driver-name changes without re-registration.
 *
 * Returns the full audio-assets path (e.g. `pit-engineer/names/IRD-name-niklas.mp3`)
 * or `null` when no driver is selected (drops the step).
 */
export function setDriverNameResolver(resolver: () => string | null): void {
  driverNameResolver = resolver;
}
