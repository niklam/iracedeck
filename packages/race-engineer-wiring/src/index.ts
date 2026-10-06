/**
 * @iracedeck/race-engineer-wiring
 *
 * The Race Engineer's wiring, shared by the three plugins (through
 * `@iracedeck/plugin-runtime`) and the scenario harness (#1349).
 */
export { type RaceEngineerCaches, type RaceFinishedPayload, subscribeRaceEngineerCaches } from "./caches.js";
export { buildPitCrewDeps } from "./pit-crew-deps.js";
export { createIracingSimRuntime, type SimRuntime } from "./sim-runtime.js";
export { type RaceEngineerVoiceState, type RaceEngineerWiringDeps, wireRaceEngineer } from "./wire-race-engineer.js";
