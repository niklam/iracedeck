/**
 * The fastest lap of the race (issue #1571): one contract,
 * `pit-crew.fastest-lap-race`, off `fastestLap.set` — a new fastest lap of
 * the race in the player's class, set by any car, the player's included.
 *
 * The code below decides WHETHER a record is worth saying and how the fire
 * is scheduled; WHAT is said lives in the active voice's `callouts.json`
 * under the same id. The line is chosen at speak time by the declared-key
 * case `fastestLap.holder`, from the fire's own payload (`ctx.data`, the
 * #1274 shape, never a module stash), in the order its keys win:
 *
 *   yours           the player set it
 *   taken-from-you  another car beat the player's record
 *   leader          the car's live effective position is 1
 *   ahead / behind  the car is the player's race neighbour in class
 *   other           anything else, named by car number and position
 *
 * followed by the time in the compact form to the tenth ("one twenty three
 * point four", `lap-time-readout.ts`) and, for `ahead` and `behind` only, an
 * optional gap clause read through the gap family's own speakable-gap rule.
 * The line that leads into the time is cut once per onset class of the
 * time's first word (#1163), so each line is a var, `fastestLap.<line>Line`,
 * resolving `fastest-lap/<line>-<c>`; only the pieces that lead into a car
 * number (`in`, and Short Calls' `for` and `lost-to`) are addressed as pools.
 * The bundled script's shape (decision 4 of the #1571 spec):
 *
 *   { case: fastestLap.holder, of: { yours: [{{fastestLap.yoursLine}}], … } }
 *   { if: fastestLap.hasMinuteComponent, then: [{{fastestLap.minute}}] }
 *   {{fastestLap.second}}
 *   {{fastestLap.decimal}}
 *   { optional: [{{fastestLap.gapIntro}}, {{fastestLap.gapSecond}}, {{fastestLap.gapDecimal}}] }
 *
 * Positions are read LIVE when the line speaks, through the canonical order
 * (`race-positions.md`) in the payload's projection (class positions in a
 * multi-class race), so "the car in front of you" is the race neighbour when
 * it is said, never the car physically ahead on track. When either live read
 * is unknown the payload's pair is used together, so a relation is never
 * judged from one live and one stale position.
 *
 * Gates, all pure:
 *   - `where:` — the grace (`fastestLapAnnounceable`, the same predicate the
 *     lap-time precedence calls, so the lap this refuses is the lap the
 *     best-lap call speaks), no full-course caution out (#1127), and not
 *     after the player's own finish (#569).
 *   - `speakGate` — the drop rule (decision 9): a fire held past the
 *     player's next completed lap is dropped (`lapStillCurrent` against the
 *     event's `playerLapsCompleted`), and the caution and finish asked again.
 *
 * Scheduling (decision 8): the default weight (#555's, whose lap the `yours`
 * line takes over), no interrupt, queueable (a one-shot edge, the #923 rule),
 * its own `fastest-lap` family (a newer record replaces a line about the old
 * one in flight), the `fastest-lap` supersede group (a waiting call about an
 * older record is replaced by a newer one) and a 30 s queue wait, since the
 * line stays true while it waits.
 *
 * Nothing here keeps module state, so there is no debug-state reader.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, FASTEST_LAP_CALLOUTS } from "@iracedeck/callout-settings";
import type { GapSide, SimEventOf } from "@iracedeck/event-bus";

import { poolRef } from "../../dsl.js";
import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { UnderCautionResolver } from "./caution.js";
import { type LiveGapsResolver, speakableGap, type SpeakableGap } from "./gaps.js";
import { fastestLapAnnounceable, lapStillCurrent } from "./lap-announcement.js";
import {
  compactHasMinute,
  compactLeadClass,
  compactMinuteRef,
  compactSecondRef,
  compactTenthRef,
} from "./lap-time-readout.js";
import type { LapCompletedSnapshotResolver } from "./lap-time.js";
import type { LivePositionResolver } from "./position-readout.js";

/** The `fastestLap.set` payload. */
export type FastestLapData = SimEventOf<"fastestLap.set">["data"];

/**
 * One car's live effective position in the projection asked for, `null` when
 * unknown — the per-car read the opponent families already take
 * (`getLiveCarPosition` behind it, `race-engineer-wiring`). `position` is the
 * emit-time payload position the read falls back from; the wiring ignores it.
 */
export type FastestLapCarPositionResolver = (car: {
  carIdx: number;
  position: number;
  isMultiClass: boolean;
}) => number | null;

