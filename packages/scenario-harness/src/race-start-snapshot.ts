/**
 * Harness-side store for the race-start readout snapshot (issue #568).
 *
 * Mirrors `session-start-snapshot.ts`. The race-start snapshot carries a
 * `driverName` that is not telemetry-derived (the production plugins compose
 * it from the Property Inspector name picker) and a `playerCarPosition` that
 * the production translator reads from `QualifyResultsInfo` — neither is
 * something the harness can drive purely through a published bus event. So
 * the harness holds the fully-composed snapshot directly: a shortcut (or the
 * UI) pushes it via `/api/race-start/snapshot`, `main.ts` wires
 * `getHarnessRaceStartSnapshot` into `registerPitCrew` as the resolver, and
 * the scenario reads it at fire time. Pre-baked per-position shortcuts in
 * `scenario-shortcuts.ts` carry the snapshot inline so QA can deterministically
 * exercise each position clause (pole / composed / out-of-range skip /
 * missing skip) with a single click.
 *
 * Conversion/rounding and the QualifyResultsInfo lookup live in
 * `getRaceStartConditions()` and are covered by its own unit test in
 * `@iracedeck/sim-events-iracing`.
 */
import type { RaceStartSnapshot } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";

let current: RaceStartSnapshot | null = null;

/** The snapshot the race-start scenario reads at fire time, or null. */
export function getHarnessRaceStartSnapshot(): RaceStartSnapshot | null {
  return current;
}

/** Replace the harness race-start snapshot (called by the snapshot endpoint). */
export function setHarnessRaceStartSnapshot(snapshot: RaceStartSnapshot | null): void {
  current = snapshot;
}

const TEMP_UNITS: readonly RaceStartSnapshot["tempUnit"][] = ["celsius", "fahrenheit"];

/**
 * Shape-check an incoming `/api/race-start/snapshot` body. Returns the
 * snapshot on success or a user-facing error string on the first failed field
 * — same lightweight validation style as the session-start snapshot.
 *
 * `playerCarPosition` is optional: omit it (or send `null`) to exercise the
 * missing-position branch; otherwise it must be a positive integer.
 */
export function validateRaceStartSnapshot(body: unknown): RaceStartSnapshot | string {
  if (typeof body !== "object" || body === null) return "body must be an object";

  const b = body as Record<string, unknown>;

  if (typeof b.driverName !== "string" || b.driverName.length === 0) {
    return "driverName must be a non-empty string";
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

  if (b.playerCarPosition !== undefined && b.playerCarPosition !== null) {
    if (typeof b.playerCarPosition !== "number" || !Number.isInteger(b.playerCarPosition) || b.playerCarPosition <= 0) {
      return "playerCarPosition must be a positive integer, null, or omitted";
    }
  }

  return {
    driverName: b.driverName,
    trackTemp: b.trackTemp,
    airTemp: b.airTemp,
    tempUnit: b.tempUnit as RaceStartSnapshot["tempUnit"],
    wetness: b.wetness as TrackWetness,
    playerCarPosition: typeof b.playerCarPosition === "number" ? b.playerCarPosition : undefined,
  };
}
