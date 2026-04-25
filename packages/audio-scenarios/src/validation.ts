/**
 * Load-time validation for scenarios.
 *
 * Runs on `defineScenario` against the already-loaded scenarios, pools,
 * variables, and audio-asset manifest. Returns a list of human-readable
 * errors — empty means the scenario is ready to play.
 *
 * Include-cycle detection is performed here (at load time) *in addition* to
 * the runtime guard in the interpreter's expansion code, so broken graphs
 * surface as soon as they're registered rather than only when fired.
 */
import type { ResolvedStep, Scenario } from "./dsl.js";
import { applyBase } from "./dsl.js";
import type { AudioAssetsManifest } from "./interpreter.js";

type CompiledEntry = { raw: Scenario; resolvedSequence: ResolvedStep[] };

export function validateScenario(
  s: Scenario,
  resolved: ResolvedStep[],
  scenarios: Map<string, CompiledEntry>,
  pools: Map<string, { clips: string[] }>,
  vars: Map<string, () => string | null>,
  manifest: AudioAssetsManifest,
): string[] {
  const errors: string[] = [];
  const clipSet = new Set(manifest.clips);

  walk(resolved, s.base, new Set([s.id]));

  return errors;

  function walk(steps: ResolvedStep[], base: string | undefined, visited: Set<string>): void {
    for (const step of steps) {
      switch (step.kind) {
        case "clip": {
          const abs = applyBase(base, step.path);

          if (!clipSet.has(abs)) errors.push(`unknown clip: ${abs}`);

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

        case "ambient":
        case "pause":
          break;
      }
    }
  }
}
