/**
 * Opponent-flag family (issue #936; scripted since #1065; reworked for #1274)
 * — "Car 42 ahead has a black flag. They'll be serving a penalty.", "Car 42
 * behind has a slowdown penalty.", and the aggregate "Several cars around us
 * have penalty flags." tail. Fired off `opponentFlag.flagged`, branched on
 * `relation` and `flag` (one event, nine contracts: 4 penalty subjects × the
 * `ahead` / `behind` relations plus the aggregate — the opponent-pit family
 * shape, keeping every variant firable from the scenario harness).
 *
 * Who qualifies lives in the translator diff (`diff/opponent-flags.ts`), NOT
 * here, so the contracts stay harness-firable: a same-class, same-lap car one
 * to three class positions ahead or the one directly behind, within the
 * driver's race-gap range. The #936 `track-ahead` relation — any car on the
 * road ahead, of any class or lap — is gone (#1274), and so are its four
 * contracts; an older pack that still scripts them compiles, the compiler
 * skipping each entry as `no contract`.
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.opponent-flag-black-ahead"]`, …),
 * paired at `setScripts` time. The bundled script names the car by number:
 * each per-car line is the `opponentFlag.carNumber` var (a `car-number` clip,
 * which already says "car forty-two") followed by
 * `pool:opponent-flags/<subject>-ahead-tail` or `…-behind-tail`; the
 * aggregate is `pool:opponent-flags/others`.
 *
 * **No `family` — queue, don't cut.** Same-family preemption replaces an
 * in-flight family-mate regardless of `interrupt: false`, and these nine
 * contracts describe DIFFERENT cars: a burst of flag events would truncate
 * "Car 42 ahead has a black flag." mid-sentence with the next car's line (or
 * the aggregate tail). Leaving `family` undefined disables preemption
 * entirely, so with `interrupt: false` + `queueable: true` each line either
 * plays to completion or waits in the bus's queue for its turn — never
 * chopped audio (issue #1185). Each contract keeps the default supersede
 * group, its own id, so the lines about different subjects or relations
 * queue in turn; the cost is that a second car with the same flag on the
 * same side, arriving while the first car's line still waits, replaces it.
 * The group is per contract, never per car, and the aggregate collapse
 * bounds how often that can happen. Repeat-protection lives in the
 * translator, not here.
 *
 * **Every line is `WEIGHT.NORMAL`.** The safety weight existed only for
 * `track-ahead`, the approaching-an-impaired-car case; a flagged car near
 * you in your class is race information, not a hazard.
 *
 * **`trigger` is deliberately ignored.** The payload's `trigger` field
 * (`"raised"` vs `"entered-range"`) records WHY the event fired — the flag
 * just went up on a car already in range, or a car already carrying the
 * flag just came into range — but the spoken line reads identically either
 * way, so no `where:` branches on it. The field stays in the payload for the
 * harness and any future consumer.
 *
 * **The vars read the fire's own event, never a stash.** Both vars resolve
 * from `ctx.data`, the payload of the `opponentFlag.flagged` event whose fire
 * is expanding (the `gaps.ts` shape). A deferred fire keeps its event, so a
 * later flag event — one that never plays because the pending slot refuses
 * it, or one whose own contract is opt-in-suppressed — can never repoint a
 * waiting line at another car. The #922 module-scope stash this family used
 * to share across its four `ahead` contracts is gone: once the `behind` lines
 * named the car too, one stash would have been written by eight contracts,
 * and every write by a fire that is then dropped is a wrong car spoken later.
 *
 * - `opponentFlag.carNumber` — the car's number as the session info spells
 *   it, from the `car-number` group (`09` and `9` are different clips).
 *   `null` when the event carries no number; a number the active voice has
 *   no clip for resolves to a `pool:` reference the engine finds empty. Both
 *   abort the whole callout at expansion (#835) — never "ahead has a black
 *   flag" with a gap where the car was. The contracts therefore still fire on
 *   a numberless event, so a pack whose lines do not name the car keeps
 *   speaking them; only a line that needs the number is skipped.
 * - `opponentFlag.number` — the car's race position (class position in
 *   multi-class), the 3.3.0 var. The bundled pack no longer uses it; it stays
 *   defined because a script naming a var the build does not define fails to
 *   compile, and a pack scripted against 3.3.0 says "The car in, P5, …". It
 *   prefers a live read through the injected resolver (the plugins wire
 *   `getLiveCarPosition`), taken in the projection the event was classified
 *   in (the payload's `isMultiClass`, so a transient session-info dropout
 *   can't flip a multi-class read to overall space), and falls back to the
 *   emit-time payload position.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { OpponentPenaltyFlag, type SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The four penalty-flag subjects this family speaks about (issue #936). */
