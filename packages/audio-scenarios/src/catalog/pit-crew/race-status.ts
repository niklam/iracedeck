/**
 * Race-status periodic position update — issue #569.
 *
 * Fires on `lap.completed` during race sessions when
 * `lapsSincePositionChange > 0 && lapsSincePositionChange % 3 === 0` — the
 * "every-3-laps status update". The diff anchors the cadence to the driver's
 * first valid lap of the session and resets it on every position change, so a
 * driver who holds position from green flag gets P5 → silent → silent → P5 →
 * silent → silent → P5 across laps 1/2/3/4/5/6/7 (announce on 4 and 7).
 *
 * Script:
 *   [radio open]
 *   (if effective position === 1)
 *     <still-leading>                "We're still leading the race. Keep it up."
 *   (else)
 *     <intro>                        "We're currently"   (reuses position-intro-worse from #566)
 *     <number>                       "pee N"             (reuses position-number from #566)
 *   [radio close]
 *
 * Reusing the existing `position-intro-worse/currently-01` + `position-number/N`
 * clips keeps the race-status callout consistent with the qualifying flow from
 * #566 and avoids regenerating a parallel set of "status" lines.
 *
 * Snapshot-at-fire-time (issue #481 / #555 / #566 pattern): the var resolvers
 * read the latest `lap.completed` payload via the shared snapshot closure
 * — same closure the lap-time-best and position-change scenarios use, so a
 * deferred replay speaks the frozen lap's position.
 *
 * `where:` filters, top-to-bottom:
 *   - **Race only** — race-status phrasings ("still leading", "we're currently P5
 *     after this lap") fit the race standings model. Practice / qualifying / test
 *     stay silent; the qualifying-flavoured callout from #566 already covers
 *     qualifying's standings-after-best-lap model.
 *   - **Race isn't over** — `getRaceFinishedFired()` short-circuits when the
 *     race-end callout is about to fire on the same tick (the diff sets the
 *     latch before publishing `lap.completed`, so the where: sees it).
 *     Without this check we'd stack a "We're currently P3" status on top of
 *     "<Name>, we made it to the podium. We're third." on the final lap.
 *   - **Cadence hit** — `lapsSincePositionChange > 0 && % 3 === 0`. The diff
 *     omits `lapsSincePositionChange` entirely when no baseline anchors exist
 *     (e.g. position not yet resolvable); the predicate then returns false.
 *   - **Position in announceable range** — guards against junk telemetry; the
 *     pole-callout pattern from #566 stays consistent here too.
 *
 * `priority: "low"` because lap-time-best (`priority: "normal"`) may fire on
 * the same `lap.completed` and grab the Voice bus first. `low` defers and
 * replays once the bus goes idle — see `position.ts` header for the full
 * rationale on the deferred-low mechanism. Different family from lap-time so
 * neither preempts the other.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  POSITION_NUMBER_MAX,
  POSITION_NUMBER_MIN,
  positionNumberIsSpeakable,
  selectEffectivePosition,
} from "./position.js";

export { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN };

/** Shared snapshot resolver type (same shape as lap-time / position). */
export type LapCompletedSnapshotResolver = () => SimEventOf<"lap.completed">["data"] | null;

const RACE_STATUS_GROUP = "race-status";
const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_NUMBER = "position-number";

/** Cadence interval — announce status every N laps when position holds. */
export const RACE_STATUS_LAP_INTERVAL = 3;

/** Build a full `voice/{voice}/...` path for a `var` resolver. */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/**
 * Whether the cadence condition fires this lap. `lapsSincePositionChange`
 * being `undefined` (no baseline anchor yet) returns `false` — the diff omits
 * the field on the driver's first valid lap when position isn't resolvable,
 * and there's nothing to announce yet anyway.
 */
export function raceStatusCadenceHits(snapshot: SimEventOf<"lap.completed">["data"]): boolean {
  const since = snapshot.lapsSincePositionChange;

  return typeof since === "number" && since > 0 && since % RACE_STATUS_LAP_INTERVAL === 0;
}

