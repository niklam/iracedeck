/**
 * Damage diff (issue #489).
 *
 * Emits `damage.repairNeeded.raised` on the rising edge of
 * `EngineWarnings & (MandRepNeeded | OptRepNeeded)`, after a debounce window
 * that filters `EngineWarnings` flicker. The baseline is the last *emitted*
 * state — once damage has been announced, we hold that baseline until the
 * bits clear, so sustained damage doesn't re-fire. A clear → damaged cycle
 * re-fires because the baseline drops back to `false` on the falling edge
 * without emitting.
 *
 * No paired `cleared` event — audio scenarios only need the rising edge.
 */
import { EngineWarnings, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Debounce window for the damage rising edge. Long enough to ride out
 * `EngineWarnings` flicker (the bit can briefly toggle on collision-frame
 * rebounds and during pit-stall service) so a one-off blip doesn't surface
 * as a callout. Short enough that the engineer's heads-up still feels
 * timely on a real impact.
 *
 * @internal Exported for testing.
 */
export const DAMAGE_DEBOUNCE_MS = 3000;

const DAMAGE_MASK = EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded;

export function diffDamage(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const current = ((telemetry.EngineWarnings ?? 0) & DAMAGE_MASK) !== 0;

  // Seed silently on the first tick — the baseline equals the current state
  // so a player who connects mid-damage doesn't immediately get a callout
  // for damage that already existed when they joined.
  if (!state.damageInitialized) {
    state.damageInitialized = true;
    state.damageBaseline = current;
    state.damagePendingAt = 0;
    state.damagePendingValue = current;

    return;
  }

  if (current === state.damageBaseline) {
    state.damagePendingAt = 0;
    state.damagePendingValue = current;

    return;
  }

  // Started or re-anchored a pending flip. The flip resets when the value
  // oscillates within the debounce window so a noisy on/off/on burst doesn't
  // count from its first sample.
  if (state.damagePendingAt === 0 || current !== state.damagePendingValue) {
    state.damagePendingAt = now;
    state.damagePendingValue = current;
  }

  if (now - state.damagePendingAt < DAMAGE_DEBOUNCE_MS) return;

  // Settled. Move the baseline; emit only on the rising edge.
  state.damageBaseline = current;
  state.damagePendingAt = 0;

  if (current) {
    emit({ event: "damage.repairNeeded.raised", data: {} });
  }
}
