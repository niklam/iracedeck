/**
 * The shape of `src/data/pack-reference.json` — the pack-author reference
 * (issue #1066) the root generator (`pnpm generate:pack-reference`) writes
 * from the engine's contracts and vocabulary plus the bundled voice's script
 * and clips, and the three reference pages under `docs/voice-packs/reference/`
 * render.
 *
 * Re-declared here by hand, on purpose: the builder's types live in
 * `@iracedeck/audio-scenarios` (`src/reference/pack-reference.ts`), and the
 * website must not depend on the Race Engineer to render a page about it.
 * Keep the two in step; `pack-reference-types.test.ts` parses the committed
 * JSON through {@link parsePackReference}, so a drift in the artifact fails
 * the suite here, and every component parses the slice it renders, so the
 * same drift fails the site build with the offending path named.
 */

// ─── The artifact ────────────────────────────────────────────────────────────

/** What one callout's bundled entry references by name, its included fragments walked. */
export type CalloutReferences = {
  /** Every pool the entry draws from, in `group/base` form — an alias resolved to its source. */
  pools: readonly string[];
  vars: readonly string[];
  /** Condition names without their `!`. */
  conds: readonly string[];
  /** Each case with the branch keys the entry maps, `"default"` excluded. */
  cases: readonly { name: string; keys: readonly string[] }[];
  /** Every fragment the entry includes, directly or through another fragment. */
  includes: readonly string[];
  /** The entry's `frame` override when it names one; `"none"` is not a reference. */
  frames: readonly string[];
};

/** One callout: the contract, the bundled entry's prose, and what the entry references. */
export type Callout = {
  id: string;
  family: string | null;
  /** The bus event that triggers it; `null` for a contract only `fire()` triggers. */
  event: string | null;
  /** The contract's one sentence on WHEN it fires. */
  description: string;
  /** The contract's default frame — an entry's override is under `references.frames`. */
  frame: string;
  weight: number;
  /** The engine's `WEIGHT` band the weight is exactly (`"SAFETY"` for 70); `null` for a weight on no band. */
  weightBand: string | null;
  queueable: boolean;
  interrupt: boolean;
  /** The contract's `base` — what a bare literal clip path in the entry resolves against; `null` for the audio root. */
  base: string | null;
  /** The bundled entry's `comment` (what is said); `null` when the entry carries none. */
  comment: string | null;
  /** The bundled entry's `test` (how to hear it); `null` when the entry carries none. */
  test: string | null;
  /** `true` for a `skip: true` entry — deliberately silent in the bundled voice. */
  skip: boolean;
  references: CalloutReferences;
};

/** A var or condition with the callouts whose entries (or included fragments) name it. */
export type VocabularyItem = { name: string; description: string; usedBy: readonly string[] };

/** A case with its declared keys — key → what it means — and the callouts that use it. */
export type VocabularyCase = VocabularyItem & { keys: Readonly<Record<string, string>> };

export type PackReferenceVocabulary = {
  vars: readonly VocabularyItem[];
  conds: readonly VocabularyItem[];
  cases: readonly VocabularyCase[];
};

/** One line a full pack records: a base with all its takes. */
export type RecordingLine = {
  base: string;
  /** The bundled config's text of EVERY take, in take order; `[]` when the config has none. May carry SSML verbatim. */
  texts: readonly string[];
  /** How many takes the bundled voice ships — every `<base>-NN.mp3`, or the bare `<base>.mp3`. */
  takes: number;
  /** Callout ids whose entries (or included fragments) address the base directly. */
  usedBy: readonly string[];
  /** Var names whose description names the line's group — their callouts draw from it through the var. */
  viaVar: readonly string[];
  /** What plugin code plays the line for, outside any script, in the generator's words; `null` for every line only a script reaches. */
  playedBy: string | null;
};

export type RecordingGroup = { group: string; lines: readonly RecordingLine[] };

/** Provenance, the shape the repo's other generated artifacts carry: the repo-relative sources the generator read. No version, by design. */
export type PackReferenceMeta = {
  generatedFrom: readonly string[];
};

export type PackReference = {
  _meta: PackReferenceMeta;
  callouts: readonly Callout[];
  vocabulary: PackReferenceVocabulary;
  recordingScript: readonly RecordingGroup[];
};

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Thrown by the parsers below. The message names the path that failed
 * (`callouts[3].references.pools[0]: expected a string`), the way the
 * script grammar's own problems do, so a shape drift is fixed at the place
 * it happened rather than found by reading a stack trace.
 */
export class PackReferenceShapeError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "PackReferenceShapeError";
  }
}

function fail(path: string, detail: string): never {
  throw new PackReferenceShapeError(path, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(path, "expected an object");
}

/** Refuse a key the type does not declare: the artifact is generated, so a stray key is a shape change. */
function onlyKeys(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "unrecognized key");
  }
}

function string(value: unknown, path: string): string {
  return typeof value === "string" ? value : fail(path, "expected a string");
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : fail(path, "expected a boolean");
}

function integer(value: unknown, path: string): number {
  return Number.isInteger(value) ? (value as number) : fail(path, "expected an integer");
}

function array<T>(value: unknown, path: string, item: (element: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, "expected an array");

  return value.map((element, index) => item(element, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path, string);
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const source = record(value, path);
  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(source)) out[key] = string(entry, `${path}.${key}`);

  return out;
}

