/**
 * Which session the telemetry is in, by iRacing's own name for it.
 *
 * A leaf module so that the translator and the diff modules below it can ask
 * the same question the same way: "is this a race" decides which source the
 * canonical order reads (`race-order.ts`) and which frame the pace lineup is
 * numbered in (`diff/pace-lineup.ts`), and the two must never be answered
 * from two readings of the session YAML.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * The raw `SessionType` of the session `telemetry.SessionNum` names
 * ("Practice", "Lone Qualify", "Race", …), or `""` when session info is
 * missing or does not list it. A telemetry read without `SessionNum` is taken
 * as session 0.
 */
export function resolveSessionType(sessionInfo: Record<string, unknown> | null, telemetry: TelemetryData): string {
  if (!sessionInfo) return "";

  const sessions = (sessionInfo.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    Array<Record<string, unknown>> | undefined;
  const sessionNum = telemetry.SessionNum ?? 0;
  const current = sessions?.[sessionNum as number];

  return (current?.SessionType as string) ?? "";
}

/**
 * The three buckets a session type collapses into for the translator and the
 * Race Engineer (#1587): what the session-start brief records, what a `where:`
 * gate asks ("is this a race"), and the keys of the catalog's `session.type`
 * vocabulary.
 */
export type SessionCategory = "practice" | "qualifying" | "race";

/**
 * A session type classified once, here, for every reader that must not
 * classify iRacing's strings itself (#1587). `loneQualify` is iRacing's
 * "Lone Qualify", the solo run the radar and spotter stay silent in.
 */
export interface SessionClass {
  readonly category: SessionCategory;
  readonly loneQualify: boolean;
}

const PRACTICE: SessionClass = Object.freeze({ category: "practice", loneQualify: false });
const QUALIFYING: SessionClass = Object.freeze({ category: "qualifying", loneQualify: false });
const LONE_QUALIFYING: SessionClass = Object.freeze({ category: "qualifying", loneQualify: true });
const RACE: SessionClass = Object.freeze({ category: "race", loneQualify: false });

/**
 * Classifies iRacing's raw `SessionType` ({@link resolveSessionType}): one
 * containing "Practice" or "Testing" is practice (a test session is
 * practice-like, and "it's time to race" would be wrong there), one
 * containing "Qualify" is qualifying, and anything else (warmup, heat race,
 * race, a name iRacing adds later) reads as race. `null` for `""`, a
 * session type nobody could read, so each caller states its own answer for
 * the unknown case.
 *
 * The one classifier for these buckets: the translator's session-start
 * conditions, lap payload and corner gate, and the Race Engineer catalog
 * through `SimRuntime.getSessionClass`, read it. The profile switch's
 * `classifySessionKind` (`session-kind.ts`) is deliberately a different table (exact
 * strings, a row for testing and replays, no guess for an unknown type).
 * Returns one of four frozen values, so a caller never allocates.
 */
export function classifySession(sessionType: string): SessionClass | null {
  if (sessionType === "") return null;

  if (sessionType.includes("Practice") || sessionType.includes("Testing")) return PRACTICE;

  if (sessionType.includes("Qualify")) return sessionType === "Lone Qualify" ? LONE_QUALIFYING : QUALIFYING;

  return RACE;
}
