/**
 * Race Engineer overtake callouts — issue #574 (split design, #574 follow-up).
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
 *      + `queueable: true` scenario that defers behind the reaction and then says
 *      "We're currently P[n]" reading the position from live telemetry at
 *      speak-time. Shares a cooldown with every other position readout so we
 *      don't double-announce.
 *
 * Both reaction scenarios share `family: "overtake"` (a fresh swap preempts an
 * in-flight family-mate) and are suppressed once the race is over
 * (`getRaceFinishedFired`) — no overtake commentary after the checkered.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
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

const OVERTAKE_BASE = "position-overtake";
const COME_ON_GROUP = "position-overtake-come-on";

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${OVERTAKE_BASE}/${filename}`;
}

/**
 * Effective overtake position (class in multi-class, overall otherwise) from a
 * step's `ctx.data`, or `null` for a null/absent payload (#603 podium lines).
 */
function effectiveOf(data: unknown): number | null {
  const d = data as SimEventOf<"overtake.completed">["data"] | null;

  return d != null ? selectEffectiveOvertakePosition(d) : null;
}

/** Whether a step's `ctx.data` is a multi-class overtake payload. */
function isMultiClassData(data: unknown): boolean {
  return Boolean((data as SimEventOf<"overtake.completed">["data"] | null)?.isMultiClass);
}

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
 * Register the overtake reaction vars. Only the loss line needs a var: the
 * full "Come on, <name>." clip resolved per active driver name. The gain
 * reaction is static clips and reads `isLeader` straight off the event payload
 * in its `if` step.
 */
export function registerOvertakeVars(engine: IScenarioEngine, getDriverName: OvertakeDriverNameResolver): void {
  engine.defineVar("overtake.lost.comeOn", () => {
    const name = getDriverName();

    return name ? poolRef(COME_ON_GROUP, name) : null;
  });
}

/**
 * Build the gained-overtake REACTION scenario. The position follow-up is a
 * separate scenario (see {@link buildOvertakeGainedPositionScenario} in
 * position-readout.ts). Suppressed after the race ends.
 */
export function buildOvertakeGainedScenario(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): Scenario {
  // Podium positions (P1/P2/P3, by EFFECTIVE position) each get a dedicated line
  // that states the position (issue #603); every other gain says the generic
  // "Nice pass". Each podium line has a single-class and a multi-class ("…in
  // class") variant. The `if` predicates read the live event payload (ctx.data)
  // — the reaction fires immediately, so the payload is current.
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    {
      if: (ctx) => effectiveOf(ctx.data) === 1,
      then: [
        {
          if: (ctx) => isMultiClassData(ctx.data),
          then: [clipPath("nice-pass-leader-class-01.mp3")],
          else: [clipPath("nice-pass-leader-01.mp3")],
        },
      ],
      else: [
        {
          if: (ctx) => effectiveOf(ctx.data) === 2,
          then: [
            {
              if: (ctx) => isMultiClassData(ctx.data),
              then: [clipPath("nice-pass-p2-class-01.mp3")],
              else: [clipPath("nice-pass-p2-01.mp3")],
            },
          ],
          else: [
            {
              if: (ctx) => effectiveOf(ctx.data) === 3,
              then: [
                {
                  if: (ctx) => isMultiClassData(ctx.data),
                  then: [clipPath("nice-pass-p3-class-01.mp3")],
                  else: [clipPath("nice-pass-p3-01.mp3")],
                },
              ],
              else: [clipPath("nice-pass-01.mp3")],
            },
          ],
        },
      ],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.overtake-gained",
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
    sequence,
  };
}

/** Build the lost-position REACTION scenario. Self-contained — position follow-up is separate. */
export function buildOvertakeLostScenario(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    // Optional (issue #835): the "Come on, <name>." opener is a complete
    // sentence on its own — a voice lacking the name clip (or an unwired
    // resolver) skips it and the loss line still plays.
    { optional: [{ var: "overtake.lost.comeOn" }] },
    clipPath("dont-give-up-positions-01.mp3"),
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.overtake-lost",
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
    sequence,
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

// Both the reaction AND the position-readout scenario id for each direction map
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
