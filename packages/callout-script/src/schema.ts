import { z } from "zod";

import {
  AMBIENT_ACTIONS,
  CALLOUT_SCRIPT_SCHEMA_VERSION,
  type CalloutScript,
  type CalloutScriptEntry,
  type CalloutScriptParseResult,
  COND_REFERENCE_PATTERN,
  type FrameDefinition,
  INCLUDE_STEP_PREFIX,
  NAME_PATTERN,
  NO_FRAME,
  parseStringStep,
  POOL_DEFINITION_NAME_PATTERN,
  POOL_NAME_PATTERN,
  type PoolDefinition,
  RESERVED_FRAME_NAME_MESSAGE,
  SCENARIO_ID_PATTERN,
  type ScriptStep,
  STEP_OBJECT_KEYS,
  type StepObjectKey,
} from "./grammar.js";

// ---------------------------------------------------------------------------
// Leaf value schemas. Every message is written for the person who typed the
// value: the problems list is read by a pack author, not by us.
// ---------------------------------------------------------------------------

const POOL_NAME_MESSAGE =
  'must be a pool name: lowercase letters, digits and dashes, optionally "group/base" (e.g. "flag-blue" or "flags/blue")';

const poolName = z.string().regex(POOL_NAME_PATTERN, POOL_NAME_MESSAGE);

const poolDefinitionName = z
  .string()
  .regex(
    POOL_DEFINITION_NAME_PATTERN,
    "must be a pool name: lowercase letters, digits and dashes (a defined pool never carries a slash)",
  );

const scenarioId = z.string().regex(SCENARIO_ID_PATTERN, "must be a scenario id: non-empty, no whitespace");

const vocabularyName = (what: string) =>
  z.string().regex(NAME_PATTERN, `must be a ${what} name: non-empty, no whitespace`);

const frameName = z.string().regex(NAME_PATTERN, "must be a frame name: non-empty, no whitespace");

const frameDefinitionName = frameName.refine((name) => name !== NO_FRAME, RESERVED_FRAME_NAME_MESSAGE);

const clipPath = z.string().min(1, "must be a clip path");

/**
 * The one rule about `@`, stated once for both spellings: the string form
 * carries it, the object form does not, and the id itself never starts with
 * one — so `{ "include": "@x" }` and `"@@x"` are the same mistake.
 */
const INCLUDE_SPELLING_MESSAGE = `an include is spelled "${INCLUDE_STEP_PREFIX}<scenario-id>" (string form) or { "include": "<scenario-id>" } (object form) — the id itself never starts with "${INCLUDE_STEP_PREFIX}"`;

const includeId = z
  .string()
  .regex(SCENARIO_ID_PATTERN, "must be a scenario id: non-empty, no whitespace")
  .refine((id) => !id.startsWith(INCLUDE_STEP_PREFIX), INCLUDE_SPELLING_MESSAGE);

const condReference = z
  .string()
  .regex(COND_REFERENCE_PATTERN, 'must be a condition name, optionally negated with a single leading "!"');

const pauseMs = z
  .number({ error: "must be a finite number of milliseconds" })
  .min(0, "must be a non-negative number of milliseconds");

const ambientAction = z.enum(AMBIENT_ACTIONS, {
  error: `must be one of ${AMBIENT_ACTIONS.map((a) => `"${a}"`).join(", ")}`,
});

// ---------------------------------------------------------------------------
// Steps. A step is a string or one of ten strict object forms. The forms are
// told apart by which key is present, so instead of a `z.union` — whose one
// "Invalid input" issue would bury the real mistake under nine near-misses —
// the schema looks at the keys, picks the form, and validates against THAT
// strict object. A wrong value or an extra key is then reported at its own
// path with its own message, and an object that names no form at all gets a
// message listing the ten.
// ---------------------------------------------------------------------------

const steps: z.ZodType<ScriptStep[]> = z.lazy(() => z.array(ScriptStepSchema));

const caseBranches = z
  .record(z.string().min(1, "a branch key must not be empty"), steps)
  .refine((of) => Object.keys(of).length > 0, "a case needs at least one branch");

