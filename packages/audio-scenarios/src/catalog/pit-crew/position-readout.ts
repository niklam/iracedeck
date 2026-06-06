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
 *      condition passes). All position readouts are `weight: WEIGHT.CHATTER` +
 *      `queueable: true`, which the engine defers-and-replays rather than drops,
 *      so a claim at decision time always results in an actual announcement — no
 *      phantom cooldowns.
 *
 * The two overtake readout scenarios live here (the reaction lines stay in
 * overtake.ts); the race position-change and race-status scenarios import the
 * cooldown + live helpers and use them in their race branch.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { WEIGHT } from "../../dsl.js";
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
 * Probability that an ORDINARY (non-podium) overtake gain/loss adds the spoken
 * reaction catchphrase ("Nice pass" / "Come on, don't give up positions")
 * (issue #603). Replaces the old fixed 20 s reaction cooldown: most passes now
 * get just the position readout, and roughly one in three also gets the
 * catchphrase, so a busy mid-pack battle doesn't repeat "Nice pass" on every
 * swap. Podium positions (P1/P2/P3) bypass this gate entirely — see
 * {@link shouldReactToOvertake}.
 */
export const REACTION_CHANCE = 1 / 3;

/** Highest position that always reacts, exempt from the random gate (podium). */
export const REACTION_ALWAYS_MAX_POSITION = 3;

/**
 * Cooldown (ms) for the "We're currently" intro on the position readout (issue
 * #603). If the intro was spoken within this window, the readout drops it and
 * says just the bare position ("P[n]"); otherwise it says the full "We're
 * currently P[n]". A change of more than one position always restores the full
 * intro even inside the window — see the `positionReadout.intro` var.
 */
export const INTRO_COOLDOWN_MS = 30_000;

const POSITION_GROUP_INTRO_WORSE = "position-intro-worse";
const POSITION_GROUP_NUMBER = "position-number";

/** Static "We're currently" intro clip path, relative to the `voice/{voice}` base. */
export const POSITION_CURRENTLY_CLIP = `${POSITION_GROUP_INTRO_WORSE}/currently-01.mp3`;

let lastPositionAnnouncedAt = 0;
/** Last time the "We're currently" intro was spoken (issue #603 bare/full logic). */
let lastIntroAt = 0;
/** Last position number actually spoken by a readout (issue #603 bare/full delta). */
let lastSpokenPosition = 0;
/** Injectable RNG for the reaction gate — overridable in tests. */
let reactionRandom: () => number = Math.random;

/** Read-only check of whether the position cooldown window has elapsed. */
export function canAnnouncePosition(now: number = Date.now()): boolean {
  return lastPositionAnnouncedAt === 0 || now - lastPositionAnnouncedAt >= POSITION_READOUT_COOLDOWN_MS;
}

/**
 * Atomic check-and-set for the shared position cooldown: returns `true` and
 * starts a fresh window iff the previous announcement is older than
 * {@link POSITION_READOUT_COOLDOWN_MS}. Claimed by EVERY position readout — the
 * two overtake readouts, the lap-completed readout, and the race-status readout
 * — as the LAST gate. Whichever fires first claims the window; the rest return
 * `false` and defer, so the position is never spoken twice (issue #651), even
 * when the spotter focus floor delays a readout's actual playback by seconds.
 * The position NUMBER is read live at speak-time, so the single surviving
 * readout still states the current position.
 */
export function tryClaimPositionAnnouncement(now: number = Date.now()): boolean {
  if (!canAnnouncePosition(now)) return false;

  lastPositionAnnouncedAt = now;

  return true;
}

/**
 * Whether an overtake gain/loss should speak the reaction catchphrase (issue
 * #603). Podium positions (P1/P2/P3, by EFFECTIVE position) always react —
 * gaining or defending a podium spot is always worth a word. Every other
 * position rolls {@link REACTION_CHANCE} (~1 in 3); when it loses, only the
 * position readout fires. The position readout itself is a separate scenario
 * and is unaffected by this gate.
 */
export function shouldReactToOvertake(effectivePosition: number): boolean {
  if (effectivePosition >= 1 && effectivePosition <= REACTION_ALWAYS_MAX_POSITION) return true;

  return reactionRandom() < REACTION_CHANCE;
}

/**
 * Decide whether a position readout should speak the full "We're currently"
 * intro or just the bare "P[n]" (issue #603), and record this readout as the
 * latest. The intro plays when: nothing has been spoken yet, the last intro was
 * more than {@link INTRO_COOLDOWN_MS} ago, or the position changed by more than
 * one since the last readout (a multi-position jump always gets the full intro,
 * even inside the window). Otherwise the intro is dropped for the bare number.
 * Has the side effect of advancing the intro/last-position trackers, so call it
 * exactly once per readout (from the `positionReadout.intro` var).
 */
export function shouldSpeakIntro(currentPosition: number, now: number = Date.now()): boolean {
  const useIntro =
    lastSpokenPosition <= 0 ||
    now - lastIntroAt >= INTRO_COOLDOWN_MS ||
    Math.abs(currentPosition - lastSpokenPosition) > 1;

  if (useIntro) lastIntroAt = now;

  lastSpokenPosition = currentPosition;

  return useIntro;
}

/**
 * Override the reaction-gate RNG. @internal test isolation only — pass a stub
 * returning a fixed value to make {@link shouldReactToOvertake} deterministic.
 */
export function _setReactionRandom(rng: () => number): void {
  reactionRandom = rng;
}

/** Reset all position-readout cooldowns + reaction RNG. @internal test isolation only. */
export function _resetPositionReadoutCooldown(): void {
  lastPositionAnnouncedAt = 0;
  lastIntroAt = 0;
  lastSpokenPosition = 0;
  reactionRandom = Math.random;
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
  // "We're currently" intro — resolves to the intro clip when due, or `null` (a
  // no-op step, leaving a bare "P[n]") inside the 30 s window for a ≤1-position
  // move (issue #603). Runs before the number var in the sequence so it reads
  // the previous spoken position for the delta and records this one.
  engine.defineVar("positionReadout.intro", () => {
    const n = selectLivePosition(getLivePosition());

    if (n === null || !positionNumberIsSpeakable(n)) return null;

    return shouldSpeakIntro(n) ? voicePath(POSITION_GROUP_INTRO_WORSE, "currently-01") : null;
  });

  engine.defineVar("positionReadout.number", () => {
    const n = selectLivePosition(getLivePosition());

    if (n === null || !positionNumberIsSpeakable(n)) return null;

    return voicePath(POSITION_GROUP_NUMBER, String(n));
  });
}

/**
 * Shared readout sequence: radio frame + (conditional) "We're currently" intro
 * + live number. The intro var drops to a bare "P[n]" inside the 30 s intro
 * window (issue #603).
 */
function readoutSequence(): Step[] {
  return [
    "@pit-crew.radio-open",
    { var: "positionReadout.intro" },
    { var: "positionReadout.number" },
    "@pit-crew.radio-close",
  ];
}

/**
 * Build the position readout that follows a GAINED-overtake reaction (issue
 * #574). Fires on `overtake.completed` but reads LIVE position at speak-time.
 * `weight: WEIGHT.CHATTER` + `queueable: true` + `family: "position-readout"` so
 * it defers behind the reaction (default `WEIGHT.NORMAL`, `family: "overtake"`)
 * and plays once the bus is idle — the "two announcements" the user asked for.
 * Skips podium gains (P1/P2/P3): their
 * dedicated reaction lines already state the position (issue #603).
 *
 * Claims the shared position cooldown via {@link tryClaimPositionAnnouncement}
 * as the last gate, so a position already announced by any trigger (another
 * overtake, a lap-completed, or a race-status readout — possibly delayed by the
 * spotter focus floor) suppresses this readout instead of doubling it up (issue
 * #651). The reaction catchphrase is a separate scenario and still plays.
 * Suppressed after the race ends and whenever {@link overtakeContextAllows}
 * fails (cars alongside, off-track, crawling, pit road, recent incident).
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

        // Podium gains (P1/P2/P3) get a dedicated reaction line that already
        // states the position ("leading", "up to second/third"), so skip the
        // follow-up readout for them (issue #603). Effective position = class
        // P1/2/3 in multi-class, overall otherwise (#588/#599).
        const effective = data.isMultiClass === true ? data.classPosition : data.position;

        if (typeof effective === "number" && effective >= 1 && effective <= REACTION_ALWAYS_MAX_POSITION) return false;

        // No position calling once the race is over.
        if (getRaceFinishedFired()) return false;

        // Clean-racing-moment gate (cars alongside / off-track / slow / pit /
        // recent incident) — applies to both directions.
        if (!overtakeContextAllows(getGate())) return false;

        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // Claim the shared cooldown as the LAST gate: if a position was just
        // announced (another overtake, a lap-completed, or a race-status readout,
        // possibly deferred by the spotter focus floor), defer to it so the
        // position is never spoken twice (issue #651). The reaction catchphrase
        // is a separate scenario and still plays.
        return tryClaimPositionAnnouncement();
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
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

        // Same shared-cooldown claim as the gained readout — never double up the
        // position (issue #651). The loss reaction catchphrase still plays.
        return tryClaimPositionAnnouncement();
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "position-readout",
    sequence: readoutSequence(),
  };
}

export const OVERTAKE_POSITION_SCENARIO_IDS = [
  "pit-crew.overtake-gained-position",
  "pit-crew.overtake-lost-position",
] as const;
