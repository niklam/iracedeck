/**
 * Script coverage (issues #1065, #1066): what a voice's script references
 * held against the clips the voice ships, in both directions, plus the two
 * fragment rules. The rules the bundled voice is checked with in
 * `@iracedeck/audio-assets` (`script-coverage.test.ts`, where they were
 * written) and the ones `lint:pack` tells a pack author about — one module,
 * because a linter that could not name the same things the generator's test
 * names would be a second source of truth.
 *
 * It lives here rather than in either consumer because the two cannot see
 * each other: the audio-scenarios package depends on audio-assets, and the
 * generator's sources are run by `tsx` and never built. This package is the
 * grammar both already hold, and a coverage check is a `collectScriptReferences`
 * read against a clip list — nothing here knows a config or a filesystem.
 *
 * The input is the script and the AUTHORED names — every `<group>/<name>` the
 * voice ships, the name as written (`flags/blue-01`), whoever produced the
 * list: a voice config's `groups`, or the `.mp3` files under `voice/<id>/`.
 *
 * (a) ORPHANS — a shipped base nothing references is a clip that never plays:
 *     a misspelling, or a line that lost its consumer. Whether a group is
 *     var-driven — a resolver picks its bases at fire time, so no step names
 *     them — is the CALLER's knowledge, handed in as a predicate: the
 *     generator's test cannot see the vocabulary and treats every group no
 *     step addresses as var-driven; `lint:pack` reads it off the vocabulary's
 *     descriptions. A base in a var-driven group is never an orphan here.
 * (b) DANGLING — every `<group>/<base>` the script references, in either
 *     spelling, must be shipped; every plain pool NAME must be defined under
 *     `pools` (a `{ connector: true }` step included — the engine draws it
 *     from the named `connector` pool); and every literal clip path must be
 *     one this check can place — the voice's own
 *     `voice/<voice>/<group>/<name>.mp3`, or a shared `sfx/…` built-in, which
 *     is nobody's to author. A reference to nothing is a callout the engine
 *     aborts at fire time (#835), silently.
 * (c) FRAGMENTS — every fragment the script defines is included from a live
 *     entry or a frame (directly, or through another live fragment), and
 *     every include names a fragment the script defines. The compiler
 *     converts a fragment only when something includes it, so a fragment
 *     nothing includes — or that only a `skip: true` entry includes — is
 *     checked by nobody through an entry, and what it references counts
 *     here as unreferenced.
 *
 * Authored names are read the way the engine's `poolMemberPattern` reads the
 * files: `<base>-NN.mp3` is a take of `<base>`, and the bare `<name>.mp3` is a
 * pool of its own — so an authored `countdown-90` with no `-01` take answers
 * to a reference to `countdown-90` AND, `90` being two digits, to `countdown`.
 * Reading the name one way only reports such a clip as an orphan and its own
 * reference as dangling, which the engine would have played fine.
 */
import type { CalloutScript, ScriptStep } from "./grammar.js";
import { collectLiteralClips, collectScriptReferences } from "./references.js";

export type CoverageInput = {
  script: CalloutScript;
  /** Every clip the voice ships, as `<group>/<name>` with the name as written (`flags/blue-01`). */
  authored: readonly string[];
};

/** What a script covers of the clips its voice ships — the raw sets the rules below read. */
export type Coverage = {
  /** `<group>/<base>` keys the voice ships, each name with its `-NN` take suffix stripped. */
  authored: ReadonlySet<string>;
  /** `<group>/<name>` keys the voice ships, the names as written. */
  authoredNames: ReadonlySet<string>;
  /** `<group>/<base>` keys the live script references, in any spelling, plus every defined pool's source. */
  referenced: ReadonlySet<string>;
  /** The groups `referenced` touches. */
  scriptedGroups: ReadonlySet<string>;
  /** Plain pool names a sequence draws from that `pools` does not define. */
  undefinedPools: readonly string[];
  /** Literal clip paths this check cannot place (rule b): not the voice's own, not a shared `sfx/` built-in. */
  unrecognisedLiterals: readonly string[];
  /** Fragments the script defines that no live entry, frame or live fragment includes (rule c). */
  unincludedFragments: readonly string[];
  /** Includes of fragments the script does not define (rule c). */
  unknownIncludes: readonly string[];
};

/** The findings, each list sorted in code-point order. */
export type CoverageReport = {
  /** Shipped `<group>/<base>` keys nothing references, in groups the caller did not claim as var-driven. */
  orphans: readonly string[];
  /** Referenced `<group>/<base>` keys the voice does not ship. */
  dangling: readonly string[];
  undefinedPools: readonly string[];
  unrecognisedLiterals: readonly string[];
  unknownIncludes: readonly string[];
  unincludedFragments: readonly string[];
};

/**
 * Which clip groups a var resolver draws from, so their unreferenced bases
 * are nobody's typo to report. See the header for the two readings.
 */
export type VarDrivenGroup = (group: string) => boolean;

/** Strip the `-NN` take suffix from a name (`blue-01` → `blue`). */
function stripTakeSuffix(name: string): string {
  return name.replace(/-\d{2}$/, "");
}

/** `voice/<voice>/<group>/<name>.mp3` — a literal clip step addressing one of the voice's own clips. */
const VOICE_CLIP_PATH = /^voice\/[^/]+\/([^/]+)\/([^/]+)\.mp3$/;

/**
 * The shared built-ins a frame plays around every voice (the ticks, the
 * ambience bed): the plugin's, never a voice's to author, so a literal that
 * addresses one is not this check's business. A leading `/` is the DSL's
 * escape from a contract's `base`; the engine strips it, and so does this.
 */
