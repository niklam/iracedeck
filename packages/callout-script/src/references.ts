import {
  type CalloutScript,
  CASE_DEFAULT_BRANCH,
  CONNECTOR_POOL,
  type FragmentDefinition,
  NO_FRAME,
  parseCondReference,
  parseStringStep,
  type ScriptStep,
} from "./grammar.js";

/**
 * What ONE step list refers to by name — the per-sequence half of
 * {@link ScriptReferences}, for a consumer that attributes references to the
 * entry or fragment that makes them (the generated pack-author reference
 * lists each callout's own, #1066) rather than to the script as a whole.
 *
 * Every list is deduped and sorted, so two step lists that reference the same
 * things compare equal however they are laid out.
 */
export type StepReferences = {
  /**
   * Every pool name the steps reference, string and object forms alike; a
   * `group/base` name is included as written. A `{ connector: true }` step draws
   * from the `connector` pool, so it is reported here under that name.
   */
  pools: readonly string[];
  vars: readonly string[];
  /** Condition names without their `!`. */
  conds: readonly string[];
  /** Each case with the branch keys the steps map, `"default"` excluded; keys merge across uses. */
  cases: readonly { name: string; keys: readonly string[] }[];
  /**
   * Included fragment names without their `@`. An include is NOT followed
   * here: what the fragment itself references belongs to whoever holds the
   * script and can look the fragment up.
   */
  includes: readonly string[];
};

/**
 * Everything a script refers to by name. A consumer checks each list against
 * what it holds — the engine against its contracts and vocabulary, a linter
 * against the published reference — without walking the grammar itself.
 *
 * Every list is deduped and sorted, so two scripts that reference the same
 * things compare equal however they are laid out. The five
 * {@link StepReferences} lists are merged over every sequence the script
 * plays: entries, the frames' `open` / `close`, and every fragment's
 * `sequence`.
 */
export type ScriptReferences = StepReferences & {
  /**
   * Keys of `scenarios`, `skip: true` entries included. A `skip: true` entry
   * contributes its id and NOTHING else — not its `frame`, not anything a
   * `sequence` beside the skip would name — because the compiler never reads
   * past the skip, so nothing in such an entry is a reference the engine
   * will resolve.
   */
  scenarioIds: readonly string[];
  /** Every `frame` override an entry names. `"none"` is the reserved word for unframed, not a reference, so it is left out; defaults are the engine's. */
  frames: readonly string[];
  /**
   * The fragment names the script DEFINES (issue #1065) — not references, but
   * what `includes` must be checked against: an include resolves only within
   * the same script, so `includes ⊆ fragments` is the whole rule, and a
   * consumer can state it without walking the grammar.
   */
  fragments: readonly string[];
  /**
   * The defined fragments nothing LIVE includes: not an entry that is not
   * `skip: true`, not a frame, and not another fragment that is itself
   * included by one of those (transitively — `old` including `helper`, with
   * nothing including `old`, leaves both here). The compiler converts a
   * fragment only when something includes it, so what one of these
   * references is resolved by no entry the engine compiles; a consumer
   * that counts a script's references against its clips walks the live
   * fragments only, and a consumer that wants every fragment used holds
   * this to `[]`. `includes` still lists every include, from these too.
   */
  unincludedFragments: readonly string[];
};

class Collector {
  readonly pools = new Set<string>();
  readonly vars = new Set<string>();
  readonly conds = new Set<string>();
  readonly cases = new Map<string, Set<string>>();
  readonly includes = new Set<string>();

  walk(steps: readonly ScriptStep[]): void {
    for (const step of steps) this.visit(step);
  }

  private visit(step: ScriptStep): void {
    if (typeof step === "string") {
      this.visitString(step);

      return;
    }

    if ("pool" in step) this.pools.add(step.pool);
    else if ("connector" in step) this.pools.add(CONNECTOR_POOL);
    else if ("var" in step) this.vars.add(step.var);
    else if ("include" in step) this.includes.add(step.include);
    else if ("optional" in step) this.walk(step.optional);
    else if ("if" in step) {
      this.conds.add(parseCondReference(step.if).name);
      this.walk(step.then);

      if (step.else) this.walk(step.else);
    } else if ("case" in step) {
      const keys = this.cases.get(step.case) ?? new Set<string>();
      this.cases.set(step.case, keys);

      for (const [key, branch] of Object.entries(step.of)) {
        if (key !== CASE_DEFAULT_BRANCH) keys.add(key);

        this.walk(branch);
      }
    }
    // clip, pause, ambient: nothing to reference.
  }

  private visitString(step: string): void {
    const form = parseStringStep(step);

    if (form.kind === "pool") this.pools.add(form.name);
    else if (form.kind === "var") this.vars.add(form.name);
    else if (form.kind === "include") this.includes.add(form.id);
  }

