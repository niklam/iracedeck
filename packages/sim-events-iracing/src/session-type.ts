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
