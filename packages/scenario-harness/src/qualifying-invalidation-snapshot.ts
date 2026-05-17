/**
 * Harness-side store for the qualifying lap-invalidation snapshot (issue #567).
 *
 * The scenario's snapshot fields (`sessionType`, `sessionNum`, `lapsRemaining`,
 * `lapLimited`, `lapCompleted`) aren't carried on `incident.occurred` itself
 * and aren't easily round-trippable through telemetry mutation (`SessionNum`
 * change wipes the lap-time baseline, fakery interferes with other scenarios).
 * Same approach as the session-start snapshot: the UI pushes a fully-composed
 * snapshot here via `/api/qualifying-invalidation/snapshot`, `main.ts` wires
 * `getHarnessQualifyingInvalidationSnapshot` into `registerPitCrew`, and the
 * scenario reads it at fire time.
 */
import type { QualifyingInvalidationSnapshot } from "@iracedeck/audio-scenarios/pit-crew";

let current: QualifyingInvalidationSnapshot | null = null;

/** The snapshot the qualifying-invalidation scenario reads at fire time, or null. */
export function getHarnessQualifyingInvalidationSnapshot(): QualifyingInvalidationSnapshot | null {
  return current;
}

/** Replace the harness qualifying-invalidation snapshot (called by the endpoint). */
export function setHarnessQualifyingInvalidationSnapshot(snapshot: QualifyingInvalidationSnapshot | null): void {
  current = snapshot;
}

const SESSION_TYPES = ["practice", "qualifying", "race"] as const;
type AcceptedSessionType = (typeof SESSION_TYPES)[number];

function isAcceptedSessionType(value: unknown): value is AcceptedSessionType {
  return typeof value === "string" && (SESSION_TYPES as readonly string[]).includes(value);
}

/**
 * Shape-check an incoming `/api/qualifying-invalidation/snapshot` body. Returns
 * the snapshot on success or a user-facing error string on the first failed
 * field — same lightweight validation style as the other harness snapshot
 * endpoints. `sessionType` accepts `undefined` (omitted) for the explicit
 * "no session info available" path the scenario must handle.
 */
export function validateQualifyingInvalidationSnapshot(body: unknown): QualifyingInvalidationSnapshot | string {
  if (typeof body !== "object" || body === null) return "body must be an object";

  const b = body as Record<string, unknown>;

  let sessionType: AcceptedSessionType | undefined;

  if (b.sessionType !== undefined && b.sessionType !== null) {
    if (!isAcceptedSessionType(b.sessionType)) {
      return `sessionType must be one of: ${SESSION_TYPES.join(", ")} (or omitted)`;
    }

    sessionType = b.sessionType;
  }

  let sessionNum: number | undefined;

  if (b.sessionNum !== undefined && b.sessionNum !== null) {
    if (typeof b.sessionNum !== "number" || !Number.isInteger(b.sessionNum) || b.sessionNum < 0) {
      return "sessionNum must be a non-negative integer (or omitted)";
    }

    sessionNum = b.sessionNum;
  }

  let lapsRemaining: number | undefined;

  if (b.lapsRemaining !== undefined && b.lapsRemaining !== null) {
    if (typeof b.lapsRemaining !== "number" || !Number.isInteger(b.lapsRemaining) || b.lapsRemaining < 0) {
      return "lapsRemaining must be a non-negative integer (or omitted)";
    }

    lapsRemaining = b.lapsRemaining;
  }

  if (typeof b.lapLimited !== "boolean") {
    return "lapLimited must be a boolean";
  }

  if (typeof b.lapCompleted !== "number" || !Number.isInteger(b.lapCompleted) || b.lapCompleted < 0) {
    return "lapCompleted must be a non-negative integer";
  }

  // `lapStartedFromPits` is optional in the harness body so existing shortcuts
  // that don't set it default to `false` (the typical "normal flying lap"
  // case). Production plugins always populate it via bus subscriptions.
  let lapStartedFromPits = false;

  if (b.lapStartedFromPits !== undefined && b.lapStartedFromPits !== null) {
    if (typeof b.lapStartedFromPits !== "boolean") {
      return "lapStartedFromPits must be a boolean (or omitted)";
    }

    lapStartedFromPits = b.lapStartedFromPits;
  }

  return {
    sessionType,
    sessionNum,
    lapsRemaining,
    lapLimited: b.lapLimited,
    lapCompleted: b.lapCompleted,
    lapStartedFromPits,
  };
}