/**
 * Register the race-status scenario's variables on the scenario engine. Must
 * run before {@link buildRaceStatusScenario} is registered — load-time
 * validation rejects `{ var }` steps whose names aren't registered.
 */
export function registerRaceStatusVars(engine: IScenarioEngine, getSnapshot: LapCompletedSnapshotResolver): void {
  // Non-leader status intro: reuses the existing `currently` clip from #566.
  engine.defineVar("raceStatus.intro", () => {
    const s = getSnapshot();

    if (!s) return null;

    return voicePath(POSITION_GROUP_INTRO_WORSE, "currently-01");
  });

  // Non-leader status number: reuses the existing `position-number` clips
  // from #566 ("pee one" through "pee sixty four").
  engine.defineVar("raceStatus.number", () => {
    const s = getSnapshot();

    if (!s) return null;

    const effective = selectEffectivePosition(s);

    if (!effective || !positionNumberIsSpeakable(effective.current)) return null;

    return voicePath(POSITION_GROUP_NUMBER, String(effective.current));
  });

  // Leader-only "still leading" clip — replaces the intro + number when
  // the driver holds P1 on the every-3 status tick.
  engine.defineVar("raceStatus.stillLeading", () => {
    const s = getSnapshot();

    if (!s) return null;

    return voicePath(RACE_STATUS_GROUP, "still-leading-01");
  });
}

/**
 * Build the race-status scenario. Takes the snapshot resolver so the `if:`
 * predicate can pick the leader branch at expansion time, and a separate
 * `getRaceFinishedFired` resolver so the `where:` can short-circuit on the
 * final lap (race-end takes priority — see header).
 */
export function buildRaceStatusScenario(
  getSnapshot: LapCompletedSnapshotResolver,
  getRaceFinishedFired: () => boolean,
): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    {
      if: () => {
        const s = getSnapshot();

        if (!s) return false;

        const effective = selectEffectivePosition(s);

        return effective !== null && effective.current === 1;
      },
      then: [{ var: "raceStatus.stillLeading" }],
      else: [{ var: "raceStatus.intro" }, { var: "raceStatus.number" }],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.race-status",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        const data = ev.data as SimEventOf<"lap.completed">["data"];

        if (data.sessionType !== "race") return false;

        // Race-end takes priority — the race-end scenario fires on the same
        // tick (race.finished is emitted before lap.completed in the diff's
        // pending queue) and the latch reads true by the time we get here.
        if (getRaceFinishedFired()) return false;

        if (!raceStatusCadenceHits(data)) return false;

        const effective = selectEffectivePosition(data);

        if (!effective) return false;

        return positionNumberIsSpeakable(effective.current);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // Defer when lap-time-best (`normal`) is already mid-fire on the same
    // lap.completed — the engine drops cross-family normal-priority scenarios
    // on a busy bus but defers and replays `low`. Different family (`race-status`
    // vs `lap-time`) so neither preempts the other.
    priority: "low",
    family: "race-status",
    sequence,
  };
}

/**
 * Stable identifier for the race-status callout (issue #569). Single subject
 * — the leader branch is selected internally based on effective position.
 */
export type RaceStatusCalloutId = "status";

/**
 * Canonical mapping from `RaceStatusCalloutId` to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points use this to read the
 * live opt-in without duplicating the key string.
 */
export const RACE_STATUS_CALLOUT_SETTING_KEYS: Record<RaceStatusCalloutId, string> = {
  status: "calloutEnabledRaceStatus",
};

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_RACE_STATUS_ID`.
export const RACE_STATUS_SCENARIO_IDS = ["pit-crew.race-status"] as const;

export const SCENARIO_ID_TO_RACE_STATUS_ID: Record<(typeof RACE_STATUS_SCENARIO_IDS)[number], RaceStatusCalloutId> = {
  "pit-crew.race-status": "status",
};

/**
 * Empty — the race-status readout is composed entirely from `engine.defineVar`
 * resolvers, not pools. Exported for parity with the family-completeness check
 * used by the other pit-crew catalog files. The broader convention alignment
 * (static `RACE_STATUS_ALERTS` + constructor helper) is tracked in issue #558.
 */
export const RACE_STATUS_POOL_NAMES: readonly string[] = [];
