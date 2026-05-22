/**
 * Overtake callout gate — leaf module (no intra-catalog deps), issue #574
 * follow-up.
 *
 * A single "is this a clean racing moment worth commenting on" check applied
 * to the WHOLE overtake callout (reaction AND position readout, both gain and
 * loss). The engineer stays silent on a swap that happened because of, or
 * during:
 *
 *   - **a car alongside** — wheel-to-wheel, the position is unstable and the
 *     engineer talking is a distraction;
 *   - **being off-track** — you ran wide / spun off, not a clean race move;
 *   - **crawling** (below {@link OVERTAKE_MIN_SPEED_KMH}) — limping with damage
 *     or recovering, positions shuffle around you;
 *   - **pit road** — pit in/out swaps aren't racing passes;
 *   - **a recent incident** (within {@link OVERTAKE_RECENT_INCIDENT_MS}) — you
 *     just had a moment; the drop/gain is its consequence, not a clean fight.
 *
 * The gate is evaluated at event time (when the swap settled, ~3 s after it
 * started) — a sound proxy for "was this a clean racing move". The spoken
 * position is still read live at speak-time (see position-readout.ts).
 *
 * The plugin composes the {@link OvertakeGate} from `getOvertakeTelemetryGate()`
 * (`@iracedeck/sim-events-iracing`) plus an incident timestamp it tracks off
 * the bus. This module stays sim-agnostic — it only knows the shape + the
 * thresholds.
 */

/** Speed (km/h) below which an overtake callout is suppressed. */
export const OVERTAKE_MIN_SPEED_KMH = 50;

/**
 * If an incident occurred within this window (ms) before the overtake settled,
 * the swap is treated as a consequence of the incident and the callout is
 * suppressed. The loss/gain is detected ~3 s after it starts, so the window
 * comfortably covers "this drop was caused by that incident".
 */
export const OVERTAKE_RECENT_INCIDENT_MS = 10_000;

/**
 * Live gating context for an overtake callout. Telemetry fields come from
 * `getOvertakeTelemetryGate()`; `msSinceIncident` is the plugin's tracked time
 * since the last `incident.occurred` (`null` = no incident this session).
 */
export type OvertakeGate = {
  carsAlongside: boolean;
  onTrack: boolean;
  speedKmh: number;
  onPitRoad: boolean;
  msSinceIncident: number | null;
};

/** Resolver the plugin wires; `null` = telemetry unavailable (suppress). */
export type OvertakeGateResolver = () => OvertakeGate | null;

/**
 * Permissive default gate (everything clear) for callers that don't supply a
 * resolver — keeps tests and legacy callers firing. The real plugin gate
 * returns `null` only when telemetry is genuinely unavailable, which
 * {@link overtakeContextAllows} suppresses.
 */
export const PERMISSIVE_OVERTAKE_GATE: OvertakeGate = {
  carsAlongside: false,
  onTrack: true,
  speedKmh: Number.POSITIVE_INFINITY,
  onPitRoad: false,
  msSinceIncident: null,
};

/**
 * Whether the overtake callout is allowed to fire given the live context.
 * `null` (telemetry unavailable) suppresses — never announce a swap we can't
 * verify was a clean racing moment.
 */
export function overtakeContextAllows(gate: OvertakeGate | null): boolean {
  if (!gate) return false;

  if (gate.carsAlongside) return false;

  if (!gate.onTrack) return false;

  if (gate.speedKmh < OVERTAKE_MIN_SPEED_KMH) return false;

  if (gate.onPitRoad) return false;

  if (gate.msSinceIncident !== null && gate.msSinceIncident < OVERTAKE_RECENT_INCIDENT_MS) return false;

  return true;
}
