/**
 * The voice scripts and their compiled form (issue #1514): the map
 * `setScripts` handed in, the per-voice `CompiledVoiceScript`s compiled
 * against the registries as they stood at the last compile, the dirty flag a
 * registration sets, and the expansion `generation` a stashed resume is
 * checked against (issue #1136).
 *
 * It reads the contract registry, the vocabulary and the pool store's
 * registered names through the deps it is built with, at each compile, and
 * writes into one of them: `clearScriptPools()`, because a compile redefines
 * what a script pool holds and the compile is lazy, so the facade cannot
 * sequence it. The once-per warnings it says are reset by the facade before
 * `setScripts` hands a new map in.
 */
import type { CalloutScript } from "@iracedeck/callout-script";
import type { ILogger } from "@iracedeck/logger";

import type { VocabularyResolver } from "./dsl.js";
import type { CompiledScenario } from "./engine-types.js";
import type { OnceWarnings } from "./once-warnings.js";
import { type CompileDeps, type CompiledVoiceScript, compileVoiceScript } from "./script-compiler.js";
import type { CaseEntry, CondEntry } from "./vocabulary.js";

/** What a compile reads, as read-only views of the modules that own it. */
export type ScriptSetDeps = {
  /** The registered contracts: the ids with no welded sequence are the contracts a script may name. */
  contracts: { readonly entries: ReadonlyMap<string, CompiledScenario> };
  /** The var, condition and case registries. */
  vocabulary: {
    readonly vars: ReadonlyMap<string, VocabularyResolver<string | null>>;
    readonly conds: ReadonlyMap<string, CondEntry>;
    readonly cases: ReadonlyMap<string, CaseEntry>;
  };
  /** The pool store's two callbacks: the names for `compileDeps`, and the one cross-module write a compile makes. */
  pools: { registeredPoolNames(): Set<string>; clearScriptPools(): void };
};

export class ScriptSet {
  /** Voice id → parsed script, as last handed in by `setScripts` (issue #1064). */
  private scripts: ReadonlyMap<string, CalloutScript> = new Map();
  /** Voice id → the script compiled against the registries as they stood at the last compile. */
  private compiledScripts: ReadonlyMap<string, CompiledVoiceScript> = new Map();
  /**
   * Set by every registration that feeds the compile (contracts, vars,
   * conditions, cases, pools); the next expansion recompiles first
   * (`ensureCompiled`), before it looks anything up.
   */
  private scriptsDirty = false;
  /**
   * Bumped whenever anything an expansion is a function of changes — the
   * manifest, the scripts, or any registration that feeds the compile. A
   * stashed resume records the generation it was expanded under, and a
   * resume across a bump replays whole (issue #1136): the ops it would
   * continue into are compared by POOL now, and a pool key is stable across
   * a redefinition that changed what the pool holds, so the comparison alone
   * can no longer see that kind of change. Before #1136 a path mismatch
   * happened to force the same coherent full replay.
   */
  private expansionGeneration = 0;

  constructor(
    private readonly logger: ILogger,
    private readonly warnings: OnceWarnings,
    private readonly getActiveVoice: () => string | null,
    private readonly deps: ScriptSetDeps,
  ) {}

  /** `true` when a registration landed after the last compile (see `scriptsDirty`). */
  get dirty(): boolean {
    return this.scriptsDirty;
  }

  /** The expansion generation a stash is stamped with and a resume compares (issue #1136). */
  get generation(): number {
    return this.expansionGeneration;
  }

  /** The compiled script of `voice` as it stands — no compile, so a read never logs. */
  compiled(voice: string): CompiledVoiceScript | undefined {
    return this.compiledScripts.get(voice);
  }

  /**
   * A registration that feeds the compile: the next expansion recompiles,
   * and every stashed resume is invalidated (issue #1136 — see `generation`).
   * The two go together, so they are set together rather than at six call
   * sites that must each remember the second half.
   */
  markDirty(): void {
    this.scriptsDirty = true;
    this.expansionGeneration++;
  }

  /**
   * Invalidate every stashed resume without a recompile: what a pool holds
   * changed under the scripts (a manifest reload), not what they say.
   */
  invalidate(): void {
    this.expansionGeneration++;
  }

  setScripts(scripts: ReadonlyMap<string, CalloutScript>): void {
    this.scripts = new Map(scripts);
    // A new script map redefines bodies, frames and what a pool name holds;
    // a resume stashed under the old one replays whole (issue #1136).
    this.expansionGeneration++;
    this.compileScripts();
  }

  /** See `IScenarioEngine.isScripted`. */
  isScripted(scenarioId: string): boolean {
    this.ensureCompiled();

    const voice = this.getActiveVoice();

    return voice !== null && (this.compiledScripts.get(voice)?.scenarios.has(scenarioId) ?? false);
  }

