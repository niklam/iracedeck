/**
 * The vocabulary registries (issue #1514): the vars, conditions and cases a
 * script may name (`defineVar` / `defineCond` / `defineCase`, issue #1064),
 * the `vocabulary()` report the generated reference and `lint:pack` read
 * (#1066) — with the pools a var declared it draws (#1718) — and
 * `pickCaseBranch`, the one resolution that lives here because it is the
 * case registry's own lookup.
 *
 * Fixed once registered: it marks nothing dirty — the facade does, after
 * each `define…`, since a registration changes what the scripts compile
 * against — and it reads no pool, script or bus.
 */
import type { ILogger } from "@iracedeck/logger";

import type { ResolvedStep, ScenarioContext, VocabularyResolver } from "./dsl.js";
import { codePointOrder } from "./engine-types.js";
import type { DefineVarOptions, VarDraw, VocabularyReport } from "./interpreter.js";
import type { OnceWarnings } from "./once-warnings.js";

export type CondEntry = { predicate: VocabularyResolver<boolean>; description: string };
export type CaseEntry = {
  resolve: VocabularyResolver<string | null>;
  keys: Readonly<Record<string, string>>;
  description: string;
};

export class Vocabulary {
  private readonly varMap = new Map<string, VocabularyResolver<string | null>>();
  /** Parallel to `vars`: the description each var was registered with (`""` when none). */
  private readonly varDescriptions = new Map<string, string>();
  /** The pools a var declared it draws (#1718), copied at registration; absent for a var that declared none. */
  private readonly varDraws = new Map<string, readonly VarDraw[]>();
  private readonly condMap = new Map<string, CondEntry>();
  private readonly caseMap = new Map<string, CaseEntry>();

  constructor(
    private readonly logger: ILogger,
    private readonly warnings: OnceWarnings,
  ) {}

  get vars(): ReadonlyMap<string, VocabularyResolver<string | null>> {
    return this.varMap;
  }

  get conds(): ReadonlyMap<string, CondEntry> {
    return this.condMap;
  }

  get cases(): ReadonlyMap<string, CaseEntry> {
    return this.caseMap;
  }

  defineVar(
    name: string,
    resolver: VocabularyResolver<string | null>,
    description = "",
    options: DefineVarOptions = {},
  ): void {
    this.varMap.set(name, resolver);
    this.varDescriptions.set(name, description);

    // A re-registration replaces the declaration whole, so one without
    // `draws` drops what an earlier one declared.
    if (options.draws)
      this.varDraws.set(
        name,
        options.draws.map(({ group, base }) => ({ group, base })),
      );
    else this.varDraws.delete(name);
  }

  defineCond(name: string, predicate: VocabularyResolver<boolean>, description: string): void {
    this.condMap.set(name, { predicate, description });
  }

  defineCase(
    name: string,
    resolver: VocabularyResolver<string | null>,
    keys: Readonly<Record<string, string>>,
    description: string,
  ): void {
    this.caseMap.set(name, { resolve: resolver, keys: { ...keys }, description });
  }

  vocabulary(): VocabularyReport {
    const byName = <T extends { name: string }>(items: T[]): T[] =>
      items.sort((a, b) => codePointOrder(a.name, b.name));

    return {
      vars: byName(
        [...this.varMap.keys()].map((name) => {
          const description = this.varDescriptions.get(name) ?? "";
          const draws = this.varDraws.get(name);

          // The key is left out, not set to `undefined`, for a var that
          // declared no draws: the report is serialised into the generated
          // reference, which must not change for it.
          return draws
            ? { name, description, draws: draws.map(({ group, base }) => ({ group, base })) }
            : { name, description };
        }),
      ),
      conds: byName([...this.condMap].map(([name, { description }]) => ({ name, description }))),
      cases: byName(
        [...this.caseMap].map(([name, { description, keys }]) => ({ name, description, keys: { ...keys } })),
      ),
    };
  }

  pickCaseBranch(step: Extract<ResolvedStep, { kind: "case" }>, ctx: ScenarioContext): ResolvedStep[] {
    const declared = this.caseMap.get(step.name);

    if (!declared) {
      // The compiler refuses a script naming an unregistered case, so this is
      // reachable only if the case was registered and later replaced.
      this.logger.error(`case "${step.name}" is not registered — taking the default branch`);

      return step.fallback;
    }

    let key: string | null = null;

    try {
      key = declared.resolve(ctx);
    } catch (err) {
      this.logger.error(`case "${step.name}" resolver threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (key === null) return step.fallback;

    if (!Object.hasOwn(declared.keys, key)) {
      const warnKey = `${step.name}|${key}`;

      if (this.warnings.once("caseKeys", warnKey)) {
        this.logger.warn(`case "${step.name}" resolved to undeclared key "${key}" — taking the default branch`);
      }

      return step.fallback;
    }

    return step.of.get(key) ?? step.fallback;
  }
}