const STEP_FORMS: Readonly<Record<StepObjectKey, z.ZodType>> = {
  clip: z.strictObject({ clip: clipPath }),
  var: z.strictObject({ var: vocabularyName("var") }),
  pool: z.strictObject({ pool: poolName, noRepeat: z.boolean().optional() }),
  connector: z.strictObject({ connector: z.literal(true, { error: "must be true" }) }),
  pause: z.strictObject({ pause: pauseMs }),
  include: z.strictObject({ include: includeId }),
  optional: z.strictObject({ optional: steps }),
  ambient: z.strictObject({ ambient: ambientAction }),
  if: z.strictObject({ if: condReference, then: steps, else: steps.optional() }),
  case: z.strictObject({ case: vocabularyName("case"), of: caseBranches }),
};

const NO_FORM_MESSAGE =
  "not a step: expected a string or an object with one of the keys " + STEP_OBJECT_KEYS.map((k) => `"${k}"`).join(", ");

/** Validate a string step's shorthand payload; `null` means it is fine. */
function stringStepProblem(step: string): string | null {
  if (step === "") return "a step must not be an empty string";

  const form = parseStringStep(step);

  switch (form.kind) {
    case "pool":
      return POOL_NAME_PATTERN.test(form.name) ? null : `"pool:" ${POOL_NAME_MESSAGE}`;
    case "pause":
      return Number.isFinite(form.ms) && form.ms >= 0
        ? null
        : '"pause:" must be followed by a non-negative number of milliseconds';
    case "include":
      if (!SCENARIO_ID_PATTERN.test(form.id)) return '"@" must be followed by a scenario id: non-empty, no whitespace';

      return form.id.startsWith(INCLUDE_STEP_PREFIX) ? INCLUDE_SPELLING_MESSAGE : null;
    case "var":
      return NAME_PATTERN.test(form.name) ? null : "{{…}} must wrap a var name: non-empty, no whitespace";
    case "clip":
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stepFormOf(value: object): StepObjectKey | undefined {
  return STEP_OBJECT_KEYS.find((key) => key in value);
}

export const ScriptStepSchema: z.ZodType<ScriptStep> = z.lazy(() =>
  z.unknown().transform((value, ctx): ScriptStep => {
    if (typeof value === "string") {
      const problem = stringStepProblem(value);

      if (problem === null) return value;

      ctx.addIssue({ code: "custom", message: problem });

      return z.NEVER;
    }

    const form = isPlainObject(value) ? stepFormOf(value) : undefined;

    if (form === undefined) {
      ctx.addIssue({ code: "custom", message: NO_FORM_MESSAGE });

      return z.NEVER;
    }

    const result = STEP_FORMS[form].safeParse(value);

    if (!result.success) {
      // Forwarded as-is: each issue's path is relative to this step, and the
      // enclosing array/object prefixes it on the way up. (Spread because the
      // finalized issue interface lacks the index signature a raw issue wants.)
      for (const issue of result.error.issues) ctx.addIssue({ ...issue });

      return z.NEVER;
    }

    return result.data as ScriptStep;
  }),
);

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

export const CalloutScriptEntrySchema: z.ZodType<CalloutScriptEntry> = z
  .strictObject({
    comment: z.string().optional(),
    test: z.string().optional(),
    skip: z.boolean().optional(),
    frame: frameName.optional(),
    sequence: steps.optional(),
  })
  .refine((entry) => entry.skip === true || entry.sequence !== undefined, {
    error: 'required unless "skip" is true',
    path: ["sequence"],
    // Run even when the entry already has a problem, so a typo'd `sequnce` is
    // reported beside the `sequence` it was meant to be — but only on an
    // object, since the refinement reads keys off the value and a non-object
    // entry already has its own, sufficient problem.
    when: ({ value }) => isPlainObject(value),
  });

export const FrameDefinitionSchema: z.ZodType<FrameDefinition> = z.strictObject({
  comment: z.string().optional(),
  open: steps,
  close: steps,
});

export const PoolDefinitionSchema: z.ZodType<PoolDefinition> = z.strictObject({
  group: z.string().min(1, "must be a clip group name"),
  base: z.string().min(1, "must be a clip base name"),
  comment: z.string().optional(),
});

export const CalloutScriptSchema: z.ZodType<CalloutScript> = z.strictObject({
  schema: z.literal(CALLOUT_SCRIPT_SCHEMA_VERSION, { error: `must be ${CALLOUT_SCRIPT_SCHEMA_VERSION}` }),
  scenarios: z.record(scenarioId, CalloutScriptEntrySchema),
  frames: z.record(frameDefinitionName, FrameDefinitionSchema),
  pools: z.record(poolDefinitionName, PoolDefinitionSchema),
});

// ---------------------------------------------------------------------------
// Problems. `<path>: <message>`, one per thing to fix, never an empty prefix.
// ---------------------------------------------------------------------------

/** `["scenarios", "pit-crew.flag-green", "sequence", 1, "pause"]` → `scenarios.pit-crew.flag-green.sequence[1].pause`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      // An empty key is a real mistake an author can make (`"": {…}`); quote it
      // so the problem does not end in a bare dot.
      const key = segment === "" ? '""' : String(segment);
      out += out === "" ? key : `.${key}`;
    }
  }

  return out;
}

/** The value the issue is about, read off the original document by path. */
function valueAt(json: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = json;

  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;

    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";

  if (value === undefined) return "undefined";

  if (Array.isArray(value)) return "an array";

  return withArticle(typeof value);
}

function withArticle(noun: string): string {
  // zod says "record" for a keyed object; an author sees an object.
  const word = noun === "record" ? "object" : noun;

  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** How every default zod type message begins; a message without it is one of ours and is kept verbatim. */
const ZOD_DEFAULT_TYPE_MESSAGE = "Invalid input: ";

/**
 * The prefix for an issue at the document root, where there is no path to
 * name. Deliberately not a real key: `schema:` would point an author at a key
 * that may be perfectly fine.
 */
const ROOT_PREFIX = "(document)";

function problemsFor(json: unknown, issues: readonly z.core.$ZodIssue[]): string[] {
  const problems: string[] = [];

  for (const issue of issues) {
    const path = formatPath(issue.path);

    if (issue.code === "unrecognized_keys") {
      // One problem per key, at the key's own path — so a top-level stray key
      // is prefixed by its name rather than by nothing.
      for (const key of issue.keys) problems.push(`${formatPath([...issue.path, key])}: unrecognized key`);
    } else if (issue.code === "invalid_key") {
      // A record key that failed its pattern: surface the pattern's own message
      // rather than zod's generic "Invalid key in record".
      const detail = issue.issues.map((nested) => nested.message).join("; ");
      problems.push(`${path}: ${detail}`);
    } else if (issue.path.length === 0) {
      problems.push(`${ROOT_PREFIX}: the script must be a JSON object, not ${describeValue(json)}`);
    } else if (issue.path.length === 1 && issue.path[0] === "schema" && isNewerSchema(json)) {
      // The version literal earns its keep here: a higher number means a newer
      // toolchain wrote the file, and "must be 1" tells that author nothing.
      problems.push(`${path}: written for a newer version of iRaceDeck — update the plugin to use this voice`);
    } else if (issue.code === "invalid_type" && issue.message.startsWith(ZOD_DEFAULT_TYPE_MESSAGE)) {
      // zod's "expected array, received undefined" is a missing key to an
      // author; say so. Reading the value off the document rather than off the
      // issue keeps this right for issues forwarded out of a step form, whose
      // `input` is the whole step.
      const value = valueAt(json, issue.path);
      problems.push(
        value === undefined
          ? `${path}: required — expected ${withArticle(issue.expected)}`
          : `${path}: expected ${withArticle(issue.expected)}, received ${describeValue(value)}`,
      );
    } else {
      problems.push(`${path}: ${issue.message}`);
    }
  }

  return problems;
}

function isNewerSchema(json: unknown): boolean {
  if (json === null || typeof json !== "object") return false;

  const schema = (json as { schema?: unknown }).schema;

  return typeof schema === "number" && schema > CALLOUT_SCRIPT_SCHEMA_VERSION;
}

/**
 * Validate an already-parsed `callouts.json`.
 *
 * Never throws. The pack folder is user-writable by design, so a malformed
 * script is a reportable problem with that one voice — the scanner drops the
 * voice and lists the problems — never a plugin-startup failure. The caller
 * owns turning text into JSON (and stripping a BOM first, as the voice-pack
 * manifest reader does); this function owns everything after that.
 */
export function parseCalloutScript(json: unknown): CalloutScriptParseResult {
  const parsed = CalloutScriptSchema.safeParse(json);

  if (parsed.success) return { ok: true, script: parsed.data };

  return { ok: false, problems: problemsFor(json, parsed.error.issues) };
}