  /** What has been walked so far, deduped and sorted — the {@link StepReferences} shape. */
  report(): StepReferences {
    return {
      pools: sorted(this.pools),
      vars: sorted(this.vars),
      conds: sorted(this.conds),
      cases: sorted(this.cases.keys()).map((name) => ({ name, keys: sorted(this.cases.get(name) ?? []) })),
      includes: sorted(this.includes),
    };
  }
}

/**
 * List what one step list references by name — through every
 * `then`/`else`/`optional`/`of` branch, an include NOT followed (see
 * {@link StepReferences.includes}). The per-sequence walk
 * {@link collectScriptReferences} runs over every sequence a script plays,
 * exposed so a consumer can attribute references to the entry or fragment
 * that makes them (#1066) with the same arms a new step form is added to.
 */
export function collectStepReferences(steps: readonly ScriptStep[]): StepReferences {
  const collector = new Collector();
  collector.walk(steps);

  return collector.report();
}

/**
 * Every literal clip a step list plays — a bare path string or a `{ clip }`
 * object — through every `optional` / `then` / `else` / `of` branch, in
 * order, duplicates kept. An include is NOT followed: a fragment is walked as
 * a source of its own, once, by whoever holds the script, and the compiler
 * inlines it into every entry that includes it. `collectScriptReferences`
 * deliberately leaves clips out (they are not references by NAME), so the
 * completeness and coverage checks share this walk instead of each keeping a
 * copy that a new step form could leave behind.
 */
export function collectLiteralClips(steps: readonly ScriptStep[]): string[] {
  const out: string[] = [];

  const visit = (step: ScriptStep): void => {
    if (typeof step === "string") {
      const form = parseStringStep(step);

      if (form.kind === "clip") out.push(form.path);

      return;
    }

    if ("clip" in step) out.push(step.clip);
    else if ("optional" in step) step.optional.forEach(visit);
    else if ("if" in step) {
      step.then.forEach(visit);
      step.else?.forEach(visit);
    } else if ("case" in step) Object.values(step.of).forEach((branch) => branch.forEach(visit));
    // var, pool, connector, pause, include, ambient: no literal clip.
  };

  steps.forEach(visit);

  return out;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * The includes one step list makes, in the two spellings, without walking
 * anything else — the edges of the include graph `liveFragments` follows.
 */
function includesOf(steps: readonly ScriptStep[]): string[] {
  const collector = new Collector();
  collector.walk(steps);

  return [...collector.includes];
}

/**
 * The fragments reachable through includes from the live roots — every
 * non-skipped entry and every frame — following fragment-to-fragment
 * includes until nothing new is reached. A name the script does not define
 * is an unknown include, listed under `includes` and not a fragment; it is
 * dropped here rather than followed.
 */
function liveFragments(script: CalloutScript, fragments: Readonly<Record<string, FragmentDefinition>>): Set<string> {
  const live = new Set<string>();
  const pending: string[] = [];

  for (const entry of Object.values(script.scenarios)) {
    if (entry.skip !== true && entry.sequence) pending.push(...includesOf(entry.sequence));
  }

  for (const frame of Object.values(script.frames)) pending.push(...includesOf(frame.open), ...includesOf(frame.close));

  while (pending.length > 0) {
    const name = pending.pop() as string;

    if (live.has(name) || !Object.hasOwn(fragments, name)) continue;

    live.add(name);
    pending.push(...includesOf(fragments[name].sequence));
  }

  return live;
}

/**
 * Walk a parsed script and list everything it references by name — through
 * every `then`/`else`/`optional`/`of` branch, through the frames' own
 * `open`/`close` sequences, and through every fragment's sequence (a pool
 * used only inside a fragment still has to exist). A `skip: true` entry is
 * listed by id only (see {@link ScriptReferences.scenarioIds}).
 */
export function collectScriptReferences(script: CalloutScript): ScriptReferences {
  const collector = new Collector();
  const frames = new Set<string>();

  for (const entry of Object.values(script.scenarios)) {
    // The compiler's own rule: a skipped entry is a deliberate silence and
    // nothing in it is compiled, so nothing in it is referenced either.
    if (entry.skip === true) continue;

    if (entry.frame !== undefined && entry.frame !== NO_FRAME) frames.add(entry.frame);

    if (entry.sequence) collector.walk(entry.sequence);
  }

  for (const frame of Object.values(script.frames)) {
    collector.walk(frame.open);
    collector.walk(frame.close);
  }

  const fragments = script.fragments ?? {};

  for (const fragment of Object.values(fragments)) collector.walk(fragment.sequence);

  const live = liveFragments(script, fragments);

  return {
    scenarioIds: sorted(Object.keys(script.scenarios)),
    ...collector.report(),
    frames: sorted(frames),
    fragments: sorted(Object.keys(fragments)),
    unincludedFragments: sorted(Object.keys(fragments).filter((name) => !live.has(name))),
  };
}
