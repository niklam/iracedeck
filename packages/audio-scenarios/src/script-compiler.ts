/**
 * Script compiler (issue #1064): turns one voice's `callouts.json` into the
 * `ResolvedStep` trees the interpreter walks, checked against everything the
 * engine registered in code — contracts, vars, conditions, cases, pools and
 * the legacy fragments an include may target.
 *
 * Pure: no engine, no logger, no manifest. It returns diagnostics instead of
 * raising them, so the engine decides what to log and #1066's `lint:pack`
 * can run the same check against a published reference. It never throws —
 * a pack is never punished for what it does not say, and a mistake in one
 * entry costs exactly that entry.
 *
 * Skip semantics (spec, *Skip semantics*): an absent entry and a `skip: true`
 * entry are DELIBERATE skips (`deliberate: true`); an entry naming something
 * the engine does not know — a contract, pool, var, condition, case key,
 * include or frame — is skipped with a reason that names the reference, and
 * the engine warns about it once. A frame that fails to compile takes every
 * scenario that uses it down with it, with the frame's own reason.
 */
import {
  type CalloutScript,
  type CalloutScriptEntry,
  CASE_DEFAULT_BRANCH,
  CONNECTOR_POOL,
  type FrameDefinition,
  NO_FRAME,
  parseCondReference,
  type ScriptStep,
} from "@iracedeck/callout-script";

import { parseStepShorthand, type ResolvedStep } from "./dsl.js";

/** One voice's script, compiled against the engine's registries. */
export type CompiledVoiceScript = {
  /** Scenario id → the body the interpreter expands, and the frame name it is wrapped in (`NO_FRAME` = none). */
  scenarios: ReadonlyMap<string, { resolved: ResolvedStep[]; frame: string }>;
  /** Frame name → its compiled `open` / `close` steps. Only frames that compiled are present. */
  frames: ReadonlyMap<string, { open: ResolvedStep[]; close: ResolvedStep[] }>;
  /** Pool name → its manifest `(group, base)` source. Consulted before the code registry for this voice. */
  pools: ReadonlyMap<string, { group: string; base: string }>;
  /** Every contract this voice does NOT speak, and why. `deliberate` = `skip: true` or no entry at all. */
  skipped: readonly { id: string; reason: string; deliberate: boolean }[];
};

/** What the engine holds, as the compiler needs to see it. */
export type CompileDeps = {
  /** Every contract id the engine knows and its default frame. */
  contracts: ReadonlyMap<string, { frame: string }>;
  vars: ReadonlySet<string>;
  conds: ReadonlyMap<string, () => boolean>;
  cases: ReadonlyMap<string, { resolve: () => string | null; keys: ReadonlySet<string> }>;
  /** Code-registered pool names, consulted after the script's own. */
  legacyPools: ReadonlySet<string>;
  /** Legacy `defineScenario` ids an include may target. */
  fragments: ReadonlySet<string>;
};

/**
 * Internal control flow: a step referenced something the engine does not
 * know. Thrown by the converter, caught per entry (and per frame), never
 * escaping `compileVoiceScript`.
 */
class CompileProblem {
  constructor(readonly reason: string) {}
}

/** A frame's compilation outcome, kept so a failed frame can explain every scenario it fails. */
type FrameResult = { ok: true; open: ResolvedStep[]; close: ResolvedStep[] } | { ok: false; reason: string };

/** Compile one voice's script against what the engine registered. Never throws. */
export function compileVoiceScript(script: CalloutScript, deps: CompileDeps): CompiledVoiceScript {
  const converter = new StepConverter(script, deps);
  const frames = new Map<string, FrameResult>();
  const scenarios = new Map<string, { resolved: ResolvedStep[]; frame: string }>();
  const skipped: { id: string; reason: string; deliberate: boolean }[] = [];

  for (const [name, frame] of Object.entries(script.frames)) frames.set(name, compileFrame(converter, frame));

  for (const [id, entry] of Object.entries(script.scenarios)) {
    const contract = deps.contracts.get(id);

    if (!contract) {
      skipped.push({ id, reason: "no contract", deliberate: false });
      continue;
    }

    if (entry.skip === true) {
      skipped.push({ id, reason: "skip: true", deliberate: true });
      continue;
    }

    const outcome = compileEntry(converter, entry, contract.frame, frames);

    if (outcome.ok) scenarios.set(id, { resolved: outcome.resolved, frame: outcome.frame });
    else skipped.push({ id, reason: outcome.reason, deliberate: false });
  }

  for (const id of deps.contracts.keys()) {
    if (!Object.hasOwn(script.scenarios, id)) skipped.push({ id, reason: "no script", deliberate: true });
  }

  const compiledFrames = new Map<string, { open: ResolvedStep[]; close: ResolvedStep[] }>();

  for (const [name, result] of frames) {
    if (result.ok) compiledFrames.set(name, { open: result.open, close: result.close });
  }

  const pools = new Map<string, { group: string; base: string }>();

  for (const [name, pool] of Object.entries(script.pools)) pools.set(name, { group: pool.group, base: pool.base });

  return { scenarios, frames: compiledFrames, pools, skipped };
}

function compileFrame(converter: StepConverter, frame: FrameDefinition): FrameResult {
  try {
    return { ok: true, open: converter.convertAll(frame.open), close: converter.convertAll(frame.close) };
  } catch (err) {
    return { ok: false, reason: describe(err) };
  }
}