export type OpponentFlagCalloutId = "furled" | "black" | "meatball" | "disqualify";

/** The two per-car relations this family branches on; `"others"` is the aggregate, handled separately. */
type OpponentFlagCarRelation = "ahead" | "behind";

const SUBJECTS: readonly OpponentFlagCalloutId[] = ["furled", "black", "meatball", "disqualify"];
const RELATIONS: readonly OpponentFlagCarRelation[] = ["ahead", "behind"];

/** Canonical subject → bus-enum mapping. `meatball` is `OpponentPenaltyFlag.Repair` — the sim bit's name. */
const SUBJECT_TO_FLAG: Record<OpponentFlagCalloutId, OpponentPenaltyFlag> = {
  furled: OpponentPenaltyFlag.Furled,
  black: OpponentPenaltyFlag.Black,
  meatball: OpponentPenaltyFlag.Repair,
  disqualify: OpponentPenaltyFlag.Disqualify,
};

/**
 * The flagged car a line speaks about, as the live position resolver is asked
 * for it — read from the expanding fire's own event payload (class-space
 * position in multi-class).
 */
export type OpponentFlagPending = {
  carIdx: number;
  position: number;
  isMultiClass: boolean;
};

/**
 * Live speak-time position read for the flagged car, in the projection the
 * event was classified in. Return `null` to fall back to the emit-time
 * payload position (the harness does this by omitting the resolver).
 */
export type OpponentFlagLivePositionResolver = (pending: OpponentFlagPending) => number | null;

const POSITION_NUMBER_GROUP = "position-number";

/** The clip group every car number is spoken from — the caution family's (#1127). */
const CAR_NUMBER_GROUP = "car-number";

type OpponentFlagData = SimEventOf<"opponentFlag.flagged">["data"];

/** The expanding fire's `opponentFlag.flagged` payload, or `null` for any other fire (an imperative one included). */
function flaggedData(ctx: ScenarioContext): OpponentFlagData | null {
  if (ctx.event?.event !== "opponentFlag.flagged") return null;

  return (ctx.data as OpponentFlagData | null | undefined) ?? null;
}

/**
 * The flagged car's number as a `car-number` pool reference, or `null` when
 * the fire's event carries none (the session info had no row for the car).
 * Whether the active voice can say it is the engine's call: a reference with
 * no clip behind it aborts the callout at expansion exactly as a `null` does.
 *
 * @internal Exported for testing.
 */
export function resolveOpponentFlagCarNumber(ctx: ScenarioContext): string | null {
  const carNumber = flaggedData(ctx)?.carNumber;

  return typeof carNumber === "string" && carNumber !== "" ? poolRef(CAR_NUMBER_GROUP, carNumber) : null;
}

/**
 * The flagged car's position as a `position-number` pool reference — live
 * when the resolver answers, else the payload's — or `null` when the event
 * has no usable car or position. A fractional or non-positive value would
 * build a lookup with no clip behind it (`position-number/4.5`), so only
 * positive integers are spoken (mirrors opponent-pit's validity check).
 */