/** What the fastest-lap family reads besides its event. */
export type FastestLapDeps = {
  getRaceFinishedFired: () => boolean;
  getUnderFullCourseCaution: UnderCautionResolver;
  getLapCompletedSnapshot: LapCompletedSnapshotResolver;
  /** The record holder's live effective position. */
  getCarLivePosition: FastestLapCarPositionResolver;
  /** The player's live position, both projections. */
  getLivePosition: LivePositionResolver;
  /** The live gaps to the class neighbours, for the gap clause. */
  getLiveGaps: LiveGapsResolver;
};

/** Which line the fastest-lap call speaks, in the order the keys win. */
export type FastestLapHolder = "yours" | "taken-from-you" | "leader" | "ahead" | "behind" | "other";

/** The declared key set of `fastestLap.holder`, each with what it means for a pack author. */
export const FASTEST_LAP_HOLDER_KEYS: Readonly<Record<FastestLapHolder, string>> = {
  yours: "The driver set the fastest lap of the race.",
  "taken-from-you": "Another car just beat the driver's fastest lap of the race.",
  leader: "The race leader (in the class) set it.",
  ahead: "The car one position ahead of the driver in the class set it.",
  behind: "The car one position behind the driver in the class set it.",
  other: "Any other car set it.",
};

/**
 * The var that speaks each holder's line, the line chosen by the case and its
 * take by the time that follows: `fastest-lap/<holder>-<c>`.
 */
export const FASTEST_LAP_LINE_VARS: Readonly<Record<FastestLapHolder, string>> = {
  yours: "fastestLap.yoursLine",
  "taken-from-you": "fastestLap.takenFromYouLine",
  leader: "fastestLap.leaderLine",
  ahead: "fastestLap.aheadLine",
  behind: "fastestLap.behindLine",
  other: "fastestLap.otherLine",
};

const FASTEST_LAP_GROUP = "fastest-lap";
const CAR_NUMBER_GROUP = "car-number";
const POSITION_NUMBER_GROUP = "position-number";
const GAP_GROUP = "gap";
const GAP_SECOND_GROUP = "lap-time-second";
const GAP_DECIMAL_GROUP = "lap-time-decimal";

/** The expanding fire's `fastestLap.set` payload, or `null` for any other fire (an imperative one included). */
function fastestLapDataOf(ctx: ScenarioContext): FastestLapData | null {
  if (ctx.event?.event !== "fastestLap.set") return null;

  return (ctx.data as FastestLapData | null | undefined) ?? null;
}

