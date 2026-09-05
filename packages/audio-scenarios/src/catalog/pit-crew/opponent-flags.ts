/**
 * Opponent-flag family (issue #936; scripted since #1065) — "The car ahead
 * has gone black.", "The car behind has a furled flag.", "There's a car ahead
 * on track carrying a meatball." / "The car in, P4, is black.", and the
 * aggregate "other cars flagged as well" tail. Fired off
 * `opponentFlag.flagged`, branched on `relation` and `flag` (one event,
 * thirteen contracts: 4 penalty subjects × 3 relations plus the aggregate —
 * the opponent-pit family shape, keeping every variant firable from the
 * scenario harness).
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.opponent-flag-black-ahead"]`, …),
 * paired at `setScripts` time. The bundled script addresses the behind /
 * track-ahead / aggregate lines directly as `pool:opponent-flags/<base>`;
 * each `ahead` line splices the `opponentFlag.number` var (registered by
 * {@link registerOpponentFlagVocabulary}) between the `car-in` lead-in and
 * the subject's `-ahead-tail`. The lead-in is `pool:opponent-pit/car-in` —
 * the opponent-pit family's clip, reused on purpose (the #568 clip-group-reuse
 * precedent): "the car in, P4," reads identically whether the car is pitting
 * or flagged, so no second recording exists and the script simply addresses
 * the group it lives in. The old `opponent-flag-car-in` registry alias onto
 * that group is exactly what direct addressing makes unnecessary, so no
 * `pools` entry carries it.
 *
 * **No `family` — queue, don't cut.** Same-family preemption replaces an
 * in-flight family-mate regardless of `interrupt: false`, and these thirteen
 * contracts describe DIFFERENT cars: a burst of flag events would truncate
 * "The car ahead has gone black." mid-sentence with the next car's line (or
 * the aggregate tail). Leaving `family` undefined disables preemption
 * entirely, so with `interrupt: false` + `queueable: true` each line either
 * plays to completion, defers for the bus to idle, or is superseded in the
 * single pending slot by a newer fire — never chopped audio. Repeat-
 * protection lives in the translator, not here.
 *
 * **Weight by relation.** `track-ahead` (a flagged car the player is closing
 * on — the approaching-an-impaired-car safety case) fires at `WEIGHT.SAFETY`;
 * `ahead` / `behind` / the aggregate fire at `WEIGHT.NORMAL`.
 *
 * **`trigger` is deliberately ignored.** The payload's `trigger` field
 * (`"raised"` vs `"entered-range"`) records WHY the event fired — the flag
 * just went up on a car already in the window, or a car already carrying the
 * flag just entered the window — but the spoken line reads identically
 * either way ("The car ahead is black."), so no `where:` branches on it. The
 * field stays in the payload for the harness and any future consumer.
 *
 * **Speak-time number (the #922 stash shape).** The `ahead` contracts'
 * position resolves through the `opponentFlag.number` var from a single
 * module-scope stash SHARED by all four subjects' `ahead` contracts, written
 * by whichever one fires from its own `where:` — AFTER the relation + flag
 * checks and the validity checks, and only when the opt-in wrappers already
 * passed. An event that fails its own contract's gates (wrong relation,
 * wrong flag, an invalid car/position, or an opt-in-suppressed subject)
 * never reaches the write, so it can never repoint a deferred ahead line at
 * the wrong car; only a fully-gated ahead fire — furled, black, meatball, or
 * disqualify alike — claims the shared stash, matching whichever subject's
 * line is about to be spoken. The number prefers a live read through the
 * injected resolver (the plugins wire `getLiveCarPosition`), taken in the
 * projection the event was classified in (the payload's `isMultiClass`, so a
 * transient session-info dropout can't flip a multi-class read to overall
 * space), and falls back to the emit-time payload position. A missing stash
 * aborts the whole callout at expansion (#835) — never a fragment, which is
 * why the script step is a required var and not an optional clause.
 *
 * Session gating and the qualification window (which flags matter, how far
 * ahead "track-ahead" reaches) live in the translator diff
 * (`diff/opponent-flags.ts`), NOT here, so the contracts stay
 * harness-firable.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { OpponentPenaltyFlag, type SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The four penalty-flag subjects this family speaks about (issue #936). */
export type OpponentFlagCalloutId = "furled" | "black" | "meatball" | "disqualify";

/** The three per-car relations this family branches on; `"others"` is the aggregate, handled separately. */
type OpponentFlagFullRelation = "ahead" | "behind" | "track-ahead";

const SUBJECTS: readonly OpponentFlagCalloutId[] = ["furled", "black", "meatball", "disqualify"];
const RELATIONS: readonly OpponentFlagFullRelation[] = ["ahead", "behind", "track-ahead"];

/** Canonical subject → bus-enum mapping. `meatball` is `OpponentPenaltyFlag.Repair` — the sim bit's name. */
const SUBJECT_TO_FLAG: Record<OpponentFlagCalloutId, OpponentPenaltyFlag> = {
  furled: OpponentPenaltyFlag.Furled,
  black: OpponentPenaltyFlag.Black,
  meatball: OpponentPenaltyFlag.Repair,
  disqualify: OpponentPenaltyFlag.Disqualify,
};

/**
 * The flagged car the `ahead` line speaks about — stashed at `where:` time
 * from the triggering event's payload (class-space position in multi-class).
 */
export type OpponentFlagPending = {
  carIdx: number;
  position: number;
  isMultiClass: boolean;
};

/**
 * Live speak-time position read for the pending car, in the projection the
 * event was classified in. Return `null` to fall back to the emit-time
 * payload position (the harness does this by omitting the resolver).
 */
