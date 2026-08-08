/**
 * Opponent pit-entry family (issue #622) — "The leader is pitting.", "The car
 * ahead/behind is pitting.", "The car in, P4, is pitting.", and the aggregate
 * "other cars pitting as well" tail. Fired off `opponentPit.entered`, branched
 * on `relation` (one event, five scenarios — the flag-family shape, keeping
 * every variant firable from the scenario harness).
 *
 * **No `family` — queue, don't cut.** Same-family preemption replaces an
 * in-flight family-mate regardless of `interrupt: false`, and these five
 * scenarios describe DIFFERENT cars: a pit train would truncate "The car
 * ahead is pitting." mid-sentence with the next car's line (or the aggregate
 * tail). Leaving `family` undefined disables preemption entirely, so with
 * `interrupt: false` + `queueable: true` each line either plays to completion,
 * defers for the bus to idle, or is superseded in the single pending slot by
 * a newer fire — never chopped audio. Repeat-protection comes from the
 * translator's per-car cooldown + burst aggregation, not from preemption.
 *
 * **Weight 65** — the pit-window value: strategic info above chatter, below
 * flags.
 *
 * **Speak-time number (the #922 stash shape).** The nearby scenario's
 * position resolves through the `opponentPit.number` var from a module-scope
 * stash written by the nearby scenario's own `where:` — AFTER the relation
 * check, and only when the opt-in wrappers already passed — so a later
 * `opponentPit.entered` of a different relation (even one whose own scenario
 * is opt-in-suppressed) can never repoint a deferred nearby line at the wrong
 * car. The number prefers a live read through the injected resolver (the
 * plugins wire `getLiveCarPosition`), taken in the projection the event was
 * classified in (the payload's `isMultiClass`, so a transient session-info
 * dropout can't flip a multi-class read to overall space), and falls back to
 * the emit-time payload position. A missing stash aborts the whole callout at
 * expansion (#835) — never a fragment.
 *
 * Session gating (race-only / replay-only / pre-green / post-race) lives in
 * the translator diff (`diff/opponent-pit.ts`), NOT here, so the scenarios
 * stay harness-firable.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * The pitting car the nearby line speaks about — stashed at `where:` time from
 * the triggering event's payload (class-space position in multi-class).
 */
export type OpponentPitPending = {
  carIdx: number;
  position: number;
  isMultiClass: boolean;
};

/**
 * Live speak-time position read for the pending car, in the projection the
 * event was classified in. Return `null` to fall back to the emit-time
 * payload position (the harness does this by omitting the resolver).
 */
export type OpponentPitLivePositionResolver = (pending: OpponentPitPending) => number | null;

const OPPONENT_PIT_WEIGHT = 65;
const POSITION_NUMBER_GROUP = "position-number";

let pendingNearby: OpponentPitPending | null = null;

/** Test-isolation hook. */
export function _resetOpponentPitPending(): void {
  pendingNearby = null;
}

/**
 * Register the speak-time number resolver. Must run before the scenarios are
 * defined — load-time validation rejects an unregistered `{ var }` name.
 */
export function registerOpponentPitVars(
  engine: IScenarioEngine,
  getLivePosition: OpponentPitLivePositionResolver = () => null,
): void {
  engine.defineVar("opponentPit.number", () => {
    if (!pendingNearby) return null;

    const live = getLivePosition(pendingNearby);
    const n = live !== null && Number.isInteger(live) && live > 0 ? live : pendingNearby.position;

    return n > 0 ? poolRef(POSITION_NUMBER_GROUP, String(n)) : null;
  });
}

function opponentPitScenario(
  subject: "leader" | "ahead" | "behind" | "nearby" | "others",
  body: Step[],
  where?: (e: SimEventOf<"opponentPit.entered">) => boolean,
): Scenario {
  return {
    id: `pit-crew.opponent-pit-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: OPPONENT_PIT_WEIGHT,
    interrupt: false,
    queueable: true,
    sequence: ["@pit-crew.radio-open", ...body, "@pit-crew.radio-close"],
    when: {
      event: "opponentPit.entered",
      where: (e) => {
        const ev = e as SimEventOf<"opponentPit.entered">;

        if (ev.data.relation !== subject) return false;

        return where ? where(ev) : true;
      },
    },
  };
}

export const OPPONENT_PIT_ALERTS: readonly Scenario[] = [
  opponentPitScenario("leader", ["pool:opponent-pit-leader"]),
  opponentPitScenario("ahead", ["pool:opponent-pit-ahead"]),
  opponentPitScenario("behind", ["pool:opponent-pit-behind"]),
  opponentPitScenario(
    "nearby",
    ["pool:opponent-pit-car-in", { var: "opponentPit.number" }, "pool:opponent-pit-is-pitting"],
    (ev) => {
      const { carIdx, position, isMultiClass } = ev.data;

      // No usable car/position → nothing to speak; reject before firing.
      if (typeof carIdx !== "number" || typeof position !== "number" || position <= 0) return false;

      // Stash AFTER the relation + validity checks and behind the opt-in
      // wrappers (#922's shape), so only a fully-gated nearby fire can
      // repoint what a deferred nearby line speaks.
      pendingNearby = { carIdx, position, isMultiClass: isMultiClass === true };

      return true;
    },
  ),
  opponentPitScenario("others", ["pool:opponent-pit-others"]),
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
