/**
 * Shared "current position" readout — issue #574 follow-up.
 *
 * The Race Engineer's "We're currently P[n]" line is spoken by several
 * triggers: an overtake gain, an overtake loss, a race lap-completion
 * (position-change, #566), and the every-3-laps race-status cadence (#569).
 * Two cross-cutting requirements unify them and live here:
 *
 *   1. **Live telemetry at speak-time.** The position number is read from a
 *      {@link LivePositionResolver} (the plugin wires it to `getLivePosition()`
 *      from `@iracedeck/sim-events-iracing`) INSIDE the `{ var }` resolver,
 *      which the engine runs at sequence-expansion time — the moment the clip
 *      is about to play, after any deferral behind another callout. So the
 *      spoken position is accurate to the moment it's said, not frozen at the
 *      triggering event (a `<break>` in the clip or a `{ pause }` step can't
 *      achieve this — both resolve the number before the wait).
 *
 *   2. **Shared cooldown.** Once a position has been announced (by ANY
 *      trigger), {@link POSITION_READOUT_COOLDOWN_MS} suppresses the next
 *      position announcement from a DIFFERENT trigger — so an overtake readout
 *      immediately followed by a lap-completion readout doesn't double up. The
 *      cooldown is claimed atomically in the scenario's `where:` via
 *      {@link tryClaimPositionAnnouncement} as the LAST gate (after every other
 *      condition passes). All position readouts are `priority: "low"`, which
 *      the engine defers-and-replays rather than drops, so a claim at decision
 *      time always results in an actual announcement — no phantom cooldowns.
 *
 * The two overtake readout scenarios live here (the reaction lines stay in
 * overtake.ts); the race position-change and race-status scenarios import the
 * cooldown + live helpers and use them in their race branch.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { overtakeContextAllows, type OvertakeGateResolver } from "./overtake-gate.js";
import { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN, positionNumberIsSpeakable } from "./position-range.js";

export { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN };
export { type OvertakeGate, type OvertakeGateResolver, overtakeContextAllows } from "./overtake-gate.js";

/**
 * Live position snapshot resolved at speak-time. Structurally matches
 * `LivePosition` exported by `@iracedeck/sim-events-iracing` — the plugin's
 * resolver returns that, this package stays sim-agnostic via the structural
 * shape.
 */
export type LivePosition = { position: number; classPosition: number; isMultiClass: boolean };

/** Resolver the plugin wires to `getLivePosition()`. `null` = position not readable right now. */
export type LivePositionResolver = () => LivePosition | null;

/** Cooldown (ms) between successive position announcements across ALL triggers. */
export const POSITION_READOUT_COOLDOWN_MS = 20_000;

/**
 * Cooldown (ms) for the overtake REACTION catchphrase ("Nice pass" / "Come on,
 * don't give up positions"), per direction (issue #574 follow-up). When a
 * catchphrase is on cooldown the reaction is skipped but the position readout
 * still fires — so a battle gives "Nice pass. We're currently P5." then just
 * "We're currently P4." on the next pass, instead of repeating the catchphrase.
 */
export const REACTION_COOLDOWN_MS = 20_000;

const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_NUMBER = "position-number";

/** Static "We're currently" intro clip path, relative to the `voice/{voice}` base. */
export const POSITION_CURRENTLY_CLIP = `${POSITION_GROUP_INTRO_WORSE}/currently-01.mp3`;

let lastPositionAnnouncedAt = 0;
const lastReactionAt: Record<"gained" | "lost", number> = { gained: 0, lost: 0 };

/** Read-only check of whether the position cooldown window has elapsed. */
export function canAnnouncePosition(now: number = Date.now()): boolean {
  return lastPositionAnnouncedAt === 0 || now - lastPositionAnnouncedAt >= POSITION_READOUT_COOLDOWN_MS;
}

/**
 * Atomic check-and-set for the shared position cooldown: returns `true` and
 * starts a fresh window iff the previous announcement is older than
 * {@link POSITION_READOUT_COOLDOWN_MS}. Used by the lap-completed and
 * race-status readouts (which DEFER to a recent announcement). The overtake
 * readout instead always fires and only {@link markPositionAnnounced}s.
 */
export function tryClaimPositionAnnouncement(now: number = Date.now()): boolean {
  if (!canAnnouncePosition(now)) return false;

  lastPositionAnnouncedAt = now;

  return true;
}

/**
 * Start a fresh position-cooldown window without checking it. The overtake
 * position readout ALWAYS fires (a pass is always worth stating the position
 * for, issue #574), so it marks the cooldown to defer the lap-completed /
 * race-status readouts rather than claiming it.
 */
export function markPositionAnnounced(now: number = Date.now()): void {
  lastPositionAnnouncedAt = now;
}

/**
 * Atomic check-and-set for the per-direction reaction-catchphrase cooldown.
 * Returns `true` (and starts a fresh window) iff the catchphrase for this
 * direction hasn't played within {@link REACTION_COOLDOWN_MS}.
 */
export function tryClaimReaction(direction: "gained" | "lost", now: number = Date.now()): boolean {
  const last = lastReactionAt[direction];

  if (last !== 0 && now - last < REACTION_COOLDOWN_MS) return false;

  lastReactionAt[direction] = now;

  return true;
}

