/**
 * @iracedeck/audio-scenarios
 *
 * Data-driven audio scenario DSL + interpreter. Subscribes to
 * `@iracedeck/event-bus` and drives `@iracedeck/audio-service`. Scenarios
 * are sim-agnostic: any translator that publishes the canonical event names
 * (see `@iracedeck/event-bus/event-catalog`) can drive the same catalog.
 */
export type { ResolvedStep, Scenario, ScenarioContext, Step } from "./dsl.js";
export { applyBase, DEFAULT_WEIGHT, parseStepShorthand, resolveStep, WEIGHT } from "./dsl.js";
export type { AudioAssetsManifest, IScenarioEngine } from "./interpreter.js";
export {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  isAudioScenariosInitialized,
} from "./interpreter.js";
export { manifestVoices, mergeManifests, scanDriverNames, scanRaceEngineerVoices } from "./manifest.js";
export { validateScenario } from "./validation.js";
