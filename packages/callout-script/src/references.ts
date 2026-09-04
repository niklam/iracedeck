import { type CalloutScript, NO_FRAME, parseCondReference, parseStringStep, type ScriptStep } from "./grammar.js";

/**
 * Everything a script refers to by name. A consumer checks each list against
 * what it holds — the engine against its contracts and vocabulary, a linter
 * against the published reference — without walking the grammar itself.
 *
 * Every list is deduped and sorted, so two scripts that reference the same
 * things compare equal however they are laid out.
 */
export type ScriptReferences = {
  /** Keys of `scenarios`, `skip: true` entries included. */
  scenarioIds: readonly string[];
  /** Every pool name any sequence references, string and object forms alike; a `group/base` name is included as written. */
  pools: readonly string[];
  vars: readonly string[];
  /** Condition names without their `!`. */
  conds: readonly string[];
  /** Each case with the branch keys the script maps, `"default"` excluded; keys merge across uses. */
  cases: readonly { name: string; keys: readonly string[] }[];
  /** Included scenario ids without their `@`. */
  includes: readonly string[];
  /** Every `frame` override an entry names. `"none"` is the reserved word for unframed, not a reference, so it is left out; defaults are the engine's. */
  frames: readonly string[];
};

/** The branch key a `case` falls back to; it maps to no declared key. */
const DEFAULT_BRANCH = "default";

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
        if (key !== DEFAULT_BRANCH) keys.add(key);

        this.walk(branch);
      }
    }
    // clip, connector, pause, ambient: nothing to reference.
  }

  private visitString(step: string): void {
    const form = parseStringStep(step);

    if (form.kind === "pool") this.pools.add(form.name);
    else if (form.kind === "var") this.vars.add(form.name);
    else if (form.kind === "include") this.includes.add(form.id);
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * Walk a parsed script and list everything it references by name — through
 * every `then`/`else`/`optional`/`of` branch, and through the frames' own
 * `open`/`close` sequences.
 */
export function collectScriptReferences(script: CalloutScript): ScriptReferences {
  const collector = new Collector();
  const frames = new Set<string>();

  for (const entry of Object.values(script.scenarios)) {
    if (entry.frame !== undefined && entry.frame !== NO_FRAME) frames.add(entry.frame);

    if (entry.sequence) collector.walk(entry.sequence);
  }

  for (const frame of Object.values(script.frames)) {
    collector.walk(frame.open);
    collector.walk(frame.close);
  }

  return {
    scenarioIds: sorted(Object.keys(script.scenarios)),
    pools: sorted(collector.pools),
    vars: sorted(collector.vars),
    conds: sorted(collector.conds),
    cases: sorted(collector.cases.keys()).map((name) => ({ name, keys: sorted(collector.cases.get(name) ?? []) })),
    includes: sorted(collector.includes),
    frames: sorted(frames),
  };
}
