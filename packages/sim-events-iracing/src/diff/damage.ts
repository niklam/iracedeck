/**
 * Damage diff (issue #489; the hold behind an incident, #1211).
 *
 * Emits `damage.repairNeeded.raised` on the rising edge of
 * `EngineWarnings & (MandRepNeeded | OptRepNeeded)`, after a debounce window
 * that filters `EngineWarnings` flicker. The baseline is the last *settled*
 * state — once damage has settled, we hold that baseline until the bits
 * clear, so sustained damage doesn't re-fire. A clear → damaged cycle
 * re-fires because the baseline drops back to `false` on the falling edge
 * without emitting.
 *
 * **The settled edge is held behind an incident burst (#1211).** When a crash
 * produces both, the incident line plays first and the damage line after it
 * (Niklas, 2026-09-24). The damage edge can settle BEFORE the crash's
 * incident is even reported — the debounce runs from the repair bit rising,
 * while `diffIncidents` waits for the count increment and then its quiet
 * window (a logged crash: damage settled 0.9 s before the count moved and
 * 2.4 s before the flush). So a settle records the emit as held
 * (`damageHeldAt`), and it goes out on the first tick where no incident burst
 * is open AND either `DAMAGE_INCIDENT_GRACE_MS` has passed since the settle
 * or a burst that was open at the settle, or opened since, has flushed
 * (`damageHeldSawBurst`). `diffIncidents` runs before this diff in the
 * translator tick, so on a flush tick the emits read `incident.scored`,
 * `incident.occurred`, `damage.repairNeeded.raised` — one tick, no timer. The
 * hold is bounded by the grace plus the burst's own cap, about 5 s.
 *
 * A held emit is released only on a tick where the repair bit reads set, so
 * a one-tick flicker defers it rather than announcing damage the car does
 * not have that instant. A bit that stays down cancels it: when the falling
 * edge settles, nothing is emitted and the baseline drops as it always has.
 * The audio layer adds its own speak-time check (#1288), on the settled state
 * this diff keeps (`isDamageRepairNeeded()` over `damageBaseline`) rather than
 * on the raw bits; this hold only decides the order of the two events.
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

/**
 * How long a settled damage edge waits for the crash's incident burst to
 * open when none is open at the settle (#1211). One observation set it: a
 * crash whose count moved 0.9 s after the damage settled, hence 2 s rather
 * than 1 s. A crash whose count moves later than this gets the damage line
 * first. What would set it properly is the offset from the damage settle to
 * the first count increment of the same crash, across damaging crashes in
 * telemetry captures.
 *
 * @internal Exported for testing.
 */
export const DAMAGE_INCIDENT_GRACE_MS = 2000;

/**
 * The `EngineWarnings` bits that mean a repair is needed — mandatory or
 * optional. Either one raises the edge.
 */
export const DAMAGE_REPAIR_MASK = EngineWarnings.MandRepNeeded | EngineWarnings.OptRepNeeded;

export function diffDamage(state: TranslatorState, telemetry: TelemetryData, now: number, emit: EmitFn): void {
  const current = ((telemetry.EngineWarnings ?? 0) & DAMAGE_REPAIR_MASK) !== 0;

  // Seed silently on the first tick — the baseline equals the current state
  // so a player who connects mid-damage doesn't immediately get a callout
  // for damage that already existed when they joined.
  if (!state.damageInitialized) {
    state.damageInitialized = true;
    state.damageBaseline = current;
    state.damagePendingAt = 0;
    state.damagePendingValue = current;
    clearHeldDamage(state);

    return;
  }

  settleDamageEdge(state, current, now);
  releaseHeldDamage(state, current, now, emit);
}

/** Debounce the repair bits; a settled rising edge becomes held, a settled falling edge cancels it. */
function settleDamageEdge(state: TranslatorState, current: boolean, now: number): void {
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

  // Settled. Move the baseline; a rising edge is held behind any incident
  // burst, a falling edge drops whatever is still held.
  state.damageBaseline = current;
  state.damagePendingAt = 0;

  if (current) {
    state.damageHeldAt = now;
    state.damageHeldSawBurst = state.incidentBurstFirstAt > 0;
  } else {
    clearHeldDamage(state);
  }
}

/** Emit a held rising edge once no incident burst is open and the grace, or a burst's flush, has passed. */
function releaseHeldDamage(state: TranslatorState, current: boolean, now: number, emit: EmitFn): void {
  if (state.damageHeldAt === 0) return;

  if (state.incidentBurstFirstAt > 0) {
    // A burst is open: this crash's incident is being counted. Wait for its
    // flush, which `diffIncidents` emits earlier on the same tick.
    state.damageHeldSawBurst = true;

    return;
  }

  if (!current) return;

  if (!state.damageHeldSawBurst && now - state.damageHeldAt < DAMAGE_INCIDENT_GRACE_MS) return;

  clearHeldDamage(state);
  emit({ event: "damage.repairNeeded.raised", data: {} });
}

function clearHeldDamage(state: TranslatorState): void {
  state.damageHeldAt = 0;
  state.damageHeldSawBurst = false;
}
