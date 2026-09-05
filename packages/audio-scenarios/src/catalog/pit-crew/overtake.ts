/**
 * Race Engineer overtake callouts — issue #574 (split design, #574
 * follow-up); scripted since #1065.
 *
 * Each overtake produces TWO announcements, deliberately separated so the
 * position is spoken from LIVE telemetry at the moment it's said:
 *
 *   1. **Reaction** (this file) — fires immediately on the bus event:
 *      - gained, non-leader: "Nice pass."
 *      - gained, leader: "Nice pass! We're now leading the race. Let's keep it
 *        that way!" (self-contained — states the position, so it gets NO
 *        follow-up readout). In a multi-class race the leader line is keyed on
 *        CLASS position and reads "…leading our class…" (issue #599); leader is
 *        the EFFECTIVE leader (class P1 in multi-class, overall P1 otherwise),
 *        not the overall-only `isLeader` payload flag.
 *      - lost: "Come on, <name>. Don't give up positions like that." (the
 *        "Come on, <name>." part is a per-name full clip from the
 *        `position-overtake-come-on` group; #591)
 *
 *   2. **Position readout** (position-readout.ts) — a separate `WEIGHT.CHATTER`
 *      + `queueable: true` contract that defers behind the reaction and then says
 *      "We're currently P[n]" reading the position from live telemetry at
 *      speak-time. Shares a cooldown with every other position readout so we
 *      don't double-announce.
 *
 * The code decides WHETHER and WHEN a reaction fires; WHAT it says is the
 * active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.overtake-gained"]`, `…-lost`), paired at `setScripts`
 * time. The gained reaction is ONE `case` on `overtake.gainedReaction`: the
 * six nested closure `if`s it replaces were a lookup over a closed set —
 * which podium place, in class or overall — and a case with a declared key
 * set is what lets a pack phrase each independently or collapse the class
 * variants onto the overall lines. The lost reaction is the optional
 * `overtake.lost.comeOn` clause (a complete sentence on its own) followed by
 * `pool:position-overtake/dont-give-up-positions`. The vocabulary is
 * registered by {@link registerOvertakeVocabulary}.
 *
 * Both reaction contracts share `family: "overtake"` (a fresh swap preempts an
 * in-flight family-mate) and are suppressed once the race is over
 * (`getRaceFinishedFired`) — no overtake commentary after the checkered.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { overtakeContextAllows, type OvertakeGateResolver } from "./overtake-gate.js";
import { shouldReactToOvertake } from "./position-readout.js";

/**
 * Resolver for the active driver name. Plugins wire this to
 * `resolveActiveDriverName(driverNames, "driver")` — returns the user-picked
 * name when valid, the pre-recorded `"driver"` fallback otherwise, or `null`
 * only when no driver-name clips exist at all.
 */
export type OvertakeDriverNameResolver = () => string | null;

const COME_ON_GROUP = "position-overtake-come-on";

/**
 * Pick the effective overall vs class position from an overtake payload.
 * Multi-class series → class fields; single-class (or unknown) → overall.
 * Returns `null` when the chosen current position is missing.
 */
function selectEffectiveOvertakePosition(data: {
  position: number;
  classPosition?: number;
  isMultiClass?: boolean;
}): number | null {
  const useClass = data.isMultiClass === true;
  const current = useClass ? data.classPosition : data.position;

  return typeof current === "number" && current > 0 ? current : null;
}

/**
 * Whether an `overtake.completed` payload should produce an audible reaction.
 * The effective position must be known; whether it is *speakable* derives
 * from the clips that exist for the active voice (issues #835/#836). The
 * translator has already enforced race-only / hold / gap / sim-glitch
 * suppression.
 */
export function overtakeGainIsAnnounceable(data: SimEventOf<"overtake.completed">["data"]): boolean {
  return selectEffectiveOvertakePosition(data) !== null;
}

/** Symmetric with {@link overtakeGainIsAnnounceable} for the loss side. */
export function overtakeLossIsAnnounceable(data: SimEventOf<"overtake.lost">["data"]): boolean {
  return selectEffectiveOvertakePosition(data) !== null;
}

/**
 * The keys of the `overtake.gainedReaction` case — the closed set of
 * reactions a gained overtake takes. Published with the case, so the type is
 * the declared key set and nothing else.
 */
