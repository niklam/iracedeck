/**
 * Opponent pit-entry family (issue #622) — "The leader is pitting.", "The car
 * ahead/behind is pitting.", "The car in, P4, is pitting.", and the aggregate
 * "other cars pitting as well" tail. Fired off `opponentPit.entered`, branched
 * on `relation` (one event, five scenarios — the flag-family shape, keeping
 * every variant firable from the scenario harness).
 *
 * **Two families.** The leader scenario is `family: "opponent-pit-leader"`;
 * the other four share `family: "opponent-pit"`. Family preemption replaces an
 * in-flight family-mate regardless of weight, and a caution pit train emits
 * leader + aggregate in the same flush — one family would cut the leader line
 * mid-sentence. Separate families play the issue's desired sequence: leader
 * first, aggregate appended. (race-status / race-end set the
 * two-families-one-trigger precedent.)
 *
 * **Weight 65, interrupt false, queueable true** — the pit-window scheduling:
 * strategic info above chatter, below flags; never cuts; defers rather than
 * drops.
 *
 * **Speak-time number.** The nearby scenario's position resolves through the
 * `opponentPit.number` var from a plugin-owned snapshot (live canonical read
 * via `getLiveCarPosition` with the emit-time payload as fallback, composed in
 * the plugin resolver). A null snapshot aborts the whole callout at expansion
 * (#835) — never a fragment.
 *
 * Session gating (race-only / replay-only / pre-green) lives in the translator
 * diff (`diff/opponent-pit.ts`), NOT here, so the scenarios stay
 * harness-firable.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** Snapshot the nearby scenario's number resolver reads at expansion time. */
export type OpponentPitSnapshot = { position: number };

/** Resolver for the most recent opponent-pit position (live-preferred). */
export type OpponentPitSnapshotResolver = () => OpponentPitSnapshot | null;

const OPPONENT_PIT_WEIGHT = 65;
const POSITION_NUMBER_GROUP = "position-number";

/**
 * Register the speak-time number resolver. Must run before the scenarios are
 * defined — load-time validation rejects an unregistered `{ var }` name.
 */
export function registerOpponentPitVars(engine: IScenarioEngine, getSnapshot: OpponentPitSnapshotResolver): void {
  engine.defineVar("opponentPit.number", () => {
    const s = getSnapshot();

    if (!s || !Number.isInteger(s.position) || s.position <= 0) return null;

    return poolRef(POSITION_NUMBER_GROUP, String(s.position));
  });
}

function opponentPitScenario(
  subject: "leader" | "ahead" | "behind" | "nearby" | "others",
  family: string,
  body: Step[],
): Scenario {
  return {
    id: `pit-crew.opponent-pit-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: OPPONENT_PIT_WEIGHT,
    interrupt: false,
    queueable: true,
    family,
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "opponentPit.entered",
      where: (e) => (e as SimEventOf<"opponentPit.entered">).data.relation === subject,
    },
  };
}

export const OPPONENT_PIT_ALERTS: readonly Scenario[] = [
  opponentPitScenario("leader", "opponent-pit-leader", ["pool:opponent-pit-leader"]),
  opponentPitScenario("ahead", "opponent-pit", ["pool:opponent-pit-ahead"]),
  opponentPitScenario("behind", "opponent-pit", ["pool:opponent-pit-behind"]),
  opponentPitScenario("nearby", "opponent-pit", [
    "pool:opponent-pit-car-in",
    { var: "opponentPit.number" },
    "pool:opponent-pit-is-pitting",
  ]),
  opponentPitScenario("others", "opponent-pit", ["pool:opponent-pit-others"]),
];

/**
 * Stable identifiers for the two opponent-pit opt-ins (issue #622). `leader`
 * gates the leader line; `nearby` gates the ±2-window lines (ahead / behind /
 * numbered) plus the aggregate tail.
 */
export type OpponentPitCalloutId = "leader" | "nearby";

/** Canonical id↔setting-key map plugins read the live opt-in through. */
export const OPPONENT_PIT_CALLOUT_SETTING_KEYS: Record<OpponentPitCalloutId, string> = {
  leader: "calloutEnabledOpponentPitLeader",
  nearby: "calloutEnabledOpponentPitNearby",
};

export const SCENARIO_ID_TO_OPPONENT_PIT_ID: Record<string, OpponentPitCalloutId> = {
  "pit-crew.opponent-pit-leader": "leader",
  "pit-crew.opponent-pit-ahead": "nearby",
  "pit-crew.opponent-pit-behind": "nearby",
  "pit-crew.opponent-pit-nearby": "nearby",
  "pit-crew.opponent-pit-others": "nearby",
};

export const OPPONENT_PIT_SCENARIO_IDS: readonly string[] = OPPONENT_PIT_ALERTS.map((s) => s.id);

export const OPPONENT_PIT_POOL_NAMES: readonly string[] = [
  "opponent-pit-leader",
  "opponent-pit-ahead",
  "opponent-pit-behind",
  "opponent-pit-car-in",
  "opponent-pit-is-pitting",
  "opponent-pit-others",
];
