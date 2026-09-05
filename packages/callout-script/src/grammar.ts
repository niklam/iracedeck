/**
 * The callout-script grammar: the shapes a `callouts.json` can take, the
 * reserved words, and the two string-form parsers every consumer shares.
 *
 * This file is types and constants only — no zod. `schema.ts` turns it into a
 * validator; `references.ts` walks it. Keeping the vocabulary of the format in
 * one dependency-free module is what lets the engine, the scanner and the
 * generator agree on it without agreeing on anything else.
 */

/**
 * The one schema version this build reads. A `callouts.json` with any other
 * value is refused rather than guessed at — the number exists so the format
 * can evolve, and a higher one means a newer toolchain wrote the file.
 */
export const CALLOUT_SCRIPT_SCHEMA_VERSION = 1 as const;

/**
 * The reserved frame name. `frame: "none"` on an entry (or on a contract, in
 * the engine) plays the body unframed. It is never looked up, so a script may
 * not define a frame by that name, and `collectScriptReferences` never reports
 * it as a reference.
 */
export const NO_FRAME = "none";

/**
 * The message the schema reports when a script tries to define a frame named
 * `NO_FRAME`. Exported so the generator, which validates the authored config
 * with a stricter frame-name rule of its own, refuses the same mistake in the
 * same words.
 */
export const RESERVED_FRAME_NAME_MESSAGE = `"${NO_FRAME}" is reserved — it means unframed and can never be defined`;

/**
 * The branch key a `case` falls back to when the resolver returns a key the
 * `of` map does not carry (or nothing at all). It maps to no declared key, so
 * `collectScriptReferences` never reports it as one.
 */
export const CASE_DEFAULT_BRANCH = "default";

/**
 * The pool an unqualified `{ connector: true }` step draws from — a filler
 * word between two phrases. Like any other unqualified pool name, it must be
 * defined under the script's own `pools` — the engine's compiler checks a
 * slash-less name against the script's `pools` and then against the code
 * registry, and the catalog registers no code pool since #1065, so for a
 * pack the registry is empty. A script that uses the step therefore defines
 * a `connector` alias (`"connector": { "group": "<group>", "base": "<base>" }`)
 * or addresses the filler's group directly as `pool:<group>/<base>` instead
 * of using the step. The bundled script does neither: it has no connectors.
 */
export const CONNECTOR_POOL = "connector";

/**
 * How deeply a script may nest containers — arrays and objects, the document
 * root counted as the first — before the parser refuses it unread. The bundled
 * script sits near ten; the limit exists because the step schema is recursive
 * and a document nested a thousand levels deep exhausts the call stack inside
 * the validator, which is a throw the parser promises never to make. The
 * depth is measured with an explicit stack before any schema runs.
 */
export const CALLOUT_SCRIPT_MAX_DEPTH = 64;

/** The three things a frame may do to the pit-lane ambience bed. */
export const AMBIENT_ACTIONS = ["start", "stop", "seek"] as const;

export type AmbientAction = (typeof AMBIENT_ACTIONS)[number];

/**
 * The step-object keys, in the order the schema tries them when an object
 * carries more than one. The first key present decides the form; the strict
 * object for that form then names every other key as unrecognized.
 */
export const STEP_OBJECT_KEYS = [
  "clip",
  "var",
  "pool",
  "connector",
  "pause",
  "include",
  "optional",
  "ambient",
  "if",
  "case",
] as const;

export type StepObjectKey = (typeof STEP_OBJECT_KEYS)[number];

/**
 * One step of a sequence.
 *
 * The string forms are exactly the DSL's shorthand (`parseStepShorthand` in
 * `@iracedeck/audio-scenarios`): `"pool:<name>"`, `"pause:<ms>"`,
 * `"@<fragment-name>"`, `"{{<var>}}"`, and otherwise a clip path.
 *
 * The only operator anywhere in the grammar is the `!` that negates an `if`.
 * No `and`, no `or`, no comparisons, no field access — a script that needs a
 * compound condition gets a named one registered in code.
 */
export type ScriptStep =
  | string
  | { clip: string }
  | { var: string }
  | { pool: string; noRepeat?: boolean }
  | { connector: true }
  | { pause: number }
  | { include: string }
  | { optional: ScriptStep[] }
  | { ambient: AmbientAction }
  | { if: string; then: ScriptStep[]; else?: ScriptStep[] }
  | { case: string; of: Record<string, ScriptStep[]> };

/**
 * What a script says for one scenario id.
 *
 * `sequence` is required unless `skip` is `true`. A `skip: true` entry behaves
 * exactly like an absent one — the callout is silent for this voice — but it
 * says so in the file, and it satisfies the bundled pack's completeness check
 * as a deliberate declaration rather than an oversight.
 */
export type CalloutScriptEntry = {
  comment?: string;
  test?: string;
  skip?: boolean;
  /** Overrides the contract's default frame; `"none"` = unframed. */
  frame?: string;
  sequence?: ScriptStep[];
};