export type OvertakeGainedReaction = "leader" | "leader-class" | "p2" | "p2-class" | "p3" | "p3-class" | "other";

/**
 * The declared key set of `overtake.gainedReaction`, each with the
 * description the generated reference (#1066) shows a pack author.
 *
 * @internal Exported for testing — the test enumerates the reachable
 * payloads and checks the resolver returns nothing outside this set.
 */
export const OVERTAKE_GAINED_REACTION_KEYS: Readonly<Record<OvertakeGainedReaction, string>> = {
  leader: "The pass took the overall lead of a single-class race.",
  "leader-class": "The pass took the class lead in a multi-class race.",
  p2: "The pass put the driver second overall in a single-class race.",
  "p2-class": "The pass put the driver second in class in a multi-class race.",
  p3: "The pass put the driver third overall in a single-class race — onto the podium.",
  "p3-class": "The pass put the driver third in class in a multi-class race.",
  other: "Any other position — the plain nice-pass line; the position itself follows in the separate readout.",
};

/**
 * The reaction key for a gained overtake, read from the fire's event payload
 * (the reaction fires immediately, so the payload is current): the effective
 * position — class P1/2/3 in multi-class, overall otherwise (#588/#599) —
 * picks the podium line, and `isMultiClass` picks the "…in class" variant.
 *
 * Answers only for an `overtake.completed` fire. A pack may name the case
 * from any entry, and the lost line's `overtake.lost` payload carries the
 * same position fields — an unguarded read would call a drop to P2 a podium
 * pass. For any other fire, an imperative one included, the resolver returns
 * `null`: the case then takes the script's `default` branch if the entry
 * declares one, else contributes nothing. The bundled gained entry declares
 * no `default`, because its contract's `where:` guarantees the payload.
 *
 * @internal Exported for testing.
 */
export function resolveOvertakeGainedReaction(ctx: ScenarioContext): OvertakeGainedReaction | null {
  if (ctx.event?.event !== "overtake.completed") return null;

  const data = ctx.data as SimEventOf<"overtake.completed">["data"] | null | undefined;

  if (data == null) return null;

  const effective = selectEffectiveOvertakePosition(data);
  const inClass = data.isMultiClass === true;

  if (effective === 1) return inClass ? "leader-class" : "leader";

  if (effective === 2) return inClass ? "p2-class" : "p2";

  if (effective === 3) return inClass ? "p3-class" : "p3";

  return "other";
}

/**
 * Register the vocabulary the overtake scripts reference (issue #1065): the
 * gained-reaction case and the loss line's per-name opener. Must run before
 * the contracts are defined so the first `setScripts` compile sees them.
 */
export function registerOvertakeVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCase">,
  getDriverName: OvertakeDriverNameResolver,
): void {
  engine.defineCase(
    "overtake.gainedReaction",
    resolveOvertakeGainedReaction,
    OVERTAKE_GAINED_REACTION_KEYS,
    "Which reaction a gained overtake earns: a podium place (first, second or third) taken overall or in class, or any other position. Exactly one key applies per pass.",
  );

  engine.defineVar(
    "overtake.lost.comeOn",
    () => {
      const name = getDriverName();

      return name ? poolRef(COME_ON_GROUP, name) : null;
    },
    'The "Come on, <name>." opener of the lost-position line, a full clip per driver name from the position-overtake-come-on group (position-overtake-come-on/driver is the generic fallback). A complete sentence on its own, so the bundled script makes it optional: a voice without the chosen name\'s clip skips it and the line still plays.',
  );
}

/**
 * Build the gained-overtake REACTION contract. The position follow-up is a
 * separate contract (see {@link buildOvertakeGainedPositionContract} in
 * position-readout.ts). Suppressed after the race ends.
 */
