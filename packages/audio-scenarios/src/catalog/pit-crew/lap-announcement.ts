/**
 * Which lap-time callout speaks for the player's lap, and for how long a lap
 * call stays worth saying (issues #1163, #1571). A leaf module the three
 * lap-time families import — the fastest lap of the race
 * (`pit-crew.fastest-lap-race`, `fastest-lap.ts`), the best lap
 * (`pit-crew.lap-time-best`, #555) and every lap (`pit-crew.lap-time-last`,
 * #1163, both in `lap-time.ts`) — so the precedence and the drop rule are
 * each one definition rather than a rule copied into three `where:`s, which
 * would drift the first time one of them changed.
 *
 * The precedence is decided on the `lap.completed` payload, never by which
 * line reaches the bus first: one contract yielding to another is decided at
 * `where:` (the #1211 lesson).
 */
import type { SimEventOf } from "@iracedeck/event-bus";

/** The `lap.completed` payload the decisions here read. */
type LapCompleted = SimEventOf<"lap.completed">["data"];

/**
 * A record set on a car's own first or second completed lap is never
 * announced, whoever's car it is (#1571, decision 5): the field's opening
 * laps lower the record one car after another, and each would be a call.
 */
export const FASTEST_LAP_GRACE_LAPS = 2;

/**
 * Whether a fastest lap of the race set on the car's `lapCount`-th completed
 * lap may be announced: the callout is `enabled` and the lap is past the
 * grace. The fastest-lap contract's `where:` and {@link playerLapOwner} both
 * call it, so the lap the fastest-lap call refuses is exactly the lap it
 * hands to the best-lap call.
 */
export function fastestLapAnnounceable(lapCount: number, enabled: boolean): boolean {
  return enabled && lapCount > FASTEST_LAP_GRACE_LAPS;
}

/** The lap-time callout that speaks for a lap the player completed; `null` when none does. */
export type PlayerLapOwner = "fastest-lap" | "best-lap" | "every-lap" | null;

/**
 * Whether each of the three lap-time callouts may speak at all: its opt-in
 * AND the active voice scripting its contract, so a pack that leaves out one
 * line hands the lap to the next instead of leaving it unsaid.
 */
export type LapOwnerFlags = { fastestLap: boolean; bestLap: boolean; everyLap: boolean };

/**
 * The one lap-time callout that speaks for the player's lap, in order of
 * precedence (#1571, decision 7; #1163): the fastest lap of the race when
 * the lap set it and passes the grace, else the best lap when it is a
 * personal best or the first valid lap, else every lap. A fastest lap of the
 * race is always a personal best too, so with the fastest-lap call off,
 * unscripted or inside the grace, it falls to the best-lap call. The gates
 * that silence a lap whole (a caution, the final lap of a race) are not
 * here: they stay in each contract and apply to all three alike, so a gate
 * never hands one callout's lap to another.
 */
export function playerLapOwner(lap: LapCompleted, on: LapOwnerFlags): PlayerLapOwner {
  if (lap.isClassFastestLapOfRace === true && fastestLapAnnounceable(lap.lap, on.fastestLap)) return "fastest-lap";

  if ((lap.isBest || lap.isFirstValid) && on.bestLap) return "best-lap";

  if (on.everyLap) return "every-lap";

  return null;
}

/**
 * The owner of a lap, as `registerPitCrew` resolves it live at each
 * `lap.completed` from the three opt-ins and the active voice's script.
 */
export type LapOwnerResolver = (lap: LapCompleted) => PlayerLapOwner;

/**
 * Whether a lap call made when the player had completed `lapsAtEvent` laps is
 * still current: the player has not completed another lap since. `latest` is
 * the most recent `lap.completed` (the plugin-owned snapshot); `null` — no lap
 * completed yet, or a session change cleared it — admits. One definition of
 * "the next lap" for the every-lap call's gate (its own lap) and the
 * fastest-lap call's (the event's `playerLapsCompleted`), so a call held past
 * the player's next lap is dropped by both alike.
 */
export function lapStillCurrent(lapsAtEvent: number, latest: Pick<LapCompleted, "lap"> | null): boolean {
  return latest === null || latest.lap <= lapsAtEvent;
}
