/**
 * The pack-author reference (issue #1066): one artifact, built from the
 * code-owned contracts and vocabulary the engine enumerates plus the bundled
 * voice's script and clips, that the website renders as the three reference
 * pages — the callouts, the vocabulary, and the recording script.
 *
 * Pure: `buildPackReference` takes what its caller read (the reports off a
 * registered engine, the parsed `callouts.json`, the voice config's `groups`,
 * the manifest's clip list) and returns the shape; `serializePackReference`
 * is the one serialisation the committed file and its freshness test share.
 * The root generator (`scripts/generate-pack-reference.mjs`) owns the I/O.
 *
 * Every list is sorted in code-point order and every object is built with
 * its keys in declared order, so the same catalog serialises to the same
 * bytes on any machine — the freshness test compares text.
 *
 * Two attribution rules worth knowing, both stated on their helpers:
 *
 * - A callout's `references` include what its INCLUDED fragments reference,
 *   transitively (`walkEntry`): a pool used only inside the readback body is
 *   still a pool the readback callout draws from, and the vocabulary's
 *   `usedBy` and the recording lines' `usedBy` are that attribution inverted.
 * - A var draws from a clip group the reference can only know by reading the
 *   var's DESCRIPTION (`descriptionNamesGroup`) — a heuristic by design, since
 *   a resolver is a closure. It is what fills a recording line's `viaVar` and
 *   extends its `usedBy` to the callouts that name the var.
 *
 * The builder refuses a contract the script has no entry for. Since #1065 the
 * catalog is contracts-only and the bundled script covers all of it, so an
 * id with no entry is either a legacy `Scenario` speaking from code — which
 * `contracts()` lists beside the contracts precisely so this can notice — or
 * a contract the bundled script forgot; the reference publishes neither.
 */
import {
  type CalloutScript,
  type CalloutScriptEntry,
  collectLiteralClips,
  collectStepReferences,
  NO_FRAME,
  type ScriptStep,
} from "@iracedeck/callout-script";

import type { ContractReport, VocabularyReport } from "../interpreter.js";

// ─── The artifact ────────────────────────────────────────────────────────────

/** What one callout's bundled entry references by name, its included fragments walked. */
export type CalloutReferences = {
  /**
   * Every pool the entry draws from, in `group/base` form: a `pools` alias
   * is resolved to its source, a slashed name is kept as written. An alias
   * the script does not define cannot be resolved and is kept as written too.
   */
  pools: readonly string[];
  vars: readonly string[];
  /** Condition names without their `!`. */
  conds: readonly string[];
  /** Each case with the branch keys the entry maps, `"default"` excluded. */
  cases: readonly { name: string; keys: readonly string[] }[];
  /** Every fragment the entry includes, directly or through another fragment. */
  includes: readonly string[];
  /** The entry's `frame` override when it names one; `"none"` is the reserved word for unframed, not a reference. */
  frames: readonly string[];
};

/** One callout as the reference publishes it: the contract, the bundled entry's prose, and what the entry references. */
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
  queueable: boolean;
  interrupt: boolean;
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
  /** The bundled config's text of the first take (`<base>-01`, else the bare `<base>`); `null` when the config has none. */
  text: string | null;
  /** How many takes the bundled voice ships — every `<base>-NN.mp3`, or the bare `<base>.mp3`. */
  takes: number;
  /** Callout ids whose entries draw from the line directly, or through a var that draws from its group. */
  usedBy: readonly string[];
  /** Var names whose description names the line's group — see {@link descriptionNamesGroup}. */
  viaVar: readonly string[];
};

export type RecordingGroup = { group: string; lines: readonly RecordingLine[] };

export type PackReference = {
  generatedFrom: {
    /** The root `package.json` version the reference was built from. */
    catalogVersion: string;
  };
  callouts: readonly Callout[];
  vocabulary: PackReferenceVocabulary;
  recordingScript: readonly RecordingGroup[];
};

// ─── The input ───────────────────────────────────────────────────────────────

/** One authored line of the voice config's `groups`: the take's name and the text it speaks. */
export type VoiceConfigLine = { name: string; text: string };

export type PackReferenceInput = {
  /** The root `package.json` version. */
  catalogVersion: string;
  /** `engine.contracts()` after the catalog registered. */
  contracts: readonly ContractReport[];
  /** `engine.vocabulary()` after the catalog registered. */
  vocabulary: VocabularyReport;
  /** The bundled voice's parsed `callouts.json`. */
  script: CalloutScript;
  /** The bundled voice config's `groups`, keyed by clip group. */
  groups: Readonly<Record<string, readonly VoiceConfigLine[]>>;
  /** The runtime manifest's `clips` — every voice's, plus the shared sfx; the builder keeps the voice's. */
  manifestClips: readonly string[];
  /** Which voice's clips make the recording script. Defaults to the bundled voice, `default`. */
  voice?: string;
};

/** The bundled voice, whose clips the recording script is built from unless told otherwise. */
const DEFAULT_VOICE = "default";

// ─── Building ────────────────────────────────────────────────────────────────