export function buildOvertakeGainedContract(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.overtake-gained",
    description:
      "You gain a place in a race and hold it for a few seconds in a clean moment — always for a podium place, about one time in three otherwise, and never when the car ahead simply retired.",
    when: {
      event: "overtake.completed",
      where: (ev) => {
        if (ev.event !== "overtake.completed") return false;

        const data = ev.data as SimEventOf<"overtake.completed">["data"];

        if (getRaceFinishedFired()) return false;

        if (!overtakeGainIsAnnounceable(data)) return false;

        // Clean-racing-moment gate (cars alongside / off-track / slow / pit /
        // recent incident), both directions.
        if (!overtakeContextAllows(getGate())) return false;

        // Retirement-driven gain (a non-finished car ahead left the world): the
        // position readout still fires, but never the celebratory "Nice pass"
        // for a pass that didn't happen (issue #603).
        if (data.fromRetirement === true) return false;

        // Podium (P1/P2/P3) always reacts; every other gain ~1 in 3 (issue
        // #603). Effective position = class P1/2/3 in multi-class, overall
        // otherwise (#588/#599). The position readout fires regardless.
        const effective = selectEffectiveOvertakePosition(data);

        return effective !== null && shouldReactToOvertake(effective);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "overtake",
  };
}

/** Build the lost-position REACTION contract. Self-contained — position follow-up is separate. */
export function buildOvertakeLostContract(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.overtake-lost",
    description:
      "You lose a place in a race and the drop holds for a few seconds in a clean moment — always when it costs you a podium place, about one time in three otherwise.",
    when: {
      event: "overtake.lost",
      where: (ev) => {
        if (ev.event !== "overtake.lost") return false;

        if (getRaceFinishedFired()) return false;

        const data = ev.data as SimEventOf<"overtake.lost">["data"];

        if (!overtakeLossIsAnnounceable(data)) return false;

        if (!overtakeContextAllows(getGate())) return false;

        // Podium (P1/P2/P3) always reacts — losing or defending a podium spot is
        // always worth a word; every other loss ~1 in 3 (issue #603).
        const effective = selectEffectiveOvertakePosition(data);

        return effective !== null && shouldReactToOvertake(effective);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "overtake",
  };
}

/**
 * Stable identifier for each user-toggleable overtake callout (issue #574).
 * One id per direction — the opt-in covers both the reaction and the position
 * readout for that direction.
 */
export type OvertakeCalloutId = "gained" | "lost";

/**
 * Canonical mapping from `OvertakeCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`.
 */
export const OVERTAKE_CALLOUT_SETTING_KEYS: Record<OvertakeCalloutId, string> = {
  gained: "calloutEnabledOvertakeGained",
  lost: "calloutEnabledOvertakeLost",
};

// Both the reaction AND the position-readout contract id for each direction map
// to the same opt-in, so one toggle silences both. `as const` powers the
// compile-time completeness check on `SCENARIO_ID_TO_OVERTAKE_ID`.
export const OVERTAKE_SCENARIO_IDS = [
  "pit-crew.overtake-gained",
  "pit-crew.overtake-lost",
  "pit-crew.overtake-gained-position",
  "pit-crew.overtake-lost-position",
] as const;

export const SCENARIO_ID_TO_OVERTAKE_ID: Record<(typeof OVERTAKE_SCENARIO_IDS)[number], OvertakeCalloutId> = {
  "pit-crew.overtake-gained": "gained",
  "pit-crew.overtake-lost": "lost",
  "pit-crew.overtake-gained-position": "gained",
  "pit-crew.overtake-lost-position": "lost",
};

/**
 * The clip sources the overtake reaction scripts draw from — every
 * `pool:position-overtake/<base>` the bundled script may write, as a literal
 * list. The completeness tests read it: the bundled voice must ship at least
 * one clip for each, and the bundled script must reference exactly this set.
 * The per-name "Come on" opener is not a source: it is the
 * `overtake.lost.comeOn` var, drawn from `position-overtake-come-on` by the
 * chosen driver name.
 */
export const OVERTAKE_CLIP_SOURCES: readonly { group: "position-overtake"; base: string }[] = [
  { group: "position-overtake", base: "nice-pass" },
  { group: "position-overtake", base: "nice-pass-leader" },
  { group: "position-overtake", base: "nice-pass-leader-class" },
  { group: "position-overtake", base: "nice-pass-p2" },
  { group: "position-overtake", base: "nice-pass-p2-class" },
  { group: "position-overtake", base: "nice-pass-p3" },
  { group: "position-overtake", base: "nice-pass-p3-class" },
  { group: "position-overtake", base: "dont-give-up-positions" },
];