const SHARED_SFX_PREFIX = "sfx/";

/** Every step list a script plays: entries (skipped ones excluded), frames, fragments. */
function stepLists(script: CalloutScript): readonly (readonly ScriptStep[])[] {
  return [
    ...Object.values(script.scenarios).flatMap((entry) =>
      entry.skip !== true && entry.sequence ? [entry.sequence] : [],
    ),
    ...Object.values(script.frames).flatMap((frame) => [frame.open, frame.close]),
    ...Object.values(script.fragments ?? {}).map((fragment) => fragment.sequence),
  ];
}

/**
 * What a script covers of the clips its voice ships. References are read off
 * the LIVE script — the fragments nothing includes taken out — since what a
 * dead fragment names is resolved by no entry the engine compiles; the
 * fragment itself is reported instead.
 */
export function coverageOf({ script, authored: authoredList }: CoverageInput): Coverage {
  const all = collectScriptReferences(script);
  const unincludedFragments = [...all.unincludedFragments];
  const unknownIncludes = all.includes.filter((name) => !all.fragments.includes(name));
  const fragments = Object.fromEntries(
    Object.entries(script.fragments ?? {}).filter(([name]) => !unincludedFragments.includes(name)),
  );
  const live: CalloutScript = { ...script, fragments };
  const refs = collectScriptReferences(live);
  const authored = new Set<string>();
  const authoredNames = new Set<string>();
  const referenced = new Set<string>();
  const undefinedPools: string[] = [];
  const unrecognisedLiterals: string[] = [];

  for (const key of authoredList) {
    const group = groupOf(key);
    authored.add(`${group}${stripTakeSuffix(key.slice(group.length))}`);
    authoredNames.add(key);
  }

  for (const name of refs.pools) {
    const slash = name.indexOf("/");

    if (slash > 0) {
      referenced.add(name);
    } else if (Object.hasOwn(script.pools, name)) {
      // `hasOwn`, not a lookup: `pool:constructor` is a well-formed name and
      // must not resolve to `Object.prototype.constructor`.
      const { group, base } = script.pools[name];
      referenced.add(`${group}/${base}`);
    } else {
      undefinedPools.push(name);
    }
  }

  // A defined alias is a reference too: its source must exist even when no
  // sequence draws from the name yet.
  for (const { group, base } of Object.values(script.pools)) referenced.add(`${group}/${base}`);

  for (const steps of stepLists(live)) {
    for (const clip of collectLiteralClips(steps)) {
      const path = clip.startsWith("/") ? clip.slice(1) : clip;

      if (path.startsWith(SHARED_SFX_PREFIX)) continue;

      const match = VOICE_CLIP_PATH.exec(path);

      if (match) referenced.add(`${match[1]}/${stripTakeSuffix(match[2])}`);
      else unrecognisedLiterals.push(path);
    }
  }

  const scriptedGroups = new Set([...referenced].map((key) => key.slice(0, key.indexOf("/"))));

  return {
    authored,
    authoredNames,
    referenced,
    scriptedGroups,
    undefinedPools: undefinedPools.sort(),
    unrecognisedLiterals: unrecognisedLiterals.sort(),
    unincludedFragments,
    unknownIncludes,
  };
}

/** The `<group>/` prefix of a `<group>/<name>` key. */
function groupOf(key: string): string {
  return key.slice(0, key.indexOf("/") + 1);
}

/**
 * Rule (a): shipped names nothing references, outside the groups the caller
 * claims a var draws from. A shipped name is referenced when the script
 * names it as written OR by its `-NN`-stripped base — the two pools the
 * engine would count the file into (see the header). Reported by base,
 * sorted.
 */
export function orphansOf({ authoredNames, referenced }: Coverage, varDriven: VarDrivenGroup): string[] {
  const orphans = new Set<string>();

  for (const key of authoredNames) {
    const group = groupOf(key);
    const name = key.slice(group.length);
    const base = `${group}${stripTakeSuffix(name)}`;

    if (varDriven(group.slice(0, -1))) continue;

    if (referenced.has(key) || referenced.has(base)) continue;

    orphans.add(base);
  }

  return [...orphans].sort();
}

/** Rule (b), the clip half: referenced bases nothing ships — a referenced base is shipped when some name equals it or strips to it. */
export function danglingBasesOf({ authored, authoredNames, referenced }: Coverage): string[] {
  return [...referenced].filter((key) => !authored.has(key) && !authoredNames.has(key)).sort();
}

/**
 * Rule (b) as one worded list: the dangling bases, the named pools nothing
 * defines, and the literal clip paths this check cannot place — the form a
 * test's failure message reads. A linter that pairs these with the compiler's
 * entry-named diagnostics reads the parts off {@link checkCoverage} instead.
 */
export function danglingOf(coverage: Coverage): string[] {
  return [
    ...danglingBasesOf(coverage),
    ...coverage.undefinedPools.map((name) => `pool "${name}" (named, defined nowhere under pools)`),
    ...coverage.unrecognisedLiterals.map(
      (path) => `literal "${path}" (not voice/<voice>/<group>/<name>.mp3 — a path this check cannot place)`,
    ),
  ].sort();
}

/** All three rules in one call. */
export function checkCoverage(input: CoverageInput, varDriven: VarDrivenGroup): CoverageReport {
  const coverage = coverageOf(input);

  return {
    orphans: orphansOf(coverage, varDriven),
    dangling: danglingBasesOf(coverage),
    undefinedPools: coverage.undefinedPools,
    unrecognisedLiterals: coverage.unrecognisedLiterals,
    unknownIncludes: coverage.unknownIncludes,
    unincludedFragments: coverage.unincludedFragments,
  };
}
