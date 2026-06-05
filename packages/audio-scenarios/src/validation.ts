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
import { type AudioAssetsManifest, manifestVoices } from "./manifest.js";

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
  const voices = manifestVoices(manifest);

  // Scheduling metadata (issue #652): `weight` must be a finite number when
  // present so a typo (e.g. an undefined `WEIGHT.x`) surfaces at load rather
  // than silently coercing to NaN in the scheduler's comparisons.
  if (s.weight !== undefined && !Number.isFinite(s.weight)) {
    errors.push(`weight must be a finite number (got ${String(s.weight)})`);
  }

  walk(resolved, s.base, new Set([s.id]));

  return errors;

  function walk(steps: ResolvedStep[], base: string | undefined, visited: Set<string>): void {
    for (const step of steps) {
      switch (step.kind) {
        case "clip": {
          const abs = applyBase(base, step.path);

          if (abs.includes("{voice}")) {
            // Templated — every voice in the manifest must have the resolved
            // clip; if even one is missing this scenario can't safely run
            // when the user picks that voice.
            for (const voice of voices) {
              const resolved = abs.replace(/\{voice\}/g, voice);

              if (!clipSet.has(resolved)) errors.push(`unknown clip: ${resolved} (template: ${abs})`);
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

        case "ambient":
        case "pause":
          break;
      }
    }
  }
}
