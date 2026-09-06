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
 *   a resolver is a closure. It fills a recording line's `viaVar` and nothing
 *   else: `usedBy` stays the DIRECT consumers, so a reader can tell "this
 *   entry names the line" from "some var in this group might".
 *
 * A third attribution is not the builder's to know: the few clips PLUGIN CODE
 * plays by path outside any script (the connect radio check, the driver's
 * name). The caller hands them in (`pluginPlayed`, the runner's list) and the
 * builder writes each onto its recording line as `playedBy`, so the website
 * renders the artifact's words and mirrors no list of its own.
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
  stripTakeSuffix,
  TAKE_SUFFIX,
  VOICE_CLIP_PATH,
} from "@iracedeck/callout-script";

import { WEIGHT } from "../dsl.js";
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
  /** The `WEIGHT` band the weight is exactly (`"SAFETY"` for 70); `null` for a weight on no band. */
  weightBand: string | null;
  queueable: boolean;
  interrupt: boolean;
  /**
   * The contract's `base` as registered — what a bare literal clip path in
   * the entry resolves against (`"voice/{voice}"` puts `flags/green-01.mp3`
   * in the voice's folder; `null` leaves it at the audio root).
   */
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
  /**
   * The bundled config's text of EVERY shipped take, in take order — a bare
   * `<base>` first, then `<base>-01`, `-02`, … — since the bundled voice's
   * takes are alternate wordings, not repeats. A take the config has no text
   * for is left out, so `texts.length <= takes`; `[]` when it has none.
   */
  texts: readonly string[];
  /** How many takes the bundled voice ships — every `<base>-NN.mp3`, or the bare `<base>.mp3`. */
  takes: number;
  /**
   * Callout ids whose entries — or the fragments they include — address the
   * base DIRECTLY: a `pool:<group>/<base>` step, a `pools` alias resolving to
   * it, or a literal clip. A var that draws from the group is `viaVar`; its
   * callouts are on the vocabulary page, not repeated here.
   */
  usedBy: readonly string[];
  /** Var names whose description names the line's group — see {@link descriptionNamesGroup}. */
  viaVar: readonly string[];
  /**
   * What plugin code plays this line for, outside any script, in the
   * caller's words (`pluginPlayed`); `null` for the lines only a script can
   * reach — which is every line but the handful the plugin plays by path.
   */
  playedBy: string | null;
};

export type RecordingGroup = { group: string; lines: readonly RecordingLine[] };

/**
 * One clip plugin code plays by path with the active voice, outside any
 * script: the group and base it addresses, and — for the recording line —
 * what plays it, said for a pack author. `base` may be
 * {@link PLUGIN_PLAYED_ANY_BASE} for a group the plugin plays every base of
 * (the driver-name clips: one per name, the name chosen at runtime).
 */
export type PluginPlayedClip = { group: string; base: string; playedBy: string };

/** The `base` of a {@link PluginPlayedClip} that stands for every base of its group. */
export const PLUGIN_PLAYED_ANY_BASE = "*";

/**
 * The plugin-played entry a `group/base` falls under — the exact base first,
 * then the group's wildcard — or `undefined`. Shared with `lint:pack`, whose
 * orphan exemption is the same lookup without the words.
 */
export function pluginPlayedEntry<T extends { group: string; base: string }>(
  entries: readonly T[],
  group: string,
  base: string,
): T | undefined {
  return (
    entries.find((entry) => entry.group === group && entry.base === base) ??
    entries.find((entry) => entry.group === group && entry.base === PLUGIN_PLAYED_ANY_BASE)
  );
}

/**
 * Provenance, in the shape the repo's other generated artifacts carry
 * (`changelog.json`, `getting-started.json`): the repo-relative sources the
 * artifact is built from, so a reader of the JSON knows what to edit and
 * regenerate. Deliberately version-free — the artifact is freshness-tested
 * against a rebuild, and a version stamp would only make every release bump
 * stale it.
 */
export type PackReferenceMeta = {
  /** Repo-relative paths of what the generator reads, in the caller's order. */
  generatedFrom: readonly string[];
};

export type PackReference = {
  _meta: PackReferenceMeta;
  callouts: readonly Callout[];
  vocabulary: PackReferenceVocabulary;
  recordingScript: readonly RecordingGroup[];
};

// ─── The input ───────────────────────────────────────────────────────────────

/** One authored line of the voice config's `groups`: the take's name and the text it speaks. */
export type VoiceConfigLine = { name: string; text: string };

export type PackReferenceInput = {
  /** Repo-relative paths of the sources the caller read — recorded as `_meta.generatedFrom`, nothing else. */
  generatedFrom: readonly string[];
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
  /**
   * The clips plugin code plays by path outside any script, with the words
   * for each — the runner's `PLUGIN_PLAYED_CLIPS` (`scripts/lib/lint-pack-run.mjs`),
   * the plugin's knowledge rather than this builder's. Written onto the
   * matching recording lines as `playedBy`.
   */
  pluginPlayed: readonly PluginPlayedClip[];
  /** Which voice's clips make the recording script. Defaults to the bundled voice, `default`. */
  voice?: string;
};