export function buildPackReference(input: PackReferenceInput): PackReference {
  const { script } = input;
  const voice = input.voice ?? DEFAULT_VOICE;

  const unscripted = input.contracts
    .map((c) => c.id)
    .filter((id) => !Object.hasOwn(script.scenarios, id))
    .sort();

  if (unscripted.length > 0) {
    throw new Error(
      `The bundled script has no entry for ${unscripted.map((id) => `"${id}"`).join(", ")} — ` +
        "a legacy scenario speaking from code, or a contract the script does not cover. " +
        "The reference is built over a contracts-only, fully scripted catalog (#1065); " +
        "register it as a contract and give it an entry (skip: true counts).",
    );
  }

  const walks = new Map<string, EntryWalk>();
  const callouts = [...input.contracts]
    .sort((a, b) => compare(a.id, b.id))
    .map((contract): Callout => {
      const entry = script.scenarios[contract.id];
      const walk = walkEntry(script, entry);
      walks.set(contract.id, walk);

      return {
        id: contract.id,
        family: contract.family,
        event: contract.event,
        description: contract.description,
        frame: contract.frame,
        weight: contract.weight,
        queueable: contract.queueable,
        interrupt: contract.interrupt,
        comment: entry.comment ?? null,
        test: entry.test ?? null,
        skip: entry.skip === true,
        references: walk.references,
      };
    });

  const vocabulary = buildVocabulary(input.vocabulary, walks);
  const recordingScript = buildRecordingScript(input.groups, input.manifestClips, voice, walks, vocabulary.vars);

  return { generatedFrom: { catalogVersion: input.catalogVersion }, callouts, vocabulary, recordingScript };
}

/** Serialise the artifact exactly as it is committed — 2-space JSON, trailing newline — so the freshness test can compare text. */
export function serializePackReference(reference: PackReference): string {
  return `${JSON.stringify(reference, null, 2)}\n`;
}

/**
 * Whether a var's description names a clip group — the ONLY link the
 * reference has between a var and the clips its resolver draws, since a
 * resolver is a closure the builder cannot read. A heuristic by design,
 * shared with `lint:pack` so the two never disagree about which lines a var
 * accounts for.
 *
 * The group counts as named when it appears as a whole kebab-case token —
 * not inside a longer name such as `lap-time` in `lap-time-decimal` — and is
 * either followed by `/` (a `group/base` example: `incidents/points-2`) or is
 * the head of "<group> group" / "<group> clip group" ("from the session-start
 * clip group"). A plain word is deliberately NOT enough: "the live gap" does
 * not draw from the `gap` group, and the catalog's descriptions were written
 * to the two forms above.
 */
export function descriptionNamesGroup(description: string, group: string): boolean {
  const token = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`(?<![a-z0-9-])${token}(?:/|\\s+(?:clip\\s+)?group\\b)`).test(description);
}

// ─── Walking an entry ────────────────────────────────────────────────────────

/** What one entry references, its included fragments walked, plus the voice clips it plays by literal path. */
type EntryWalk = {
  references: CalloutReferences;
  /** `group/base` of every literal `voice/<voice>/<group>/<name>.mp3` step, the take suffix stripped. */
  clipBases: ReadonlySet<string>;
};

const NO_REFERENCES: CalloutReferences = { pools: [], vars: [], conds: [], cases: [], includes: [], frames: [] };

/** A literal step addressing one of the voice's own clips, in either spelling (`{voice}` or a voice id), with or without the leading-slash escape. */
const VOICE_CLIP_PATH = /^\/?voice\/[^/]+\/([^/]+)\/([^/]+)\.mp3$/;

/**
 * Walk an entry's sequence and, transitively, every fragment it includes.
 * A `skip: true` entry references nothing — the compiler never reads past
 * the skip, the same rule `collectScriptReferences` applies. A fragment is
 * walked once however many paths reach it; an include of a name the script
 * does not define is still listed (it is what the entry names) and followed
 * nowhere.
 */
function walkEntry(script: CalloutScript, entry: CalloutScriptEntry): EntryWalk {
  if (entry.skip === true) return { references: NO_REFERENCES, clipBases: new Set() };

  const fragments = script.fragments ?? {};
  const pools = new Set<string>();
  const vars = new Set<string>();
  const conds = new Set<string>();
  const cases = new Map<string, Set<string>>();
  const includes = new Set<string>();
  const clipBases = new Set<string>();
  const walked = new Set<string>();
  const pending: (readonly ScriptStep[])[] = [entry.sequence ?? []];

  while (pending.length > 0) {
    const steps = pending.pop() as readonly ScriptStep[];
    const refs = collectStepReferences(steps);

    for (const name of refs.pools) pools.add(resolvePool(script, name));

    for (const name of refs.vars) vars.add(name);

    for (const name of refs.conds) conds.add(name);

    for (const { name, keys } of refs.cases) {
      const merged = cases.get(name) ?? new Set<string>();
      cases.set(name, merged);

      for (const key of keys) merged.add(key);
    }

    for (const name of refs.includes) {
      includes.add(name);

      if (!walked.has(name) && Object.hasOwn(fragments, name)) {
        walked.add(name);
        pending.push(fragments[name].sequence);
      }
    }

    for (const clip of collectLiteralClips(steps)) {
      const match = VOICE_CLIP_PATH.exec(clip);

      if (match) clipBases.add(`${match[1]}/${stripTakeSuffix(match[2])}`);
    }
  }

  return {
    references: {
      pools: sorted(pools),
      vars: sorted(vars),
      conds: sorted(conds),
      cases: sorted(cases.keys()).map((name) => ({ name, keys: sorted(cases.get(name) ?? []) })),
      includes: sorted(includes),
      frames: entry.frame !== undefined && entry.frame !== NO_FRAME ? [entry.frame] : [],
    },
    clipBases,
  };
}

