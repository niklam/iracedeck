/**
 * Opponent pit-entry family (issue #622; scripted since #1065) — "The leader
 * is pitting.", "The car ahead/behind is pitting.", "The car in, P4, is
 * pitting.", and the aggregate "other cars pitting as well" tail. Fired off
 * `opponentPit.entered`, branched on `relation` (one event, five contracts —
 * the flag-family shape, keeping every variant firable from the scenario
 * harness).
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.opponent-pit-leader"]`, …), paired at
 * `setScripts` time. The bundled script addresses the lines directly as
 * `pool:opponent-pit/<base>`; the numbered line splices the
 * `opponentPit.number` var (registered by {@link registerOpponentPitVocabulary})
 * between `car-in` and `is-pitting`, so a pack keeps the number and rephrases
 * around it.
 *
 * **No `family` — queue, don't cut.** Same-family preemption replaces an
 * in-flight family-mate regardless of `interrupt: false`, and these five
 * contracts describe DIFFERENT cars: a pit train would truncate "The car
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
 * **Speak-time number (the #922 stash shape).** The nearby line's position
 * resolves through the `opponentPit.number` var from a module-scope stash
 * written by the nearby contract's own `where:` — AFTER the relation check,
 * and only when the opt-in wrappers already passed — so a later
 * `opponentPit.entered` of a different relation (even one whose own contract
 * is opt-in-suppressed) can never repoint a deferred nearby line at the wrong
 * car. The number prefers a live read through the injected resolver (the
 * plugins wire `getLiveCarPosition`), taken in the projection the event was
 * classified in (the payload's `isMultiClass`, so a transient session-info
 * dropout can't flip a multi-class read to overall space), and falls back to
 * the emit-time payload position. A missing stash aborts the whole callout at
 * expansion (#835) — never a fragment, which is why the script step is a
 * required var and not an optional clause.
 *
 * Session gating (race-only / replay-only / pre-green / post-race) lives in
 * the translator diff (`diff/opponent-pit.ts`), NOT here, so the contracts
 * stay harness-firable.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";
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
 * Register the vocabulary the opponent-pit script references (issue #1065):
 * the speak-time number var. Must run before the contracts are defined so the
 * first `setScripts` compile sees it.
 */
export function registerOpponentPitVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getLivePosition: OpponentPitLivePositionResolver = () => null,
): void {
  engine.defineVar(
    "opponentPit.number",
    () => {
      if (!pendingNearby) return null;

      const live = getLivePosition(pendingNearby);
      const n = live !== null && Number.isInteger(live) && live > 0 ? live : pendingNearby.position;

      return n > 0 ? poolRef(POSITION_NUMBER_GROUP, String(n)) : null;
    },
    'The pitting car\'s race position as a spoken number, drawn from the position-number group (position-number/4 is "P4"). Read live at speak time — class position in a multi-class race — and falling back to the position the event carried. Part of the sentence, so a number that cannot be resolved skips the whole line rather than leaving a gap.',
  );
}

function opponentPitContract(
  subject: "leader" | "ahead" | "behind" | "nearby" | "others",
  where?: (e: SimEventOf<"opponentPit.entered">) => boolean,
): ScenarioContract {
  return {
    id: `pit-crew.opponent-pit-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: OPPONENT_PIT_WEIGHT,
    interrupt: false,
    queueable: true,
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

export const OPPONENT_PIT_CONTRACTS: readonly ScenarioContract[] = [
  opponentPitContract("leader"),
  opponentPitContract("ahead"),
  opponentPitContract("behind"),
  opponentPitContract("nearby", (ev) => {
    const { carIdx, position, isMultiClass } = ev.data;

    // No usable car/position → nothing to speak; reject before firing. A
    // fractional position would build a `position-number/4.5` lookup with
    // no clip behind it, so non-negative integers only.
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

    // Stash AFTER the relation + validity checks and behind the opt-in
    // wrappers (#922's shape), so only a fully-gated nearby fire can
    // repoint what a deferred nearby line speaks.
    pendingNearby = { carIdx, position, isMultiClass: isMultiClass === true };

    return true;
  }),
  opponentPitContract("others"),
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

export const OPPONENT_PIT_SCENARIO_IDS: readonly string[] = OPPONENT_PIT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the opponent-pit script draws from — every
 * `pool:opponent-pit/<base>` the bundled script may write, as a literal list.
 * The completeness tests read it: the bundled voice must ship at least one
 * clip for each, and the bundled script must reference exactly this set. The
 * spoken number is not a source: it is the `opponentPit.number` var, drawn
 * from the `position-number` group at speak time.
 */
export const OPPONENT_PIT_CLIP_SOURCES: readonly { group: "opponent-pit"; base: string }[] = [
  { group: "opponent-pit", base: "leader" },
  { group: "opponent-pit", base: "ahead" },
  { group: "opponent-pit", base: "behind" },
  { group: "opponent-pit", base: "car-in" },
  { group: "opponent-pit", base: "is-pitting" },
  { group: "opponent-pit", base: "others" },
];
