/**
 * Race Engineer overtake callouts — issue #574 (split design, #574 follow-up).
 *
 * Each overtake produces TWO announcements, deliberately separated so the
 * position is spoken from LIVE telemetry at the moment it's said:
 *
 *   1. **Reaction** (this file) — fires immediately on the bus event:
 *      - gained, non-leader: "Nice pass."
 *      - gained, leader (`isLeader`): "Nice pass! We're now leading race.
 *        Let's keep it that way!" (self-contained — states the position, so it
 *        gets NO follow-up readout)
 *      - lost: "Come on, <name>. Don't give up positions like that." (the
 *        "Come on, <name>." part is a per-name full clip from the
 *        `position-overtake-come-on` group; #591)
 *
 *   2. **Position readout** (position-readout.ts) — a separate `low`-priority
 *      scenario that defers behind the reaction and then says "We're currently
 *      P[n]" reading the position from live telemetry at speak-time. Shares a
 *      cooldown with every other position readout so we don't double-announce.
 *
 * Both reaction scenarios share `family: "overtake"` (a fresh swap preempts an
 * in-flight family-mate) and are suppressed once the race is over
 * (`getRaceFinishedFired`) — no overtake commentary after the checkered.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { overtakeContextAllows, type OvertakeGateResolver } from "./overtake-gate.js";
import { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN, positionNumberIsSpeakable } from "./position-range.js";
import { tryClaimReaction } from "./position-readout.js";

/**
 * Resolver for the active driver name. Plugins wire this to
 * `resolveActiveDriverName(driverNames, "driver")` — returns the user-picked
 * name when valid, the pre-recorded `"driver"` fallback otherwise, or `null`
 * only when no driver-name clips exist at all.
 */
export type OvertakeDriverNameResolver = () => string | null;

const OVERTAKE_BASE = "position-overtake";
const COME_ON_GROUP = "position-overtake-come-on";

/** Build a full `voice/{voice}/...` path for a `var` resolver (no base applied). */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${OVERTAKE_BASE}/${filename}`;
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
 * The effective position must be inside the speakable range; the translator
 * has already enforced race-only / hold / gap / sim-glitch suppression.
 */
export function overtakeGainIsAnnounceable(data: SimEventOf<"overtake.completed">["data"]): boolean {
  const current = selectEffectiveOvertakePosition(data);

  return current !== null && positionNumberIsSpeakable(current);
}

/** Symmetric with {@link overtakeGainIsAnnounceable} for the loss side. */
export function overtakeLossIsAnnounceable(data: SimEventOf<"overtake.lost">["data"]): boolean {
  const current = selectEffectiveOvertakePosition(data);

  return current !== null && positionNumberIsSpeakable(current);
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

    return name ? voicePath(COME_ON_GROUP, name) : null;
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
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    {
      // `isLeader` is read straight off the event payload (ctx.data) — the
      // reaction fires immediately so the payload is the live event.
      if: (ctx) => Boolean((ctx.data as SimEventOf<"overtake.completed">["data"] | null)?.isLeader),
      then: [clipPath("nice-pass-leader-01.mp3")],
      else: [clipPath("nice-pass-01.mp3")],
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

        // Taking the lead is momentous — always announce, exempt from the
        // catchphrase cooldown. Otherwise throttle the "Nice pass" catchphrase
        // (the position readout still fires regardless).
        if (data.isLeader) return true;

        return tryClaimReaction("gained");
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
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
    { var: "overtake.lost.comeOn" },
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

        if (!overtakeLossIsAnnounceable(ev.data as SimEventOf<"overtake.lost">["data"])) return false;

        if (!overtakeContextAllows(getGate())) return false;

        return tryClaimReaction("lost");
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
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

export { POSITION_NUMBER_MAX as OVERTAKE_POSITION_MAX, POSITION_NUMBER_MIN as OVERTAKE_POSITION_MIN };
