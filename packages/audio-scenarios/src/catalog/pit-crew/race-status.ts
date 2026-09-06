/**
 * Race-status periodic position update — issue #569; scripted since #1065.
 *
 * Fires on `lap.completed` during race sessions when
 * `lapsSincePositionChange > 0 && lapsSincePositionChange % 3 === 0` — the
 * "every-3-laps status update". The diff anchors the cadence to the driver's
 * first valid lap of the session and resets it on every position change, so a
 * driver who holds position from green flag gets P5 → silent → silent → P5 →
 * silent → silent → P5 across laps 1/2/3/4/5/6/7 (announce on 4 and 7).
 *
 * The code below decides WHEN a status update is due and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same id (`scenarios["pit-crew.race-status"]`), paired at `setScripts`
 * time. The bundled script's shape:
 *   [radio open]
 *   (if raceStatus.isLeading)
 *     {{raceStatus.stillLeading}}    "We're still leading the race. Keep it up."
 *                                    (multi-class → "…leading our class…", #599)
 *   (else)
 *     {{raceStatus.intro}}           "We're currently"   (reuses position-intro-worse from #566)
 *     {{raceStatus.number}}          "pee N"             (reuses position-number from #566)
 *   [radio close]
 *
 * Reusing the existing `position-intro-worse/currently-01` + `position-number/N`
 * clips keeps the race-status callout consistent with the qualifying flow from
 * #566 and avoids regenerating a parallel set of "status" lines.
 *
 * Live-at-speak-time (issue #574): the var resolvers and the leader
 * condition read LIVE position via the `getLivePosition` resolver, so a
 * deferred status update says "still leading" only if we're actually P1 when
 * the engineer speaks, and reads the position now, not at the lap that
 * triggered it. The cadence DECISION still uses the frozen `lap.completed`
 * payload in the contract's `where:`. That is why the vocabulary takes the
 * live resolver and the contract builder keeps the gates its `where:` reads.
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
 * `weight: WEIGHT.CHATTER` + `queueable: true` because lap-time-best (default
 * `WEIGHT.NORMAL`) may fire on the same `lap.completed` and grab the Voice bus
 * first. A `queueable` contract defers and replays once the bus goes idle — see
 * `position.ts` header for the full rationale on the deferred-low mechanism.
 * Different family from lap-time so neither preempts the other.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  liveCurrentlyAnnounceable,
  type LivePositionResolver,
  selectLivePosition,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";

/** Shared snapshot resolver type (same shape as lap-time / position). */
export type LapCompletedSnapshotResolver = () => SimEventOf<"lap.completed">["data"] | null;

const RACE_STATUS_GROUP = "race-status";
const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_NUMBER = "position-number";

/** Cadence interval — announce status every N laps when position holds. */
export const RACE_STATUS_LAP_INTERVAL = 3;

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
 * Register the vocabulary the race-status script references (issue #1065):
 * the three vars the two branches are built from, and the leader condition
 * the script branches on. Every resolver reads LIVE position at speak time
 * (issue #574) so a deferred status update reflects the position now, not at
 * the lap that triggered it — the cadence DECISION still uses the frozen
 * snapshot in the contract's `where:`. Names and descriptions are the public
 * API of the format; the descriptions feed the generated reference (#1066).
 */
export function registerRaceStatusVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond">,
  getLivePosition: LivePositionResolver,
): void {
  // Non-leader status intro: reuses the existing `currently` clip from #566.
  engine.defineVar(
    "raceStatus.intro",
    () => poolRef(POSITION_GROUP_INTRO_WORSE, "currently"),
    'The lead-in of a non-leader status update — "we\'re currently". Draws the currently line from the position-intro-worse clip group, shared with the position callout.',
  );

  // Non-leader status number: reads LIVE position and reuses the existing
  // `position-number` clips from #566.
  engine.defineVar(
    "raceStatus.number",
    () => {
      const n = selectLivePosition(getLivePosition());

      return n !== null ? poolRef(POSITION_GROUP_NUMBER, String(n)) : null;
    },
    "The driver's live position as a spoken number — the class position in a multi-class race, the overall position otherwise. Draws from the position-number clip group; a position the voice has no clip for aborts the readout.",
  );

  // Leader-only "still leading" clip — replaces the intro + number when the
  // driver holds P1 on the every-3 status tick. In a multi-class race "P1" is
  // the CLASS lead (the leader branch keys on `selectLivePosition`, which
  // returns class position in multi-class), so speak "still leading our class"
  // rather than "still leading the race" (#599).
  engine.defineVar(
    "raceStatus.stillLeading",
    () => {
      const suffix = getLivePosition()?.isMultiClass ? "still-leading-class" : "still-leading";

      return poolRef(RACE_STATUS_GROUP, suffix);
    },
    "The leader's whole status line — still leading the race, or still leading our class in a multi-class race. Draws the still-leading and still-leading-class lines from the race-status clip group.",
  );

  // Leader detection reads LIVE position (issue #574) so a deferred status
  // update says "still leading" only if we're actually P1 at speak-time.
  engine.defineCond(
    "raceStatus.isLeading",
    () => selectLivePosition(getLivePosition()) === 1,
    "The driver is leading at speak time — first overall, or first in class in a multi-class race. The bundled script speaks the still-leading line instead of the position readout when this holds.",
  );
}

/**
 * Build the race-status contract. Stays a builder because its `where:` reads
 * two runtime gates: `getRaceFinishedFired` short-circuits on the final lap
 * (race-end takes priority — see header), and `getLivePosition` decides
 * whether the live position is readable before the shared position cooldown
 * is claimed. The spoken branch is the vocabulary's
 * ({@link registerRaceStatusVocabulary}).
 */
export function buildRaceStatusContract(
  getRaceFinishedFired: () => boolean,
  getLivePosition: LivePositionResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.race-status",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        const data = ev.data as SimEventOf<"lap.completed">["data"];

        if (data.sessionType !== "race") return false;

        // Race-end takes priority — the race-end contract fires on the same
        // tick (race.finished is emitted before lap.completed in the diff's
        // pending queue) and the latch reads true by the time we get here.
        if (getRaceFinishedFired()) return false;

        // Cadence DECISION uses the frozen snapshot (laps-since-position-change).
        if (!raceStatusCadenceHits(data)) return false;

        // Spoken number/leader read LIVE (issue #574): gate on the live
        // position being readable + share the position cooldown.
        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // LAST gate: claim the shared position cooldown only when committing.
        return tryClaimPositionAnnouncement();
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // Defer when lap-time-best (default `WEIGHT.NORMAL`) is already mid-fire on
    // the same lap.completed — the engine drops cross-family default-weight
    // scenarios on a busy bus but defers and replays a `queueable` one. Different
    // family (`race-status` vs `lap-time`) so neither preempts the other.
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "race-status",
    description:
      "Three laps pass in a race without your position changing, and every three laps after that — never on the final lap, and not within twenty seconds of another position readout.",
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
 * The readout is composed entirely from the `raceStatus.*` vars, which draw
 * from the `race-status`, `position-intro-worse` and `position-number` clip
 * groups by value — so there is no fixed `(group, base)` list to publish:
 * the bundled script addresses no pool directly. Exported empty for parity
 * with the family-completeness checks the other pit-crew catalog files
 * feed; the var descriptions name the groups.
 */
export const RACE_STATUS_CLIP_SOURCES: readonly { group: string; base: string }[] = [];
