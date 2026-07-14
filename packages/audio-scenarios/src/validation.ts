/**
 * Load-time validation for scenarios.
 *
 * Runs on `defineScenario` against the already-loaded scenarios, pools,
 * variables, and audio-asset manifest. Returns human-readable `errors`
 * (non-empty disables the scenario) and `warnings` (logged, scenario stays
 * enabled — e.g. a probable typo in a `{voice}`-templated path).
 *
 * Include-cycle detection is performed here (at load time) *in addition* to
 * the runtime guard in the interpreter's expansion code, so broken graphs
 * surface as soon as they're registered rather than only when fired.
 */
import type { ResolvedStep, Scenario } from "./dsl.js";
import { applyBase } from "./dsl.js";
import { type AudioAssetsManifest, referenceVoice } from "./manifest.js";

type CompiledEntry = { raw: Scenario; resolvedSequence: ResolvedStep[] };

export type ScenarioValidationResult = { errors: string[]; warnings: string[] };

export function validateScenario(
  s: Scenario,
  resolved: ResolvedStep[],
  scenarios: Map<string, CompiledEntry>,
  pools: Map<string, unknown>,
  vars: Map<string, () => string | null>,
  manifest: AudioAssetsManifest,
): ScenarioValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const clipSet = new Set(manifest.clips);
  const reference = referenceVoice(manifest);

  // Scheduling metadata (issue #652): `weight` must be a finite number when
  // present so a typo (e.g. an undefined `WEIGHT.x`) surfaces at load rather
  // than silently coercing to NaN in the scheduler's comparisons.
  if (s.weight !== undefined && !Number.isFinite(s.weight)) {
    errors.push(`weight must be a finite number (got ${String(s.weight)})`);
  }

  // Resume semantics (issue #758): only an interrupt-cut QUEUEABLE fire is
  // ever stashed for idle-replay, so `resumable` without `queueable` would be
  // a silent no-op — surface the mismatch at load time.
  if (s.resumable === true && s.queueable !== true) {
    errors.push("resumable requires queueable: true (only a queueable fire is stashed for idle-replay)");
  }

  if (s.pendingHoldMs !== undefined && (!Number.isFinite(s.pendingHoldMs) || s.pendingHoldMs < 0)) {
    errors.push(`pendingHoldMs must be a non-negative number (got ${String(s.pendingHoldMs)})`);
  }

  walk(resolved, s.base, new Set([s.id]));

  return { errors, warnings };

  function walk(steps: ResolvedStep[], base: string | undefined, visited: Set<string>): void {
    for (const step of steps) {
      switch (step.kind) {
        case "clip": {
          const abs = applyBase(base, step.path);

          if (abs.includes("{voice}")) {
            // Templated — checked against the REFERENCE voice only (issue
            // #664): per-voice clip sets may legitimately diverge, so a gap
            // in another voice is not an error. A miss for the reference
            // voice is a probable typo and only warns — the scenario stays
            // enabled and the step skips at fire time.
            if (reference !== null) {
              const resolved = abs.replace(/\{voice\}/g, reference);

              if (!clipSet.has(resolved)) {
                warnings.push(`unknown clip for reference voice: ${resolved} (template: ${abs})`);
              }
            }
          } else if (!clipSet.has(abs)) {
            errors.push(`unknown clip: ${abs}`);
          }

          break;
        }

        case "var":
          if (!vars.has(step.name)) errors.push(`unregistered variable: {{${step.name}}}`);

          break;

        case "pool": {
          const pool = pools.get(step.name);

          if (!pool) errors.push(`unknown pool: ${step.name}`);

          break;
        }

        case "connector": {
          const pool = pools.get("connector");

          if (!pool) errors.push(`connector pool not defined (expected pool named "connector")`);

          break;
        }

        case "include": {
          if (visited.has(step.id)) {
            errors.push(`include cycle detected: ${[...visited].join(" → ")} → ${step.id}`);
            break;
          }

          const target = scenarios.get(step.id);

          if (!target) {
            errors.push(`include target not found: ${step.id}`);
            break;
          }

          walk(target.resolvedSequence, target.raw.base, new Set([...visited, step.id]));
          break;
        }

        case "if":
          walk(step.then, base, visited);

          if (step.else) walk(step.else, base, visited);

          break;

        case "optional":
          walk(step.steps, base, visited);

          break;

        case "ambient":
        case "pause":
          break;
      }
    }
  }
}