function resolveOpponentFlagPosition(
  ctx: ScenarioContext,
  getLivePosition: OpponentFlagLivePositionResolver,
): string | null {
  const data = flaggedData(ctx);

  if (data === null) return null;

  const { carIdx, position, isMultiClass } = data;

  if (
    typeof carIdx !== "number" ||
    !Number.isInteger(carIdx) ||
    carIdx < 0 ||
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position <= 0
  ) {
    return null;
  }

  const live = getLivePosition({ carIdx, position, isMultiClass: isMultiClass === true });
  const n = live !== null && Number.isInteger(live) && live > 0 ? live : position;

  return poolRef(POSITION_NUMBER_GROUP, String(n));
}

/**
 * Register the vocabulary the opponent-flag script references (issue #1065;
 * the car number since #1274). Must run before the contracts are defined so
 * the first `setScripts` compile sees it.
 */
export function registerOpponentFlagVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getLivePosition: OpponentFlagLivePositionResolver = () => null,
): void {
  engine.defineVar(
    "opponentFlag.carNumber",
    resolveOpponentFlagCarNumber,
    'The flagged car\'s number, spoken from the car-number group exactly as the sim spells it — "09" and "9" are different clips, and the car-number clips already say "car", so car-number/42 is "car forty-two". Resolves on the ahead and behind lines, never on the aggregate. Part of the sentence: a car the session cannot number, or a number the voice has no clip for, skips the whole line rather than leaving a gap — so a line that must be spoken regardless keeps a wording without it.',
  );
  engine.defineVar(
    "opponentFlag.number",
    (ctx) => resolveOpponentFlagPosition(ctx, getLivePosition),
    'The flagged car\'s race position as a spoken number, drawn from the position-number group (position-number/4 is "P4"). Read live at speak time — class position in a multi-class race — and falling back to the position the event carried. Kept for packs scripted against 3.3.0; the bundled pack names the car with opponentFlag.carNumber instead. Part of the sentence, so a number that cannot be resolved skips the whole line rather than leaving a gap.',
  );
}

function opponentFlagContract(
  id: string,
  description: string,
  where: (e: SimEventOf<"opponentFlag.flagged">) => boolean,
): ScenarioContract {
  return {
    id,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.NORMAL,
    interrupt: false,
    queueable: true,
    description,
    when: {
      event: "opponentFlag.flagged",
      where: (e) => where(e as SimEventOf<"opponentFlag.flagged">),
    },
  };
}

/**
 * The two halves of each per-car contract's `description` (#1066): which car
 * the relation means in the sim's terms — the translator's qualification
 * rule, so a pack author learns why a flag on a car four places up, or in
 * another class, never speaks — and the moment each subject names. Composed
 * per id below, so every one of the eight carries its own sentence.
 */
const RELATION_CAR: Record<OpponentFlagCarRelation, string> = {
  ahead: "A car in your class one to three places ahead on the same lap, within your Opponent flag range,",
  behind: "The car in your class directly behind you on the same lap, within your Opponent flag range,",
};

const SUBJECT_MOMENT: Record<OpponentFlagCalloutId, string> = {
  furled: "gets a slowdown penalty (the furled black flag)",
  black: "is black-flagged",
  meatball: "is shown the meatball flag",
  disqualify: "is disqualified",
};

function subjectRelationContract(subject: OpponentFlagCalloutId, relation: OpponentFlagCarRelation): ScenarioContract {
  const id = `pit-crew.opponent-flag-${subject}-${relation}`;
  const description = `${RELATION_CAR[relation]} ${SUBJECT_MOMENT[subject]} in a race, between the green and the checkered flag.`;

  // The relation + flag gate only. What a line names is the vars' business:
  // a line needing a number the event lacks is skipped at expansion, while a
  // pack's numberless wording still plays. `trigger` is deliberately ignored
  // — the spoken line reads identically either way.
  return opponentFlagContract(
    id,
    description,
    (ev) => ev.data.relation === relation && ev.data.flag === SUBJECT_TO_FLAG[subject],
  );
}

