/**
 * @iracedeck/callout-script
 *
 * The shared contract of a Race Engineer voice pack. The JSON grammar for its
 * callout scripts (`voice/<voice-id>/callouts.json`, issue #1064): the types,
 * the Zod schema, a never-throwing parser whose problems a pack author can
 * read, and a reference collector for consumers that check a script against
 * what they hold. And, since #1134, the pack FORMAT's own rules
 * (`voice-pack.ts`): the `voice-pack.json` schema and reader, which clip paths
 * the engine can reach, the script size cap, the id-vs-folder rule and the
 * voice de-duplication. A leaf package — `zod` is its only dependency — so the
 * engine, the pack scanner, the pack linter and the asset packer can all
 * validate the same contract without depending on each other.
 */
export {
  AMBIENT_ACTIONS,
  type AmbientAction,
  CALLOUT_SCRIPT_MAX_DEPTH,
  CALLOUT_SCRIPT_SCHEMA_VERSION,
  type CalloutScript,
  type CalloutScriptEntry,
  type CalloutScriptParseResult,
  CASE_DEFAULT_BRANCH,
  COND_REFERENCE_PATTERN,
  CONNECTOR_POOL,
  type FragmentDefinition,
  type FrameDefinition,
  INCLUDE_STEP_PREFIX,
  NAME_PATTERN,
  NO_FRAME,
  parseCondReference,
  parseStringStep,
  PAUSE_STEP_PREFIX,
  POOL_DEFINITION_NAME_PATTERN,
  POOL_NAME_PATTERN,
  POOL_STEP_PREFIX,
  type PoolDefinition,
  RESERVED_FRAME_NAME_MESSAGE,
  SCENARIO_ID_PATTERN,
  type ScriptStep,
  STEP_OBJECT_KEYS,
  type StepObjectKey,
  type StringStepForm,
} from "./grammar.js";
export {
  checkCoverage,
  type Coverage,
  type CoverageInput,
  coverageOf,
  type CoverageReport,
  danglingBasesOf,
  danglingOf,
  orphansOf,
  stripTakeSuffix,
  TAKE_SUFFIX,
  type VarDrivenGroup,
  VOICE_CLIP_PATH,
} from "./coverage.js";
export { CALLOUT_SCRIPT_FILE, calloutScriptPath } from "./paths.js";
export {
  collectLiteralClips,
  collectScriptReferences,
  collectStepReferences,
  type ScriptReferences,
  type StepReferences,
} from "./references.js";
export {
  CalloutScriptEntrySchema,
  CalloutScriptSchema,
  FragmentDefinitionSchema,
  FrameDefinitionSchema,
  parseCalloutScript,
  parseCalloutScriptText,
  PoolDefinitionSchema,
  ScriptStepSchema,
} from "./schema.js";
export {
  qualifiedVoiceId,
  qualifyClipPath,
  qualifyVoiceId,
  splitVoiceId,
  VOICE_ID_SEPARATOR,
  VOICE_ID_SEPARATOR_REASON,
} from "./voice-id.js";
export {
  dedupeDeclaredVoices,
  displayLabel,
  isSemverVersion,
  packId,
  packIdMatchesFolder,
  type ParseVoicePackManifestResult,
  parseVoicePackManifest,
  USABLE_VOICE_CLIP,
  validateVoicePackManifest,
  VOICE_PACK_MANIFEST_FILE,
  VOICE_PACK_NEWER_SCHEMA_REASON,
  VOICE_SCRIPT_MAX_BYTES,
  voiceEntry,
  type VoicePackManifest,
  VoicePackManifestSchema,
  type VoicePackManifestValidation,
} from "./voice-pack.js";
