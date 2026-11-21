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
 *   - **No full-course caution** (issue #1171) — neither out as the lap
 *     completes (`getUnderFullCourseCaution()`) nor live on any tick of the
 *     lap just completed (`wasCaution`). Behind the pace car the order is
 *     frozen, the every-three cadence is counting pace laps, and the caution
 *     sequence's own position call reads the race position out on the last
 *     caution lap. The two checks cover different laps: "out now" silences
 *     each lap that completes while the caution is live, `wasCaution` the
 *     one that completes seconds AFTER the green — the lap the caution ended
 *     on, run behind the pace car all the same. The cadence itself is
 *     untouched: a caution lap still counts toward the every-three, and a
 *     hit that lands on one is simply not spoken.
 *   - **Not on pit road, and in the car** (spec 2026-11-18, issue #1722) —
 *     on pit road the order is in flux, places lost to the stop mostly won
 *     back after it, so the position family is silent there. Asked again at
 *     speak time, first in the shared position-readout gate, so an update
 *     queued on track and still waiting when the car reaches pit road is
 *     dropped, never held; the next cadence hit after the stop states the
 *     position as it then is. An in lap is refused too, even one published
 *     after the car merged (`lapEnteredPitRoad` in `position-readout.ts`).
 *   - **Cadence hit** — `lapsSincePositionChange > 0 && % 3 === 0`. The diff
 *     omits `lapsSincePositionChange` entirely when no baseline anchors exist
 *     (e.g. position not yet resolvable); the predicate then returns false.
 *     A lap the sim did not count (issue #1582) counts like any other: the
 *     cadence reads no lap time.
 *   - **Position in announceable range** — guards against junk telemetry; the
 *     pole-callout pattern from #566 stays consistent here too.
 *
 * `weight: WEIGHT.CHATTER` + `queueable: true` because lap-time-best (default
 * `WEIGHT.NORMAL`) may fire on the same `lap.completed` and grab the Voice bus
 * first. A `queueable` contract defers and replays once the bus goes idle — see
 * `position.ts` header for the full rationale on the deferred-low mechanism.
 * Different family from lap-time so neither preempts the other.
 *
 * Being queueable is why the caution is asked a second time, at SPEAK time
 * (issue #1171). An update accepted under green and waiting in the bus's
 * queue re-expands and meets its `speakGate` when it drains, never its
 * `where:` — so the gate is what keeps it from being spoken behind the pace
 * car. The gate asks the caution BEFORE the shared position cooldown is
 * claimed: a claim followed by a refusal would burn twenty seconds of every
 * position readout for an update nobody heard. Neither check does the
 * other's work. The `where:` keeps a caution-lap fire out of the queue,
 * where it would take one of four places and, through the `position`
 * supersede group, remove a readout already waiting — only to be refused at
 * its own gate. `wasCaution` is not asked at speak time: it is a fact about
 * the completed lap, settled when the event was emitted.
 *
 * One residual neither check reaches, the same one `gaps.ts` accepts: an
 * update that passed its gate under green and is cut while PLAYING by an
 * interrupting call is stashed with `admitted: true` and replays whole
 * without being asked again — under the caution, if one was thrown before
 * the cut or while the stashed update waited. Only `queueable: false`
 * would stop that, and this contract is queueable so that it can wait
 * behind the lap-time readout of its own lap.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, RACE_STATUS_CALLOUTS } from "@iracedeck/callout-settings";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContract, SpeakGate } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { UnderCautionResolver } from "./caution.js";
import {
  buildPositionReadoutSpeakGate,
  canAnnouncePosition,
  lapEnteredPitRoad,
  type LatestTelemetryResolver,
  liveCurrentlyAnnounceable,
  type LivePositionResolver,
  lowerFirst,
  playerOnPitRoadOrOutOfCar,
  POSITION_READOUT_PIT_ROAD_CLAUSE,
  POSITION_READOUT_SPEAK_GATE_DESCRIPTION,
  POSITION_READOUT_SUPERSEDE_GROUP,
  selectLivePosition,
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
 * The race status's own speak-time gate: the shared position-readout gate
 * ({@link buildPositionReadoutSpeakGate}) with the full-course caution as
 * its extra refusal (issue #1171). The shared gate asks pit road first
 * (issue #1722), then the caution, and claims the shared cooldown only
 * after both — so neither refusal burns the window. It takes the fire's
 * intro decision before anything can refuse (issue #1138): the bundled
 * status script stashes none, but a pack may name `positionReadout.intro`
 * here, and a refusal that left the decision pending would hold it, with
 * this fire's context, until the next position gate cleared it.
 */
function raceStatusSpeakGate(
  getUnderFullCourseCaution: UnderCautionResolver,
  getLatestTelemetry: LatestTelemetryResolver,
): SpeakGate {
  return buildPositionReadoutSpeakGate(getLatestTelemetry, {
    // The shared clauses, qualified — as `position.ts` qualifies them for its
    // race branch — so the readouts cannot describe one rule two ways.
    description: `${POSITION_READOUT_PIT_ROAD_CLAUSE}, no full-course caution is out and ${lowerFirst(POSITION_READOUT_SPEAK_GATE_DESCRIPTION)}`,
    refuses: () => getUnderFullCourseCaution(),
  });
}

/**
 * Build the race-status contract. Stays a builder because its `where:` reads
 * two runtime gates: `getRaceFinishedFired` short-circuits on the final lap
 * (race-end takes priority — see header), and `getLivePosition` decides
 * whether the live position is readable before the shared position cooldown
 * is read. The window itself is claimed by the contract's `speakGate` (issue
 * #1137), after the script expanded. The spoken branch is the vocabulary's
 * ({@link registerRaceStatusVocabulary}).
 *
 * `getUnderFullCourseCaution` silences the update while a full-course
 * caution is out (issue #1171), in the `where:` and again in the
 * `speakGate` — see the header for why both. Default `() => false` preserves
 * the behavior of a test that supplies no closure.
 *
 * `getLatestTelemetry` silences it on pit road and out of the car (spec
 * 2026-11-18, issue #1722), the same two places and for the same reason: an
 * update queued on track and still waiting when the car reaches pit road is
 * dropped, never held for the exit. Default `() => null`, which never
 * refuses; `registerPitCrew` passes `PitCrewDeps.getLatestTelemetry`.
 */
export function buildRaceStatusContract(
  getRaceFinishedFired: () => boolean,
  getLivePosition: LivePositionResolver = () => null,
  getUnderFullCourseCaution: UnderCautionResolver = () => false,
  getLatestTelemetry: LatestTelemetryResolver = () => null,
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

        // Full-course caution — the order is frozen behind the pace car and
        // the caution sequence reads the race position out itself (issue
        // #1171). Refused here so the fire never enters the bus's queue.
        if (getUnderFullCourseCaution()) return false;

        // …and so is the lap that ENDS one, which completes seconds after
        // the green with the gate above already open: it was run behind the
        // pace car all the same.
        if (data.wasCaution === true) return false;

        // On pit road or out of the car (issue #1722): the order is in flux
        // there. Refused here so the fire never enters the queue; the gate
        // asks again for an update queued on track.
        if (playerOnPitRoadOrOutOfCar(getLatestTelemetry())) return false;

        // …and an in lap, even one published after the car merged
        // (`lapEnteredPitRoad`): the cadence hit that lands on it is not said.
        if (lapEnteredPitRoad(data)) return false;

        // Cadence DECISION uses the frozen snapshot (laps-since-position-change).
        if (!raceStatusCadenceHits(data)) return false;

        // Spoken number/leader read LIVE (issue #574): gate on the live
        // position being readable + share the position cooldown.
        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // LAST gate, and a pure cadence check only — the claim is the gate's
        // (issue #1137), so a fire the script cannot expand never burns the
        // window.
        return canAnnouncePosition();
      },
    },
    speakGate: raceStatusSpeakGate(getUnderFullCourseCaution, getLatestTelemetry),
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
    supersedeGroup: POSITION_READOUT_SUPERSEDE_GROUP,
    description:
      "You hold position for three race laps, then every three laps — never on the final lap or an in lap, on pit road, under a caution or on the lap ending one, or inside 20 s of another position readout.",
  };
}

/**
 * Stable identifier for the race-status callout (issue #569). Single subject
 * — the leader branch is selected internally based on effective position.
 */
export type RaceStatusCalloutId = CalloutIdOf<typeof RACE_STATUS_CALLOUTS>;

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