/** A position that can be spoken: a positive integer. */
function speakablePosition(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** The record holder's position: live in the payload's projection, else the payload's. */
function carPosition(data: FastestLapData, getCarLivePosition: FastestLapCarPositionResolver): number | null {
  const live = speakablePosition(
    getCarLivePosition({ carIdx: data.carIdx, position: data.position ?? 0, isMultiClass: data.isMultiClass === true }),
  );

  return live ?? speakablePosition(data.position);
}

/**
 * The holder's and the player's positions for the relation: both live, in
 * the payload's projection, when both live reads answer; otherwise both from
 * the payload, so the relation is judged from one moment.
 *
 * @internal Exported for testing.
 */
export function relationPositions(
  data: FastestLapData,
  deps: Pick<FastestLapDeps, "getCarLivePosition" | "getLivePosition">,
): { car: number | null; player: number | null } {
  const multi = data.isMultiClass === true;
  const liveCar = speakablePosition(
    deps.getCarLivePosition({ carIdx: data.carIdx, position: data.position ?? 0, isMultiClass: multi }),
  );
  const player = deps.getLivePosition();
  const livePlayer = player ? speakablePosition(multi ? player.classPosition : player.position) : null;

  if (liveCar !== null && livePlayer !== null) return { car: liveCar, player: livePlayer };

  return { car: speakablePosition(data.position), player: speakablePosition(data.playerPosition) };
}

/**
 * Which line the call speaks for this record, in the order the keys win:
 * the player's own lap, the player's record taken, the leader, the car ahead,
 * the car behind, anyone else.
 *
 * @internal Exported for testing.
 */
export function resolveFastestLapHolder(
  data: FastestLapData,
  positions: { car: number | null; player: number | null },
): FastestLapHolder {
  if (data.isPlayer) return "yours";

  if (data.previous?.isPlayer === true) return "taken-from-you";

  if (positions.car === 1) return "leader";

  if (positions.car !== null && positions.player !== null) {
    if (positions.car === positions.player - 1) return "ahead";

    if (positions.car === positions.player + 1) return "behind";
  }

  return "other";
}

/**
 * The gap clause's numbers: for an `ahead` or `behind` line only, the live gap
 * on that side when its car is this fire's car, on the same lap, under a
 * minute — the gap family's own rule ({@link speakableGap}). All three gap
 * vars resolve through this one check, so the clause is spoken whole or not
 * at all.
 */
function fireGap(ctx: ScenarioContext, deps: FastestLapDeps): SpeakableGap | null {
  const data = fastestLapDataOf(ctx);

  if (data === null) return null;

  const holder = resolveFastestLapHolder(data, relationPositions(data, deps));

  if (holder !== "ahead" && holder !== "behind") return null;

  const side: GapSide = holder;

  return speakableGap(deps.getLiveGaps(), side, data.carIdx);
}

/** A car number as a `car-number` pool reference; `null` when absent or empty. */
function carNumberRef(carNumber: string | undefined): string | null {
  return typeof carNumber === "string" && carNumber !== "" ? poolRef(CAR_NUMBER_GROUP, carNumber) : null;
}

/**
 * Build the fastest-lap family over its reads: the vocabulary its script may
 * name and its one contract, sharing one set of reads.
 */
export function buildFastestLap(deps: FastestLapDeps): {
  registerVocabulary(engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">): void;
  contracts: readonly ScenarioContract[];
} {
  const registerVocabulary = (engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">): void => {
    engine.defineCase(
      "fastestLap.holder",
      (ctx) => {
        const data = fastestLapDataOf(ctx);

        return data === null ? null : resolveFastestLapHolder(data, relationPositions(data, deps));
      },
      FASTEST_LAP_HOLDER_KEYS,
      "Whose fastest lap of the race it is, chosen when the line speaks from live positions in the class: the driver's own, one taken from the driver, the leader's, the car ahead's, the car behind's, or another car's.",
    );

    engine.defineVar(
      "fastestLap.carNumber",
      (ctx) => carNumberRef(fastestLapDataOf(ctx)?.carNumber),
      "The number of the car that set the fastest lap, from the car-number clip group; nothing when the sim gave the car no number, which aborts a line that needs it.",
    );

    engine.defineVar(
      "fastestLap.previousCarNumber",
      (ctx) => carNumberRef(fastestLapDataOf(ctx)?.previous?.carNumber),
      "The number of the car whose fastest lap was just beaten, from the car-number clip group; nothing for the first timed lap of the race or a car with no number.",
    );

    engine.defineVar(
      "fastestLap.position",
      (ctx) => {
        const data = fastestLapDataOf(ctx);

        if (data === null) return null;

        const n = carPosition(data, deps.getCarLivePosition);

        return n === null ? null : poolRef(POSITION_NUMBER_GROUP, String(n));
      },
      "The class position of the car that set the fastest lap, read live when the line speaks (else as it stood when the record fell), from the position-number clip group.",
    );

    const lapTimeOf = (ctx: ScenarioContext): number | null => fastestLapDataOf(ctx)?.lapTime ?? null;

    for (const [holder, name] of Object.entries(FASTEST_LAP_LINE_VARS) as [FastestLapHolder, string][]) {
      engine.defineVar(
        name,
        (ctx) => {
          const t = lapTimeOf(ctx);
          const lead = t === null ? null : compactLeadClass(t, "tenths");

          return lead === null ? null : poolRef(FASTEST_LAP_GROUP, `${holder}-${lead}`);
        },
        `For the ${holder} case: ${FASTEST_LAP_HOLDER_KEYS[holder]} The line that leads into the time, from the fastest-lap clip group: fastest-lap/${holder}-<c>, c the onset class of the first word of the time to the tenth (${holder}-w for 1:23.4, ${holder}-t for 2:00.0, ${holder}-f for 58.1).`,
      );
    }

    engine.defineVar(
      "fastestLap.minute",
      (ctx) => {
        const t = lapTimeOf(ctx);

        return t === null ? null : compactMinuteRef(t, "tenths");
      },
      "The minute of the fastest lap read the way a timing screen does, to the tenth, from the lap-time-compact-minute clip group: base <m>-<c>, c the onset class of the seconds word that follows (lap-time-compact-minute/1-t for 1:23.4, 1-oh for 1:05.4). Nothing under a minute; a minute the voice has no clip for aborts the line.",
    );

    engine.defineVar(
      "fastestLap.second",
      (ctx) => {
        const t = lapTimeOf(ctx);

        return t === null ? null : compactSecondRef(t, "tenths");
      },
      'The seconds of the fastest lap in the compact form, to the tenth: after a minute, 0 to 9 from the lap-time-compact-second clip group (00 to 09, "oh five") and 10 to 59 from the lap-time-second clip group; under a minute, lap-time-second (0 to 59) throughout.',
    );

    engine.defineVar(
      "fastestLap.decimal",
      (ctx) => {
        const t = lapTimeOf(ctx);

        return t === null ? null : compactTenthRef(t);
      },
      'The tenths of the fastest lap ("point four"), which end the time, from the lap-time-compact-tenth clip group.',
    );

    engine.defineCond(
      "fastestLap.hasMinuteComponent",
      (ctx) => {
        const t = lapTimeOf(ctx);

        return t !== null && compactHasMinute(t, "tenths");
      },
      "The fastest lap, rounded to the tenth, is a minute or longer, so fastestLap.minute is spoken before the seconds.",
    );

    engine.defineVar(
      "fastestLap.gapIntro",
      (ctx) => (fireGap(ctx, deps) === null ? null : poolRef(GAP_GROUP, "readout-intro")),
      'The lead-in of the gap to the car that set it ("Gap is"), from gap/readout-intro: only for the car ahead or behind, when it is still that neighbour on the same lap under a minute away; fastestLap.gapSecond and fastestLap.gapDecimal resolve on the same test, so the clause is spoken whole or not at all.',
    );

    engine.defineVar(
      "fastestLap.gapSecond",
      (ctx) => {
        const gap = fireGap(ctx, deps);

        return gap === null ? null : poolRef(GAP_SECOND_GROUP, String(gap.seconds));
      },
      "The whole seconds of that gap, 0 to 59, from the lap-time-second clip group, read live; nothing when fastestLap.gapIntro has nothing.",
    );

    engine.defineVar(
      "fastestLap.gapDecimal",
      (ctx) => {
        const gap = fireGap(ctx, deps);

        return gap === null ? null : poolRef(GAP_DECIMAL_GROUP, String(gap.tenths));
      },
      'The tenths of that gap, 0 to 9, from the lap-time-decimal clip group ("point two seconds"), read live; nothing when fastestLap.gapIntro has nothing.',
    );
  };

  const contract: ScenarioContract = {
    id: "pit-crew.fastest-lap-race",
    description:
      "A new fastest lap of the race in your class is set, by you or another car, from that car's third lap on, with no caution out and before you finish.",
    when: {
      event: "fastestLap.set",
      where: (ev) => {
        if (ev.event !== "fastestLap.set") return false;

        const data = ev.data as FastestLapData;

        // The grace (decision 5): the opt-in is the wrapper's, so the
        // predicate is asked for the lap count alone here.
        if (!fastestLapAnnounceable(data.lap, true)) return false;

        // A full-course caution owns the radio while the yellow is out (#1127).
        if (deps.getUnderFullCourseCaution()) return false;

        // Race-end has the floor once the player has finished (#569).
        return !deps.getRaceFinishedFired();
      },
    },
    speakGate: {
      description:
        "The driver has not completed another lap since the record fell, no full-course caution is out and the driver has not finished the race.",
      admit: (ctx) => {
        if (deps.getUnderFullCourseCaution() || deps.getRaceFinishedFired()) return false;

        const data = fastestLapDataOf(ctx);

        return data === null || lapStillCurrent(data.playerLapsCompleted, deps.getLapCompletedSnapshot());
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    interrupt: false,
    queueable: true,
    family: "fastest-lap",
    supersedeGroup: "fastest-lap",
    maxQueueWaitMs: 30_000,
  };

  return { registerVocabulary, contracts: [contract] };
}

/** Stable identifier for the fastest-lap callout (issue #1571). */
export type FastestLapCalloutId = CalloutIdOf<typeof FASTEST_LAP_CALLOUTS>;

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_FASTEST_LAP_ID`.
export const FASTEST_LAP_SCENARIO_IDS = ["pit-crew.fastest-lap-race"] as const;

export const SCENARIO_ID_TO_FASTEST_LAP_ID: Record<(typeof FASTEST_LAP_SCENARIO_IDS)[number], FastestLapCalloutId> = {
  "pit-crew.fastest-lap-race": "fastest-lap",
};

/**
 * The `fastest-lap` group bases the first-party scripts address directly, for
 * both voices (decision 6): the pieces that lead into a car number or a
 * position, whose take does not depend on the time — the default voice's
 * `in` (between the car number and the position) and the Short Calls voice's
 * `for` and `lost-to`. The lines that lead into the time are the
 * `fastestLap.<line>Line` vars' (`fastest-lap/<line>-<c>`), and the time, the
 * car number, the position and the gap clause are vars' too, drawing from
 * their own groups.
 */
export const FASTEST_LAP_CLIP_SOURCES: readonly { group: "fastest-lap"; base: string }[] = [
  { group: FASTEST_LAP_GROUP, base: "in" },
  { group: FASTEST_LAP_GROUP, base: "for" },
  { group: FASTEST_LAP_GROUP, base: "lost-to" },
];
