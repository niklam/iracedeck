/**
 * Pit-engineer scenario catalog registration.
 *
 * For the initial GA release of Pit Engineer, only the directional radar is
 * wired up (see issue #410). The voice-engineer scenarios (`WELCOME`,
 * `PIT_APPROACH`, flag/fuel/toggle/limiter/tip catalogs, etc.) stay on disk
 * and will be re-registered one at a time in follow-up PRs after per-feature
 * validation. Everything in this file is intentionally minimal — the engine
 * has no scenarios, no pools, and no variables to resolve until those
 * follow-ups land.
 *
 * `registerPitCrew(bus)` today only wires the radar engine. The `bus`
 * is the event bus instance returned by `initializeEventBus(...)` — passed
 * through to `registerRadarEngine` so the radar engine and scenario
 * engine share the exact same bus. Must be called once per plugin startup,
 * after `initializeAudioScenarios(bus, ...)`.
 */
import type { IEventBus } from "@iracedeck/event-bus";

import { registerRadarEngine } from "./radar-engine.js";

export {
  getRadarVisualState,
  playRadarTest,
  setRadarEnabled,
  type RadarVisualState,
  subscribeRadarVisualState,
} from "./radar-engine.js";

/**
 * Register the pit-crew scenario catalog with the scenario engine.
 *
 * The radar is a state-driven tick loop that the scenario DSL cannot
 * express (design doc §15). It's the only pit-crew feature registered
 * today — voice scenarios return in follow-up PRs (#410).
 */
export function registerPitCrew(bus: IEventBus): void {
  registerRadarEngine(bus);
}
