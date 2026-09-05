/**
 * @iracedeck/callout-script
 *
 * The JSON grammar for Race Engineer voice-pack callout scripts
 * (`voice/<voice-id>/callouts.json`, issue #1064): the types, the Zod schema,
 * a never-throwing parser whose problems a pack author can read, and a
 * reference collector for consumers that check a script against what they
 * hold. A leaf package — `zod` is its only dependency — so the engine, the
 * pack scanner and the asset generator can all validate the same contract
 * without depending on each other.
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
export { CALLOUT_SCRIPT_FILE, calloutScriptPath } from "./paths.js";
export { collectScriptReferences, type ScriptReferences } from "./references.js";
export {
  CalloutScriptEntrySchema,
  CalloutScriptSchema,
  FrameDefinitionSchema,
  parseCalloutScript,
  parseCalloutScriptText,
  PoolDefinitionSchema,
  ScriptStepSchema,
} from "./schema.js";