function compileEntry(
  converter: StepConverter,
  entry: CalloutScriptEntry,
  defaultFrame: string,
  frames: ReadonlyMap<string, FrameResult>,
): { ok: true; resolved: ResolvedStep[]; frame: string } | { ok: false; reason: string } {
  // The schema requires `sequence` unless `skip` is exactly `true`; the type
  // still allows its absence, and a hand-built script may omit it.
  if (!entry.sequence) return { ok: false, reason: "no sequence" };

  const frame = entry.frame ?? defaultFrame;

  // `NO_FRAME` is the reserved word for unframed: never looked up, so a
  // script need not (and may not) define it.
  if (frame !== NO_FRAME) {
    const compiled = frames.get(frame);

    if (!compiled) return { ok: false, reason: `unknown frame "${frame}"` };

    if (!compiled.ok) return { ok: false, reason: `frame "${frame}": ${compiled.reason}` };
  }

  try {
    return { ok: true, resolved: converter.convertAll(entry.sequence), frame };
  } catch (err) {
    return { ok: false, reason: describe(err) };
  }
}

/** A `CompileProblem` reads as its reason; anything else (a DSL parse error) is an invalid step. */
function describe(err: unknown): string {
  if (err instanceof CompileProblem) return err.reason;

  return `invalid step: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Converts `ScriptStep`s to `ResolvedStep`s, checking every reference as it
 * goes. The string forms go through the DSL's own `parseStepShorthand`, so a
 * script and a closure sequence that spell the same thing resolve identically.
 */
class StepConverter {
  constructor(
    private readonly script: CalloutScript,
    private readonly deps: CompileDeps,
  ) {}

  convertAll(steps: readonly ScriptStep[]): ResolvedStep[] {
    return steps.map((step) => this.convert(step));
  }

  private convert(step: ScriptStep): ResolvedStep {
    if (typeof step === "string") return this.check(parseStepShorthand(step));

    if ("clip" in step) return { kind: "clip", path: step.clip };

    if ("var" in step) return this.check({ kind: "var", name: step.var });

    if ("pool" in step) return this.check({ kind: "pool", name: step.pool, noRepeat: step.noRepeat ?? true });

    if ("connector" in step) return this.check({ kind: "connector" });

    if ("pause" in step) return { kind: "pause", ms: step.pause };

    if ("include" in step) return this.check({ kind: "include", id: step.include });

    if ("ambient" in step) return { kind: "ambient", action: step.ambient };

    if ("optional" in step) return { kind: "optional", steps: this.convertAll(step.optional) };

    if ("if" in step) return this.convertIf(step.if, step.then, step.else);

    return this.convertCase(step.case, step.of);
  }

  /**
   * The shorthand parser and the object forms both produce leaf steps whose
   * references still need checking; this is the one place they are.
   */
  private check(step: ResolvedStep): ResolvedStep {
    switch (step.kind) {
      case "var":
        if (!this.deps.vars.has(step.name)) throw new CompileProblem(`unknown var "${step.name}"`);

        break;
      case "pool":
        this.checkPool(step.name);
        break;
      case "connector":
        this.checkPool(CONNECTOR_POOL);
        break;
      case "include":
        if (!this.deps.fragments.has(step.id)) throw new CompileProblem(`unknown include "${step.id}"`);

        break;
      default:
        break;
    }

    return step;
  }

  /**
   * A slashed name addresses the voice's own clip groups directly
   * (`group/base`) and needs no definition; a registered name must be
   * defined by the script or by the code registry. Registered names never
   * carry a slash, so the two cannot collide.
   */
  private checkPool(name: string): void {
    if (name.includes("/")) return;

    if (Object.hasOwn(this.script.pools, name) || this.deps.legacyPools.has(name)) return;

    throw new CompileProblem(`unknown pool "${name}"`);
  }

  private convertIf(ref: string, thenSteps: ScriptStep[], elseSteps: ScriptStep[] | undefined): ResolvedStep {
    const { name, negated } = parseCondReference(ref);
    const cond = this.deps.conds.get(name);

    if (!cond) throw new CompileProblem(`unknown condition "${name}"`);

    // Deliberately no try/catch here: a throwing condition propagates to the
    // interpreter's `if` arm, which logs it and reads the predicate as false
    // — negated or not. Catching it here would hide the throw from the log.
    const predicate = negated ? () => !cond() : () => cond();

    return {
      kind: "if",
      predicate,
      then: this.convertAll(thenSteps),
      else: elseSteps ? this.convertAll(elseSteps) : undefined,
    };
  }

  private convertCase(name: string, of: Record<string, ScriptStep[]>): ResolvedStep {
    const declared = this.deps.cases.get(name);

    if (!declared) throw new CompileProblem(`unknown case "${name}"`);

    const branches = new Map<string, ResolvedStep[]>();
    let fallback: ResolvedStep[] = [];

    for (const [key, steps] of Object.entries(of)) {
      if (key === CASE_DEFAULT_BRANCH) {
        fallback = this.convertAll(steps);
        continue;
      }

      if (!declared.keys.has(key)) throw new CompileProblem(`case "${name}": unknown key "${key}"`);

      branches.set(key, this.convertAll(steps));
    }

    return { kind: "case", name, of: branches, fallback };
  }
}
