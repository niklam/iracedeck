/**
 * Which kind of session the sim is in, for switching the deck's profile by
 * session kind (#1111).
 *
 * Deliberately separate from the translator's private `classifySessionType`,
 * which folds every raw `SessionType` into the three buckets the Race
 * Engineer's session-start callout records a line for — testing reads as
 * practice there and anything unrecognised as race, and those callouts depend
 * on exactly that. Profile switching needs the opposite trade: a row of its
 * own for testing and for replays, and no guess at all for a string it does
 * not know, so an unknown kind never moves the deck.
 */

/** The five session kinds a profile can be mapped to. */
export type SessionKind = "test" | "practice" | "qualifying" | "race" | "replay";

const KIND_BY_SESSION_TYPE: ReadonlyMap<string, Exclude<SessionKind, "replay">> = new Map<
  string,
  Exclude<SessionKind, "replay">
>([
  ["Offline Testing", "test"],
  ["Practice", "practice"],
  ["Lone Practice", "practice"],
  ["Warmup", "practice"],
  ["Open Qualify", "qualifying"],
  ["Lone Qualify", "qualifying"],
  ["Race", "race"],
]);

/**
 * Classifies iRacing's raw `SessionType` and `WeekendInfo.SimMode` into a
 * {@link SessionKind}.
 *
 * A saved replay (`simMode === "replay"`) is `"replay"` whatever the session
 * type says, an empty one included. Watching the replay in the middle of a
 * live session keeps `SimMode` at `"full"`, so it classifies by its session
 * type and does not swap the deck under the driver. Exact strings only: any
 * `SessionType` not in the table (`"Heat Race"`, an empty string, a future
 * name) is `null`, which switches nothing.
 */
export function classifySessionKind(sessionType: string, simMode: string | undefined): SessionKind | null {
  if (simMode === "replay") return "replay";

  return KIND_BY_SESSION_TYPE.get(sessionType) ?? null;
}
