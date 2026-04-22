/**
 * Pit-engineer scenario catalog registration.
 *
 * For the initial GA release of Pit Engineer, only the directional spotter is
 * wired up (see issue #410). The voice-engineer scenarios (`WELCOME`,
 * `PIT_APPROACH`, flag/fuel/toggle/limiter/tip catalogs, etc.) stay on disk
 * and will be re-registered one at a time in follow-up PRs after per-feature
 * validation. Everything in this file is intentionally minimal — the engine
 * has no scenarios, no pools, and no variables to resolve until those
 * follow-ups land.
 *
 * `registerPitEngineer(bus)` today only wires the spotter engine. The `bus`
 * is the event bus instance returned by `initializeEventBus(...)` — passed
 * through to `registerSpotterEngine` so the spotter engine and scenario
 * engine share the exact same bus. Must be called once per plugin startup,
 * after `initializeAudioScenarios(bus, ...)`.
 */
import type { IEventBus } from "@iracedeck/event-bus";

import { registerSpotterEngine } from "./spotter-engine.js";

export {
  getSpotterVisualState,
  playSpotterTest,
  setSpotterEnabled,
  type SpotterVisualState,
  subscribeSpotterVisualState,
} from "./spotter-engine.js";

/**
 * Register the pit-engineer scenario catalog with the scenario engine.
 *
 * The spotter is a state-driven tick loop that the scenario DSL cannot
 * express (design doc §15). It's the only pit-engineer feature registered
 * today — voice scenarios return in follow-up PRs (#410).
 */
export function registerPitEngineer(bus: IEventBus): void {
  registerSpotterEngine(bus);
}
