/**
 * The registered contracts (issue #1514): every `defineContract` /
 * `defineScenario` entry by id, in registration order, and what is read off
 * that map alone — the `queueBehind` relation and its two warnings, the
 * `ContractReport` enumeration, and validation against the other registries
 * handed in per call.
 *
 * A leaf: it subscribes nothing, compiles nothing and marks nothing dirty.
 * The registration SEQUENCE — the replacement warning, the detach, `store`,
 * the dirty mark, the two warnings, `validate`, the subscriptions — is the
 * facade's, because its steps reach the triggers, the script set and the
 * line ends in a fixed order. The per-contract runtime fields on
 * `CompiledScenario` (`enabled`, `lastFireAt`, `unsubscribe`,
 * `pendingTriggerTimer`) each have one writer elsewhere; this module only
 * creates the entry they live on.
 */
import type { ILogger } from "@iracedeck/logger";

import type { ResolvedStep, ScenarioContract, VocabularyResolver } from "./dsl.js";
import { DEFAULT_FRAME, DEFAULT_WEIGHT } from "./dsl.js";
import { codePointOrder, type CompiledScenario } from "./engine-types.js";
import type { ContractReport } from "./interpreter.js";
import type { AudioAssetsManifest } from "./manifest.js";
import { type ScenarioValidationResult, validateScenario } from "./validation.js";

/**
 * What `validate` reads beside the contracts, as it stands at the call:
 * read-only views, never captured, since a registration can land before or
 * after the pools and vars it names.
 */
export type ValidationViews = {
  pools: ReadonlyMap<string, unknown>;
  vars: ReadonlyMap<string, VocabularyResolver<string | null>>;
  manifest: AudioAssetsManifest;
};

export class ContractRegistry {
  private readonly scenarios = new Map<string, CompiledScenario>();

  constructor(private readonly logger: ILogger) {}

  /** Every registered entry by id, in registration order. */
  get entries(): ReadonlyMap<string, CompiledScenario> {
    return this.scenarios;
  }

  get(id: string): CompiledScenario | undefined {
    return this.scenarios.get(id);
  }

  /**
   * Create the entry for a contract — a legacy scenario brings its resolved
   * sequence, a contract brings `null` and is scripted per voice at fire
   * time — and record it under its id, replacing any previous definition.
   * The caller has already detached the previous entry.
   */
  store(s: ScenarioContract, resolvedSequence: ResolvedStep[] | null): CompiledScenario {
    const entry: CompiledScenario = {
      raw: s,
      resolvedSequence,
      frame: s.frame ?? DEFAULT_FRAME,
      enabled: true,
      unsubscribe: null,
      lastFireAt: 0,
      pendingTriggerTimer: null,
    };

    this.scenarios.set(s.id, entry);

    return entry;
  }

  /**
   * A `queueBehind` relation is per bus — the queue it concerns is the
   * bus's — so an id on another bus can never match, and nothing would
   * ever say so (issue #1108). Warned once, at whichever registration makes
   * the mismatch visible: this contract naming an already-registered id on
   * another bus, or an already-registered contract naming this one. Never
   * an error: the relation is inert, the contracts themselves are fine.
   */
  warnCrossBusQueueBehind(entry: CompiledScenario): void {
    const s = entry.raw;

    for (const id of s.queueBehind ?? []) {
      const named = this.scenarios.get(id);

      if (named !== undefined && named !== entry && named.raw.bus !== s.bus) {
        this.logger.warn(
          `Scenario "${s.id}" queueBehind names "${id}" on bus ${named.raw.bus}, not its own bus ${s.bus} — the relation never matches`,
        );
      }
    }

    for (const other of this.scenarios.values()) {
      if (other === entry || other.raw.bus === s.bus || !other.raw.queueBehind?.includes(s.id)) continue;

      this.logger.warn(
        `Scenario "${other.raw.id}" queueBehind names "${s.id}" on bus ${s.bus}, not its own bus ${other.raw.bus} — the relation never matches`,
      );
    }
  }

  /**
   * Two contracts that each wait behind the other would both sit in the
   * queue, each held by the other, until they expire (issue #1185): the
   * queue never links them into a loop, but the drain serves neither while
   * the other waits. Warned once, at the registration that closes the
   * cycle: the walk follows `queueBehind` from this contract through the
   * registered contracts on its own bus (a cross-bus relation never
   * matches) and warns when it comes back here. Never an error: each
   * relation is valid on its own.
   */
  warnQueueBehindCycle(entry: CompiledScenario): void {
    const s = entry.raw;
    const seen = new Set<string>();
    const walk = (id: string, path: readonly string[]): readonly string[] | null => {
      if (id === s.id) return path;

      if (seen.has(id)) return null;

      seen.add(id);
      const named = this.scenarios.get(id);

      if (named === undefined || named.raw.bus !== s.bus) return null;

      for (const next of named.raw.queueBehind ?? []) {
        const found = walk(next, [...path, next]);

        if (found !== null) return found;
      }

      return null;
    };

    for (const id of s.queueBehind ?? []) {
      // Naming itself is validation's error, not a cycle.
      if (id === s.id) continue;

      const cycle = walk(id, [s.id, id]);

      if (cycle !== null) {
        this.logger.warn(
          `Scenario "${s.id}" queueBehind forms a cycle (${cycle.map((c) => `"${c}"`).join(" → ")}) — those fires wait for each other until they expire`,
        );

        return;
      }
    }
  }

  /**
   * Validate an entry against the registered contracts and the views handed
   * in (`validation.ts`). Reports only: logging the result and disabling the
   * entry on errors is the caller's, in the registration sequence.
   */
  validate(entry: CompiledScenario, views: ValidationViews): ScenarioValidationResult {
    return validateScenario(entry.raw, entry.resolvedSequence, this.scenarios, views.pools, views.vars, views.manifest);
  }

  contracts(): readonly ContractReport[] {
    // Read off the same map the scheduler fires from, defaults filled in the
    // way `attemptFire` fills them, so the report can never disagree with the
    // engine about a contract's frame or weight. A disabled entry (a
    // validation error, or `setEnabled(false)`) is still a registered
    // contract and is listed: enablement is runtime state, not catalog shape.
    return [...this.scenarios.values()]
      .map(({ raw, frame }) => ({
        id: raw.id,
        event: raw.when?.event ?? null,
        description: raw.description ?? "",
        frame,
        family: raw.family ?? null,
        weight: raw.weight ?? DEFAULT_WEIGHT,
        queueable: raw.queueable ?? false,
        interrupt: raw.interrupt ?? false,
        speakGate: raw.speakGate?.description ?? null,
        endsOn: raw.endsOn?.description ?? null,
        endsOnEvent: raw.endsOn?.event ?? null,
        base: raw.base ?? null,
      }))
      .sort((a, b) => codePointOrder(a.id, b.id));
  }

  /** Whether the contract `followerId` declares that it waits behind `leaderId` (issue #1108). */
  waitsBehind(followerId: string, leaderId: string): boolean {
    return this.scenarios.get(followerId)?.raw.queueBehind?.includes(leaderId) ?? false;
  }
}