export type OpponentFlagLivePositionResolver = (pending: OpponentFlagPending) => number | null;

const POSITION_NUMBER_GROUP = "position-number";

let pendingAhead: OpponentFlagPending | null = null;

/** Test-isolation hook. */
export function _resetOpponentFlagPending(): void {
  pendingAhead = null;
}

/**
 * Register the vocabulary the opponent-flag script references (issue #1065):
 * the speak-time number var. Must run before the contracts are defined so the
 * first `setScripts` compile sees it.
 */
export function registerOpponentFlagVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getLivePosition: OpponentFlagLivePositionResolver = () => null,
): void {
  engine.defineVar(
    "opponentFlag.number",
    () => {
      if (!pendingAhead) return null;

      const live = getLivePosition(pendingAhead);
      const n = live !== null && Number.isInteger(live) && live > 0 ? live : pendingAhead.position;

      return n > 0 ? poolRef(POSITION_NUMBER_GROUP, String(n)) : null;
    },
    'The flagged car\'s race position as a spoken number, drawn from the position-number group (position-number/4 is "P4"). Read live at speak time — class position in a multi-class race — and falling back to the position the event carried. Only the ahead lines name a position; part of the sentence, so a number that cannot be resolved skips the whole line rather than leaving a gap.',
  );
}

function opponentFlagContract(
  id: string,
  weight: number,
  where: (e: SimEventOf<"opponentFlag.flagged">) => boolean,
): ScenarioContract {
  return {
    id,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight,
    interrupt: false,
    queueable: true,
    when: {
      event: "opponentFlag.flagged",
      where: (e) => where(e as SimEventOf<"opponentFlag.flagged">),
    },
  };
}

function subjectRelationContract(subject: OpponentFlagCalloutId, relation: OpponentFlagFullRelation): ScenarioContract {
  const weight = relation === "track-ahead" ? WEIGHT.SAFETY : WEIGHT.NORMAL;
  const id = `pit-crew.opponent-flag-${subject}-${relation}`;

  if (relation === "ahead") {
    return opponentFlagContract(id, weight, (ev) => {
      // relation + flag gate. `trigger` ("raised" vs "entered-range") is
      // deliberately ignored — the spoken line reads identically either
      // way; the payload keeps it for the harness/future use.
      if (ev.data.relation !== "ahead" || ev.data.flag !== SUBJECT_TO_FLAG[subject]) return false;

      const { carIdx, position, isMultiClass } = ev.data;

      // No usable car/position → nothing to speak; reject before firing. A
      // fractional position would build a `position-number/4.5` lookup
      // with no clip behind it, so non-negative integers only (mirrors
      // opponent-pit's nearby validity check).
      if (
        typeof carIdx !== "number" ||
        !Number.isInteger(carIdx) ||
        carIdx < 0 ||
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        position <= 0
      ) {
        return false;
      }

      // Stash AFTER the relation/flag + validity checks and behind the
      // opt-in wrappers (#922's shape), so only a fully-gated ahead fire
      // can repoint what a deferred ahead line speaks.
      pendingAhead = { carIdx, position, isMultiClass: isMultiClass === true };

      return true;
    });
  }

  return opponentFlagContract(id, weight, (ev) => {
    return ev.data.relation === relation && ev.data.flag === SUBJECT_TO_FLAG[subject];
  });
}

const OTHERS_CONTRACT: ScenarioContract = opponentFlagContract(
  "pit-crew.opponent-flag-others",
  WEIGHT.NORMAL,
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
  "pit-crew.opponent-flag-furled-track-ahead": "furled",
  "pit-crew.opponent-flag-black-ahead": "black",
  "pit-crew.opponent-flag-black-behind": "black",
  "pit-crew.opponent-flag-black-track-ahead": "black",
  "pit-crew.opponent-flag-meatball-ahead": "meatball",
  "pit-crew.opponent-flag-meatball-behind": "meatball",
  "pit-crew.opponent-flag-meatball-track-ahead": "meatball",
  "pit-crew.opponent-flag-disqualify-ahead": "disqualify",
  "pit-crew.opponent-flag-disqualify-behind": "disqualify",
  "pit-crew.opponent-flag-disqualify-track-ahead": "disqualify",
};

/** The aggregate contract id — registered master-gated only (see above). */
export const OPPONENT_FLAG_OTHERS_SCENARIO_ID = "pit-crew.opponent-flag-others";

export const OPPONENT_FLAG_SCENARIO_IDS: readonly string[] = OPPONENT_FLAG_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the opponent-flag script draws from — every
 * `pool:<group>/<base>` the bundled script may write, as a literal list. The
 * completeness tests read it: the bundled voice must ship at least one clip
 * for each, and the bundled script must reference exactly this set. The
 * first entry is the opponent-pit family's `car-in` lead-in, shared on
 * purpose (see the module header); the spoken number is not a source — it
 * is the `opponentFlag.number` var, drawn from `position-number` at speak
 * time.
 */
export const OPPONENT_FLAG_CLIP_SOURCES: readonly { group: "opponent-pit" | "opponent-flags"; base: string }[] = [
  { group: "opponent-pit", base: "car-in" },
  ...SUBJECTS.map((subject) => ({ group: "opponent-flags" as const, base: `${subject}-ahead-tail` })),
  ...SUBJECTS.map((subject) => ({ group: "opponent-flags" as const, base: `${subject}-behind` })),
  ...SUBJECTS.map((subject) => ({ group: "opponent-flags" as const, base: `${subject}-track` })),
  { group: "opponent-flags", base: "others" },
];