/** The bundled voice, whose clips the recording script is built from unless told otherwise. */
const DEFAULT_VOICE = "default";

// ─── Building ────────────────────────────────────────────────────────────────

export function buildPackReference(input: PackReferenceInput): PackReference {
  const { script } = input;
  const voice = input.voice ?? DEFAULT_VOICE;

  const unscripted = sorted(input.contracts.map((c) => c.id).filter((id) => !Object.hasOwn(script.scenarios, id)));

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
        weightBand: weightBandOf(contract.weight),
        queueable: contract.queueable,
        interrupt: contract.interrupt,
        base: contract.base,
        comment: entry.comment ?? null,
        test: entry.test ?? null,
        skip: entry.skip === true,
        references: walk.references,
      };
    });

  const vocabulary = buildVocabulary(input.vocabulary, walks);
  const recordingScript = buildRecordingScript(
    input.groups,
    input.manifestClips,
    voice,
    walks,
    vocabulary.vars,
    input.pluginPlayed,
  );

  return { _meta: { generatedFrom: [...input.generatedFrom] }, callouts, vocabulary, recordingScript };
}

/** Serialise the artifact exactly as it is committed — 2-space JSON, trailing newline — so the freshness test can compare text. */
export function serializePackReference(reference: PackReference): string {
  return `${JSON.stringify(reference, null, 2)}\n`;
}

/** The `WEIGHT` key whose value IS the weight (`70` → `"SAFETY"`), or `null` — a band is named only where the number is exactly one. */
function weightBandOf(weight: number): string | null {
  return Object.entries(WEIGHT).find(([, value]) => value === weight)?.[0] ?? null;
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

/** Where a take sits in the recording order: the bare `<base>` first, then `-01`, `-02`, … */
function takeOrder(name: string): number {
  const match = TAKE_SUFFIX.exec(name);

  return match ? Number(match[1]) : 0;
}

/**
 * A pool reference as a recording-line key: `group/base-01` — a legal step
 * naming one take — lands on the line of its base, the way a literal clip's
 * take does in `walkEntry`. An alias the script never defined has no slash
 * and is left as written; it keys no line.
 */
function lineKeyOf(pool: string): string {
  const slash = pool.indexOf("/");

  return slash < 0 ? pool : `${pool.slice(0, slash + 1)}${stripTakeSuffix(pool.slice(slash + 1))}`;
}

function buildRecordingScript(
  groups: PackReferenceInput["groups"],
  manifestClips: readonly string[],
  voice: string,
  walks: ReadonlyMap<string, EntryWalk>,
  vars: readonly VocabularyItem[],
  pluginPlayed: readonly PluginPlayedClip[],
): RecordingGroup[] {
  // The shipped take names per base, per group, off the voice's manifest clips.
  const prefix = `voice/${voice}/`;
  const takesByGroup = new Map<string, Map<string, string[]>>();

  for (const clip of manifestClips) {
    if (!clip.startsWith(prefix) || !clip.endsWith(".mp3")) continue;

    const rest = clip.slice(prefix.length, -".mp3".length);
    const slash = rest.indexOf("/");

    if (slash <= 0 || rest.includes("/", slash + 1)) continue;

    const group = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    const base = stripTakeSuffix(name);
    let bases = takesByGroup.get(group);

    if (!bases) {
      bases = new Map();
      takesByGroup.set(group, bases);
    }

    const names = bases.get(base);

    if (names) names.push(name);
    else bases.set(base, [name]);
  }

  // Direct consumers: the callouts whose entries draw from a base by pool or by literal clip.
  const directUsers = new Map<string, Set<string>>();

  for (const [id, { references, clipBases }] of walks) {
    for (const key of [...references.pools.map(lineKeyOf), ...clipBases]) {
      let ids = directUsers.get(key);

      if (!ids) {
        ids = new Set();
        directUsers.set(key, ids);
      }

      ids.add(id);
    }
  }

  return sorted(takesByGroup.keys()).map((group) => {
    // The vars whose description names the group — noted on every line of
    // it, since which line a resolver picks is a runtime decision. Their
    // callouts are deliberately NOT folded into `usedBy` (see the type).
    const viaVar = vars.filter((v) => descriptionNamesGroup(v.description, group)).map((v) => v.name);
    const authored = new Map((Object.hasOwn(groups, group) ? groups[group] : []).map((l) => [l.name, l.text]));
    const bases = takesByGroup.get(group) ?? new Map<string, string[]>();

    return {
      group,
      lines: sorted(bases.keys()).map((base) => {
        const names = [...(bases.get(base) ?? [])].sort((a, b) => takeOrder(a) - takeOrder(b));

        return {
          base,
          texts: names.flatMap((name) => {
            const text = authored.get(name);

            return text === undefined ? [] : [text];
          }),
          takes: names.length,
          usedBy: sorted(directUsers.get(`${group}/${base}`) ?? []),
          viaVar: [...viaVar],
          playedBy: pluginPlayedEntry(pluginPlayed, group, base)?.playedBy ?? null,
        };
      }),
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
