/**
 * @iracedeck/audio-scenarios
 *
 * Data-driven audio scenario DSL + interpreter. Subscribes to
 * `@iracedeck/event-bus` and drives `@iracedeck/audio-service`. Scenarios
 * are sim-agnostic: any translator that publishes the canonical event names
 * (see `@iracedeck/event-bus/event-catalog`) can drive the same catalog.
 */
// The script grammar, re-exported so a consumer that only depends on this
// package (a plugin feeding `setScripts`) needs no second import (#1064).
export type { CalloutScript } from "@iracedeck/callout-script";

export type { ResolvedStep, Scenario, ScenarioContext, ScenarioContract, Step } from "./dsl.js";
export { applyBase, DEFAULT_FRAME, DEFAULT_WEIGHT, NO_FRAME, parseStepShorthand, resolveStep, WEIGHT } from "./dsl.js";
export type {
  AudioAssetsManifest,
  ContractReport,
  FrameOptions,
  IScenarioEngine,
  VocabularyReport,
} from "./interpreter.js";
export {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  isAudioScenariosInitialized,
} from "./interpreter.js";
export { manifestVoices, mergeManifests, scanDriverNames, scanRaceEngineerVoices } from "./manifest.js";
// The pack-author reference (#1066): the pure builder the root generator
// `scripts/generate-pack-reference.mjs` calls off this package's dist.
export type {
  Callout,
  CalloutReferences,
  PackReference,
  PackReferenceInput,
  PackReferenceVocabulary,
  PluginPlayedClip,
  RecordingGroup,
  RecordingLine,
  VocabularyCase,
  VocabularyItem,
  VoiceConfigLine,
} from "./reference/pack-reference.js";
export {
  buildPackReference,
  descriptionNamesGroup,
  PLUGIN_PLAYED_ANY_BASE,
  pluginPlayedEntry,
  serializePackReference,
} from "./reference/pack-reference.js";
// `lint:pack` (#1066): the pure linter the root script `scripts/lint-pack.mjs`
// runs off this package's dist, over an injected filesystem.
export type {
  LintFileRead,
  LintPackFileSystem,
  LintPackInput,
  LintProblem,
  LintProblemKind,
  LintReport,
  VoiceLintSummary,
} from "./reference/lint-pack.js";
export { formatLintReport, lintPack } from "./reference/lint-pack.js";
export type { CompileDeps, CompiledVoiceScript } from "./script-compiler.js";
export { compileVoiceScript } from "./script-compiler.js";
export { validateScenario } from "./validation.js";