const REFERENCE_KEYS = ["pools", "vars", "conds", "cases", "includes", "frames"] as const;

function parseReferences(value: unknown, path: string): CalloutReferences {
  const source = record(value, path);
  onlyKeys(source, path, REFERENCE_KEYS);

  return {
    pools: stringArray(source.pools, `${path}.pools`),
    vars: stringArray(source.vars, `${path}.vars`),
    conds: stringArray(source.conds, `${path}.conds`),
    cases: array(source.cases, `${path}.cases`, (element, casePath) => {
      const entry = record(element, casePath);
      onlyKeys(entry, casePath, ["name", "keys"]);

      return { name: string(entry.name, `${casePath}.name`), keys: stringArray(entry.keys, `${casePath}.keys`) };
    }),
    includes: stringArray(source.includes, `${path}.includes`),
    frames: stringArray(source.frames, `${path}.frames`),
  };
}

const CALLOUT_KEYS = [
  "id",
  "family",
  "event",
  "description",
  "frame",
  "weight",
  "weightBand",
  "queueable",
  "interrupt",
  "base",
  "comment",
  "test",
  "skip",
  "references",
] as const;

export function parseCallout(value: unknown, path = "callout"): Callout {
  const source = record(value, path);
  onlyKeys(source, path, CALLOUT_KEYS);

  return {
    id: string(source.id, `${path}.id`),
    family: nullableString(source.family, `${path}.family`),
    event: nullableString(source.event, `${path}.event`),
    description: string(source.description, `${path}.description`),
    frame: string(source.frame, `${path}.frame`),
    weight: integer(source.weight, `${path}.weight`),
    weightBand: nullableString(source.weightBand, `${path}.weightBand`),
    queueable: boolean(source.queueable, `${path}.queueable`),
    interrupt: boolean(source.interrupt, `${path}.interrupt`),
    base: nullableString(source.base, `${path}.base`),
    comment: nullableString(source.comment, `${path}.comment`),
    test: nullableString(source.test, `${path}.test`),
    skip: boolean(source.skip, `${path}.skip`),
    references: parseReferences(source.references, `${path}.references`),
  };
}

/** The `callouts` slice — what the callouts page renders. */
export function parseCallouts(value: unknown, path = "callouts"): Callout[] {
  return array(value, path, parseCallout);
}

function parseVocabularyItem(value: unknown, path: string): VocabularyItem {
  const source = record(value, path);
  onlyKeys(source, path, ["name", "description", "usedBy"]);

  return {
    name: string(source.name, `${path}.name`),
    description: string(source.description, `${path}.description`),
    usedBy: stringArray(source.usedBy, `${path}.usedBy`),
  };
}

function parseVocabularyCase(value: unknown, path: string): VocabularyCase {
  const source = record(value, path);
  onlyKeys(source, path, ["name", "description", "keys", "usedBy"]);

  return {
    name: string(source.name, `${path}.name`),
    description: string(source.description, `${path}.description`),
    keys: stringRecord(source.keys, `${path}.keys`),
    usedBy: stringArray(source.usedBy, `${path}.usedBy`),
  };
}

/** The `vocabulary` slice — what the vocabulary page renders. */
export function parseVocabulary(value: unknown, path = "vocabulary"): PackReferenceVocabulary {
  const source = record(value, path);
  onlyKeys(source, path, ["vars", "conds", "cases"]);

  return {
    vars: array(source.vars, `${path}.vars`, parseVocabularyItem),
    conds: array(source.conds, `${path}.conds`, parseVocabularyItem),
    cases: array(source.cases, `${path}.cases`, parseVocabularyCase),
  };
}

function parseRecordingLine(value: unknown, path: string): RecordingLine {
  const source = record(value, path);
  onlyKeys(source, path, ["base", "texts", "takes", "usedBy", "viaVar", "playedBy"]);

  return {
    base: string(source.base, `${path}.base`),
    texts: stringArray(source.texts, `${path}.texts`),
    takes: integer(source.takes, `${path}.takes`),
    usedBy: stringArray(source.usedBy, `${path}.usedBy`),
    viaVar: stringArray(source.viaVar, `${path}.viaVar`),
    playedBy: nullableString(source.playedBy, `${path}.playedBy`),
  };
}

/** The `recordingScript` slice — what the recording-script page renders. */
export function parseRecordingScript(value: unknown, path = "recordingScript"): RecordingGroup[] {
  return array(value, path, (element, groupPath) => {
    const source = record(element, groupPath);
    onlyKeys(source, groupPath, ["group", "lines"]);

    return {
      group: string(source.group, `${groupPath}.group`),
      lines: array(source.lines, `${groupPath}.lines`, parseRecordingLine),
    };
  });
}

/**
 * Validate the whole artifact. Throws {@link PackReferenceShapeError} naming
 * the first path that does not match the type; returns the value typed.
 */
export function parsePackReference(value: unknown): PackReference {
  const source = record(value, "(document)");
  onlyKeys(source, "(document)", ["_meta", "callouts", "vocabulary", "recordingScript"]);

  const meta = record(source._meta, "_meta");
  onlyKeys(meta, "_meta", ["generatedFrom"]);

  return {
    _meta: { generatedFrom: stringArray(meta.generatedFrom, "_meta.generatedFrom") },
    callouts: parseCallouts(source.callouts),
    vocabulary: parseVocabulary(source.vocabulary),
    recordingScript: parseRecordingScript(source.recordingScript),
  };
}