/** Reset all position + reaction cooldowns. @internal test isolation only. */
export function _resetPositionReadoutCooldown(): void {
  lastPositionAnnouncedAt = 0;
  lastReactionAt.gained = 0;
  lastReactionAt.lost = 0;
}

/**
 * Effective position number from a live snapshot: class in multi-class series,
 * overall otherwise. `null` when the chosen field is missing.
 */
export function selectLivePosition(live: LivePosition | null): number | null {
  if (!live) return null;

  const n = live.isMultiClass ? live.classPosition : live.position;

  return n > 0 ? n : null;
}

/** Whether the live position is currently in the speakable clip range. */
export function liveCurrentlyAnnounceable(live: LivePosition | null): boolean {
  const n = selectLivePosition(live);

  return n !== null && positionNumberIsSpeakable(n);
}

/**
 * Whether an overtake payload represents the player leading their **effective**
 * field — class P1 in a multi-class race, overall P1 otherwise (issue #599).
 * The overtake `isLeader` field is OVERALL-only, so a class leader running
 * mid-pack overall reads `isLeader: false`; this helper keeps the leader
 * concept aligned with the class-focused detection (#588) and readout. Shared
 * by the overtake reaction (picks the "leading our class" line) and the gained
 * position readout (suppresses the follow-up, since the leader line already
 * states the position). Lives here, the lower-level shared module, so
 * `overtake.ts` can import it without a cycle.
 */
export function isOvertakeEffectiveLeader(data: {
  position: number;
  classPosition?: number;
  isMultiClass?: boolean;
}): boolean {
  const effective = data.isMultiClass === true ? data.classPosition : data.position;

  return effective === 1;
}

function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/**
 * Register the shared live-position number var. Reads the live resolver at
 * expansion time and returns the `position-number/<N>` clip; returns `null` (a
 * no-op step) when the live position is unavailable or out of range — the
 * scenario's `where:` already gates this, the null is a defensive guard. The
 * cooldown is NOT marked here — it's claimed in `where:` via
 * {@link tryClaimPositionAnnouncement}.
 */
export function registerPositionReadoutVars(engine: IScenarioEngine, getLivePosition: LivePositionResolver): void {
  engine.defineVar("positionReadout.number", () => {
    const n = selectLivePosition(getLivePosition());

    if (n === null || !positionNumberIsSpeakable(n)) return null;

    return voicePath(POSITION_GROUP_NUMBER, String(n));
  });
}

/** Shared readout sequence: radio frame + "We're currently" + live number. */
function readoutSequence(): Step[] {
  return ["@pit-crew.radio-open", POSITION_CURRENTLY_CLIP, { var: "positionReadout.number" }, "@pit-crew.radio-close"];
}

/**
 * Build the position readout that follows a GAINED-overtake reaction (issue
 * #574). Fires on `overtake.completed` but reads LIVE position at speak-time.
 * `priority: "low"` + `family: "position-readout"` so it defers behind the
 * reaction (normal, `family: "overtake"`) and plays once the bus is idle — the
 * "two announcements" the user asked for. Skips the leader case (the leader
 * reaction already states the position).
 *
 * The position ALWAYS fires on a (gate-allowed) overtake — it does not check
 * the position cooldown, only {@link markPositionAnnounced}s it so the
 * lap-completed / race-status readouts defer behind it. Suppressed after the
 * race ends and whenever {@link overtakeContextAllows} fails (cars alongside,
 * off-track, crawling, pit road, recent incident).
 */
export function buildOvertakeGainedPositionScenario(
  getLivePosition: LivePositionResolver,
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): Scenario {
  return {
    id: "pit-crew.overtake-gained-position",
    when: {
      event: "overtake.completed",
      where: (ev) => {
        if (ev.event !== "overtake.completed") return false;

        const data = ev.data as SimEventOf<"overtake.completed">["data"];

        // Leader reaction ("We're now leading the race/our class") already
        // states the position. Effective leader = class P1 in multi-class,
        // overall P1 otherwise (#599).
        if (isOvertakeEffectiveLeader(data)) return false;

        // No position calling once the race is over.
        if (getRaceFinishedFired()) return false;

        // Clean-racing-moment gate (cars alongside / off-track / slow / pit /
        // recent incident) — applies to both directions.
        if (!overtakeContextAllows(getGate())) return false;

        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // Always fires; just mark the cooldown so lap/race-status defer.
        markPositionAnnounced();

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "low",
    family: "position-readout",
    sequence: readoutSequence(),
  };
}

/** Build the position readout that follows a LOST-overtake reaction (issue #574). */
export function buildOvertakeLostPositionScenario(
  getLivePosition: LivePositionResolver,
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): Scenario {
  return {
    id: "pit-crew.overtake-lost-position",
    when: {
      event: "overtake.lost",
      where: (ev) => {
        if (ev.event !== "overtake.lost") return false;

        if (getRaceFinishedFired()) return false;

        if (!overtakeContextAllows(getGate())) return false;

        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        markPositionAnnounced();

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "low",
    family: "position-readout",
    sequence: readoutSequence(),
  };
}

export const OVERTAKE_POSITION_SCENARIO_IDS = [
  "pit-crew.overtake-gained-position",
  "pit-crew.overtake-lost-position",
] as const;