  /** See `IScenarioEngine.compileScript`: one script, the same deps, the diagnostics returned. */
  compileScript(script: CalloutScript): CompiledVoiceScript {
    return compileVoiceScript(script, this.compileDeps());
  }

  /**
   * Recompile when a registration landed after the last compile. Called at
   * the top of `Expansion.prepare` (and of `playFramePreview`), so a
   * contract defined after `setScripts` (or a script loaded before the
   * catalog registered) is compiled before its first fire ever looks it up.
   */
  ensureCompiled(): void {
    if (!this.scriptsDirty) return;

    if (this.scripts.size === 0) {
      this.scriptsDirty = false;

      return;
    }

    this.compileScripts();
    this.logger.debug("Voice scripts recompiled");
  }

  /**
   * What the compiler needs, read off the registries as they stand now — the
   * ONE place the engine's state is turned into `CompileDeps`, so the eager
   * per-voice compile and the linter's `compileScript` cannot diverge on
   * which ids are contracts (a legacy scenario is not: its body is welded on)
   * or which pool names are code-registered.
   */
  private compileDeps(): CompileDeps {
    const contracts = new Map<string, { frame: string; base?: string }>();

    // The base travels with the frame because it is the base the body will be
    // expanded under, and the compiler qualifies a literal voice path only
    // where none will be put in front of it (#1144).
    for (const [id, entry] of this.deps.contracts.entries) {
      if (entry.resolvedSequence === null) contracts.set(id, { frame: entry.frame, base: entry.raw.base });
    }

    const conds = new Map<string, VocabularyResolver<boolean>>();

    for (const [name, { predicate }] of this.deps.vocabulary.conds) conds.set(name, predicate);

    const cases = new Map<string, { resolve: VocabularyResolver<string | null>; keys: ReadonlySet<string> }>();

    for (const [name, { resolve, keys }] of this.deps.vocabulary.cases) {
      cases.set(name, { resolve, keys: new Set(Object.keys(keys)) });
    }

    return {
      contracts,
      vars: new Set(this.deps.vocabulary.vars.keys()),
      conds,
      cases,
      legacyPools: this.deps.pools.registeredPoolNames(),
    };
  }

  /**
   * Compile every voice's script against the registries as they stand now.
   * Per voice: one debug line with the scripted count, the deliberate skips
   * at debug, and ONE warn per (voice, scenario) for a skip the pack did not
   * mean — deduped across recompiles, so a dirty recompile only reports what
   * changed. The compiler never throws; neither does this.
   */
  private compileScripts(): void {
    this.scriptsDirty = false;
    this.deps.pools.clearScriptPools();

    const deps = this.compileDeps();
    const compiled = new Map<string, CompiledVoiceScript>();

    for (const [voice, script] of this.scripts) {
      // The voice id goes in so a composite voice's literal voice paths are
      // qualified with its pack (#1144) — the one way this compile differs
      // from `compileScript`'s, and never in a diagnostic.
      const result = compileVoiceScript(script, deps, voice);
      compiled.set(voice, result);

      this.logger.debug(`Voice "${voice}": ${result.scenarios.size} of ${deps.contracts.size} callouts scripted`);

      const deliberate = result.skipped.filter((skip) => skip.deliberate).map((skip) => skip.id);

      if (deliberate.length > 0) this.logger.debug(`Voice "${voice}": not scripted — ${deliberate.join(", ")}`);

      for (const skip of result.skipped) {
        if (skip.deliberate) continue;

        const key = `${voice}|${skip.id}|${skip.reason}`;

        if (!this.warnings.once("skips", key)) continue;

        this.logger.warn(`Voice "${voice}": scenario "${skip.id}" skipped — ${skip.reason}`);
      }

      for (const [name, reason] of result.fragmentProblems) {
        const key = `${voice}|${name}|${reason}`;

        if (!this.warnings.once("fragments", key)) continue;

        this.logger.warn(`Voice "${voice}": fragment "${name}" — ${reason}`);
      }

      // A cut tail that did not compile leaves its frame whole (issue #1407):
      // the voice still speaks every callout, and an ended line closes the
      // radio with the close. Warned once per (voice, frame) under the key
      // the runtime tail warn uses (`expandCutTail`), so the two never both
      // speak for one frame.
      for (const [name, reason] of result.failedCuts) {
        const key = `${voice}|${name}|cut`;

        if (!this.warnings.once("frameAborts", key)) continue;

        this.logger.warn(
          `Voice "${voice}" frame "${name}" cut tail cannot play — ${reason}; an ended line closes the radio instead`,
        );
      }
    }

    this.compiledScripts = compiled;
  }
}