const OTHERS_CONTRACT: ScenarioContract = opponentFlagContract(
  "pit-crew.opponent-flag-others",
  "A third car near you picks up a penalty flag within twelve seconds of the first two in a race, and further flagged cars stay uncalled until things go quiet.",
  (ev) => ev.data.relation === "others",
);

export const OPPONENT_FLAG_CONTRACTS: readonly ScenarioContract[] = [
  ...SUBJECTS.flatMap((subject) => RELATIONS.map((relation) => subjectRelationContract(subject, relation))),
  OTHERS_CONTRACT,
];

/** Canonical id↔setting-key map plugins read the live opt-in through. */
export const OPPONENT_FLAG_CALLOUT_SETTING_KEYS: Record<OpponentFlagCalloutId, string> = {
  furled: "calloutEnabledOpponentFlagFurled",
  black: "calloutEnabledOpponentFlagBlack",
  meatball: "calloutEnabledOpponentFlagMeatball",
  disqualify: "calloutEnabledOpponentFlagDisqualify",
};

/**
 * Bus enum value → callout id, for the translator-side opt-in resolver the
 * plugins inject into `initializeSimEventsIracing` (#936 review): the diff
 * speaks `OpponentPenaltyFlag` (sim-bit names — the meatball is `Repair`),
 * the settings speak callout ids.
 */
export const OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID: Record<OpponentPenaltyFlag, OpponentFlagCalloutId> = {
  [OpponentPenaltyFlag.Furled]: "furled",
  [OpponentPenaltyFlag.Black]: "black",
  [OpponentPenaltyFlag.Repair]: "meatball",
  [OpponentPenaltyFlag.Disqualify]: "disqualify",
};

/**
 * The aggregate (`pit-crew.opponent-flag-others`) is deliberately ABSENT:
 * per-flag opt-ins are enforced in the translator diff (#936 review), so the
 * aggregate only ever describes flags the user opted into — it registers
 * master-gated but not per-flag-gated (see `registerPitCrew`). Mapping it to
 * one subject (the earlier #622-shaped `others → black` ride-along) let a
 * disabled Black opt-in silence an aggregate built from ENABLED subjects.
 */
export const SCENARIO_ID_TO_OPPONENT_FLAG_ID: Record<string, OpponentFlagCalloutId> = {
  "pit-crew.opponent-flag-furled-ahead": "furled",
  "pit-crew.opponent-flag-furled-behind": "furled",
  "pit-crew.opponent-flag-black-ahead": "black",
  "pit-crew.opponent-flag-black-behind": "black",
  "pit-crew.opponent-flag-meatball-ahead": "meatball",
  "pit-crew.opponent-flag-meatball-behind": "meatball",
  "pit-crew.opponent-flag-disqualify-ahead": "disqualify",
  "pit-crew.opponent-flag-disqualify-behind": "disqualify",
};

/** The aggregate contract id — registered master-gated only (see above). */
export const OPPONENT_FLAG_OTHERS_SCENARIO_ID = "pit-crew.opponent-flag-others";

export const OPPONENT_FLAG_SCENARIO_IDS: readonly string[] = OPPONENT_FLAG_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the opponent-flag script draws from — every
 * `pool:<group>/<base>` the bundled script may write, as a literal list. The
 * completeness tests read it: the bundled voice must ship at least one clip
 * for each, and the bundled script must reference exactly this set. The
 * spoken car number is not a source: it is the `opponentFlag.carNumber` var,
 * drawn from the `car-number` group at speak time.
 */
export const OPPONENT_FLAG_CLIP_SOURCES: readonly { group: "opponent-flags"; base: string }[] = [
  ...SUBJECTS.map((subject) => ({ group: "opponent-flags" as const, base: `${subject}-ahead-tail` })),
  ...SUBJECTS.map((subject) => ({ group: "opponent-flags" as const, base: `${subject}-behind-tail` })),
  { group: "opponent-flags", base: "others" },
];