/** A slashed name is already a source; a `pools` alias resolves to its source; an alias the script does not define is kept as written. */
function resolvePool(script: CalloutScript, name: string): string {
  if (name.includes("/")) return name;

  // `hasOwn`, not a lookup: `pool:constructor` is a well-formed name.
  if (!Object.hasOwn(script.pools, name)) return name;

  const { group, base } = script.pools[name];

  return `${group}/${base}`;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

function buildVocabulary(report: VocabularyReport, walks: ReadonlyMap<string, EntryWalk>): PackReferenceVocabulary {
  const usersOf = (pick: (references: CalloutReferences) => readonly string[]): ReadonlyMap<string, string[]> => {
    const users = new Map<string, string[]>();

    for (const [id, { references }] of walks) {
      for (const name of pick(references)) {
        const ids = users.get(name);

        if (ids) ids.push(id);
        else users.set(name, [id]);
      }
    }

    return users;
  };

  const varUsers = usersOf((r) => r.vars);
  const condUsers = usersOf((r) => r.conds);
  const caseUsers = usersOf((r) => r.cases.map((c) => c.name));
  const byName = <T extends { name: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => compare(a.name, b.name));

  return {
    vars: byName(report.vars).map(({ name, description }) => ({
      name,
      description,
      usedBy: sorted(varUsers.get(name) ?? []),
    })),
    conds: byName(report.conds).map(({ name, description }) => ({
      name,
      description,
      usedBy: sorted(condUsers.get(name) ?? []),
    })),
    cases: byName(report.cases).map(({ name, description, keys }) => ({
      name,
      description,
      keys: { ...keys },
      usedBy: sorted(caseUsers.get(name) ?? []),
    })),
  };
}

// ─── Recording script ────────────────────────────────────────────────────────

/** The `-NN` take suffix, as the engine's manifest-derived pools read it (`green-01` → `green`). */
function stripTakeSuffix(name: string): string {
  return name.replace(/-\d{2}$/, "");
}

function buildRecordingScript(
  groups: PackReferenceInput["groups"],
  manifestClips: readonly string[],
  voice: string,
  walks: ReadonlyMap<string, EntryWalk>,
  vars: readonly VocabularyItem[],
): RecordingGroup[] {
  // Takes per base, per group, off the voice's manifest clips.
  const prefix = `voice/${voice}/`;
  const takes = new Map<string, Map<string, number>>();

  for (const clip of manifestClips) {
    if (!clip.startsWith(prefix) || !clip.endsWith(".mp3")) continue;

    const rest = clip.slice(prefix.length, -".mp3".length);
    const slash = rest.indexOf("/");

    if (slash <= 0 || rest.includes("/", slash + 1)) continue;

    const group = rest.slice(0, slash);
    const base = stripTakeSuffix(rest.slice(slash + 1));
    let bases = takes.get(group);

    if (!bases) {
      bases = new Map();
      takes.set(group, bases);
    }

    bases.set(base, (bases.get(base) ?? 0) + 1);
  }

  // Direct consumers: the callouts whose entries draw from a base by pool or by literal clip.
  const directUsers = new Map<string, Set<string>>();

  for (const [id, { references, clipBases }] of walks) {
    for (const key of [...references.pools, ...clipBases]) {
      let ids = directUsers.get(key);

      if (!ids) {
        ids = new Set();
        directUsers.set(key, ids);
      }

      ids.add(id);
    }
  }

  return sorted(takes.keys()).map((group) => {
    // Consumers through a var: every var whose description names the group
    // draws some line of it, so its callouts are consumers of every line here.
    const viaVar = vars.filter((v) => descriptionNamesGroup(v.description, group));
    const varUsers = viaVar.flatMap((v) => v.usedBy);
    const lines = Object.hasOwn(groups, group) ? groups[group] : [];
    const bases = takes.get(group) ?? new Map<string, number>();

    return {
      group,
      lines: sorted(bases.keys()).map((base) => ({
        base,
        text: lines.find((l) => l.name === `${base}-01`)?.text ?? lines.find((l) => l.name === base)?.text ?? null,
        takes: bases.get(base) ?? 0,
        usedBy: sorted(new Set([...(directUsers.get(`${group}/${base}`) ?? []), ...varUsers])),
        viaVar: viaVar.map((v) => v.name),
      })),
    };
  });
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/** Code-point order, not `localeCompare` — see the module header. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compare);
}
