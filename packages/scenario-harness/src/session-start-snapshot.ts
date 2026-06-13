/**
 * Harness-side store for the session-start brief snapshot (issue #542).
 *
 * Unlike the pit-readback composer — which round-trips through telemetry so
 * the production `getReadbackSnapshot()` translator runs — the session-start
 * snapshot carries a `driverName` that is *not* telemetry-derived (the
 * production plugins compose it from the Property Inspector name picker). So
 * the harness holds the fully-composed snapshot directly: the UI pushes it
 * here via `/api/session-start/snapshot`, `main.ts` wires
 * `getHarnessSessionStartSnapshot` into `registerPitCrew` as the resolver,
 * and the scenario reads it at fire time. Conversion/rounding logic in
 * `getSessionStartConditions()` is covered by its own unit test in
 * `@iracedeck/sim-events-iracing`.
 */
import type { SessionStartSnapshot } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";

let current: SessionStartSnapshot | null = null;

/** The snapshot the session-start scenario reads at fire time, or null. */
export function getHarnessSessionStartSnapshot(): SessionStartSnapshot | null {
  return current;
}

/** Replace the harness session-start snapshot (called by the snapshot endpoint). */
export function setHarnessSessionStartSnapshot(snapshot: SessionStartSnapshot | null): void {
  current = snapshot;
}

const SESSION_TYPES: readonly SessionStartSnapshot["sessionType"][] = ["practice", "qualifying", "race"];
const SPEED_UNITS: readonly SessionStartSnapshot["speedUnit"][] = ["kmh", "mph"];
const TEMP_UNITS: readonly SessionStartSnapshot["tempUnit"][] = ["celsius", "fahrenheit"];

/**
 * Shape-check an incoming `/api/session-start/snapshot` body. Returns the
 * snapshot on success or a user-facing error string on the first failed
 * field — the same lightweight validation style the harness server uses for
 * the pit-readback snapshot.
 */
export function validateSessionStartSnapshot(body: unknown): SessionStartSnapshot | string {
  if (typeof body !== "object" || body === null) return "body must be an object";

  const b = body as Record<string, unknown>;

  if (typeof b.driverName !== "string" || b.driverName.length === 0) {
    return "driverName must be a non-empty string";
  }

  if (typeof b.sessionType !== "string" || !SESSION_TYPES.includes(b.sessionType as never)) {
    return `sessionType must be one of: ${SESSION_TYPES.join(", ")}`;
  }

  if (typeof b.pitSpeedLimit !== "number" || !Number.isFinite(b.pitSpeedLimit)) {
    return "pitSpeedLimit must be a finite number";
  }

  if (typeof b.speedUnit !== "string" || !SPEED_UNITS.includes(b.speedUnit as never)) {
    return `speedUnit must be one of: ${SPEED_UNITS.join(", ")}`;
  }

  if (typeof b.trackTemp !== "number" || !Number.isFinite(b.trackTemp)) {
    return "trackTemp must be a finite number";
  }

  if (typeof b.airTemp !== "number" || !Number.isFinite(b.airTemp)) {
    return "airTemp must be a finite number";
  }

  if (typeof b.tempUnit !== "string" || !TEMP_UNITS.includes(b.tempUnit as never)) {
    return `tempUnit must be one of: ${TEMP_UNITS.join(", ")}`;
  }

  if (
    typeof b.wetness !== "number" ||
    b.wetness < TrackWetness.Dry ||
    b.wetness > TrackWetness.ExtremelyWet ||
    !Number.isInteger(b.wetness)
  ) {
    return `wetness must be a TrackWetness value (${TrackWetness.Dry}–${TrackWetness.ExtremelyWet})`;
  }

  return body as SessionStartSnapshot;
}
