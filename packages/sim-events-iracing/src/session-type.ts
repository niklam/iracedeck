/**
 * Which session the telemetry is in, by iRacing's own name for it.
 *
 * A leaf module so that the translator and the diff modules below it can ask
 * the same question the same way: "is this a race" decides which source the
 * canonical order reads (`race-order.ts`) and which frame the pace lineup is
 * numbered in (`diff/pace-lineup.ts`), and the two must never be answered
 * from two readings of the session YAML.
 */
import type { SessionClass } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * The raw `SessionType` of the session `telemetry.SessionNum` names
 * ("Practice", "Lone Qualify", "Race", …), or `""` when session info is
 * missing, does not list it, or lists it with a `SessionType` that is not a
 * string (a hand-edited session YAML can carry a number there, which every
 * caller would otherwise hand to {@link classifySession}'s string tests). A
 * telemetry read without `SessionNum` is taken as session 0.
 */
export function resolveSessionType(sessionInfo: Record<string, unknown> | null, telemetry: TelemetryData): string {
  if (!sessionInfo) return "";

  const sessions = (sessionInfo.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    Array<Record<string, unknown>> | undefined;
  const sessionNum = telemetry.SessionNum ?? 0;
  const current = sessions?.[sessionNum as number];

  const sessionType = current?.SessionType;

  return typeof sessionType === "string" ? sessionType : "";
}

const PRACTICE: SessionClass = Object.freeze({ category: "practice", soloQualifying: false, testing: false });
const TESTING: SessionClass = Object.freeze({ category: "practice", soloQualifying: false, testing: true });
const QUALIFYING: SessionClass = Object.freeze({ category: "qualifying", soloQualifying: false, testing: false });
const SOLO_QUALIFYING: SessionClass = Object.freeze({ category: "qualifying", soloQualifying: true, testing: false });
const RACE: SessionClass = Object.freeze({ category: "race", soloQualifying: false, testing: false });

/**
 * Classifies iRacing's raw `SessionType` ({@link resolveSessionType}): one
 * containing "Practice" or "Testing" is practice (a test session is
 * practice-like, and "it's time to race" would be wrong there), one
 * containing "Qualify" is qualifying, and anything else (warmup, heat race,
 * race, a name iRacing adds later) reads as race. `null` for `""`, a
 * session type nobody could read, so each caller states its own answer for
 * the unknown case. Only iRacing's "Lone Qualify" is `soloQualifying`, and
 * only a type containing "Testing" ("Offline Testing") is `testing` (#1702):
 * still practice by category, told apart for the fuel countdown's Test
 * toggle.
 *
 * The one classifier for these buckets: the translator's session-start
 * conditions, lap payload, corner gate and checkered-flag practice read, and
 * the Race Engineer catalog
 * through `SimRuntime.getSessionClass`, read it. The profile switch's
 * `classifySessionKind` (`session-kind.ts`) is deliberately a different table (exact
 * strings, a row for testing and replays, no guess for an unknown type).
 * Returns one of five frozen values, so a caller never allocates.
 */
export function classifySession(sessionType: string): SessionClass | null {
  if (sessionType === "") return null;

  if (sessionType.includes("Testing")) return TESTING;

  if (sessionType.includes("Practice")) return PRACTICE;

  if (sessionType.includes("Qualify")) return sessionType === "Lone Qualify" ? SOLO_QUALIFYING : QUALIFYING;

  return RACE;
}