/** What a frame name means: the steps played around a callout's body. */
export type FrameDefinition = { comment?: string; open: ScriptStep[]; close: ScriptStep[] };

/** A named pool: an alias for a clip group + base name in the voice's manifest. */
export type PoolDefinition = { group: string; base: string; comment?: string };

/**
 * A sub-sequence the script defines once and includes from several entries
 * (issue #1065) — `"@<name>"` or `{ "include": "<name>" }` inside a sequence.
 * An include resolves ONLY within the same script, and the engine inlines it
 * at compile time: nothing is looked up at fire time, and a fragment that
 * includes itself (through any chain) is refused with the chain named. The
 * sequence may not be empty — a fragment nobody can hear is a mistake, not
 * a choice; deliberate silence is spelled on the entry with `skip`.
 */
export type FragmentDefinition = { comment?: string; sequence: ScriptStep[] };

/** The whole of a voice's `callouts.json`. `fragments` is optional: absent means the script defines none. */
export type CalloutScript = {
  schema: typeof CALLOUT_SCRIPT_SCHEMA_VERSION;
  scenarios: Record<string, CalloutScriptEntry>;
  frames: Record<string, FrameDefinition>;
  pools: Record<string, PoolDefinition>;
  fragments?: Record<string, FragmentDefinition>;
};

/**
 * Result of `parseCalloutScript`. Problems are human-readable and
 * path-prefixed (`scenarios.pit-crew.flag-green.sequence[1].pause: …`) — they
 * end up in a settings-window list a pack author reads.
 */
export type CalloutScriptParseResult = { ok: true; script: CalloutScript } | { ok: false; problems: readonly string[] };

/**
 * A pool name as a step may reference it: lowercase kebab-case, optionally with
 * ONE slash for direct `group/base` addressing of the voice's own clip groups.
 */
export const POOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;

/**
 * A pool name as a script may DEFINE it: the reference pattern without the
 * slash form. Registered names never carry one, which is what keeps the two
 * namespaces from colliding (a slashed reference always means `group/base`).
 */
export const POOL_DEFINITION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A scenario id: non-empty, no whitespace. (`pit-crew.flag-blue`.) */
export const SCENARIO_ID_PATTERN = /^\S+$/;

/** A vocabulary name (var, condition, case), a frame name or a fragment name: non-empty, no whitespace. */
export const NAME_PATTERN = /^\S+$/;

/**
 * A condition reference as written in `if`: an optional single `!`, then a
 * name. `!!x` is NOT double negation — the only operator is `!`, once — so the
 * pattern refuses a name that itself starts with a bang.
 */
export const COND_REFERENCE_PATTERN = /^!?[^\s!]\S*$/;

export const POOL_STEP_PREFIX = "pool:";
export const PAUSE_STEP_PREFIX = "pause:";
export const INCLUDE_STEP_PREFIX = "@";

const VAR_STEP_PATTERN = /^\{\{(.+)\}\}$/;

/** The classified form of a string step. */
export type StringStepForm =
  | { kind: "pool"; name: string }
  | { kind: "pause"; ms: number }
  | { kind: "include"; id: string }
  | { kind: "var"; name: string }
  | { kind: "clip"; path: string };

/**
 * Classify a string step by the same rules as the DSL's `parseStepShorthand`,
 * without throwing: a malformed prefixed form (`"pause:abc"`, `"@"`) comes back
 * as that form with an invalid payload (`NaN`, `""`), so the schema can report
 * it at the step's own path instead of misreading it as a clip.
 */
export function parseStringStep(step: string): StringStepForm {
  if (step.startsWith(POOL_STEP_PREFIX)) return { kind: "pool", name: step.slice(POOL_STEP_PREFIX.length) };

  if (step.startsWith(PAUSE_STEP_PREFIX)) {
    const raw = step.slice(PAUSE_STEP_PREFIX.length);

    // `Number("")` is 0, which would let a bare "pause:" through as a zero pause.
    return { kind: "pause", ms: raw === "" ? Number.NaN : Number(raw) };
  }

  if (step.startsWith(INCLUDE_STEP_PREFIX)) return { kind: "include", id: step.slice(INCLUDE_STEP_PREFIX.length) };

  const varMatch = VAR_STEP_PATTERN.exec(step);

  if (varMatch) return { kind: "var", name: varMatch[1] };

  // `"{{}}"` matches nothing above (the group needs one character) but is not a
  // clip either: report it as an empty var so the problem names the real mistake.
  if (step === "{{}}") return { kind: "var", name: "" };

  return { kind: "clip", path: step };
}

/**
 * Split an `if` reference into the condition name and whether it is negated.
 * Strips exactly one leading `!` — `!` is the only operator, and it is not
 * repeatable.
 */
export function parseCondReference(ref: string): { name: string; negated: boolean } {
  return ref.startsWith("!") ? { name: ref.slice(1), negated: true } : { name: ref, negated: false };
}
