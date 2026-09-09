/**
 * Shared "current position" readout — issue #574 follow-up; scripted since
 * #1065.
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
 *      immediately followed by a lap-completion readout doesn't double up. Each
 *      contract's `where:` reads the window with the pure
 *      {@link canAnnouncePosition} and its `speakGate` claims it with
 *      {@link tryClaimPositionAnnouncement} (issue #1137) — after the script
 *      expanded and immediately before the ops take the bus, so a claim is
 *      always made for a readout that will actually be said. It used to be
 *      claimed in `where:` on the strength of `queueable: true` meaning the
 *      fire could only be deferred, never dropped; #835 then made a null
 *      REQUIRED var abort the expansion, and the claim outlived the callout.
 *
 * The two overtake readout contracts live here (the reaction lines stay in
 * overtake.ts); the race position-change and race-status contracts import the
 * cooldown + live helpers and use them in their race branch.
 *
 * The code decides WHETHER and WHEN a readout fires; WHAT it says is the
 * active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.overtake-gained-position"]`, `…-lost-position`),
 * paired at `setScripts` time. The bundled script is
 * `[{ optional: ["{{positionReadout.intro}}"] }, "{{positionReadout.number}}"]`
 * — the vars registered by {@link registerPositionReadoutVocabulary}.
 *
 * **Why the intro is an optional clause (the #603 / #835 boundary).** #603
 * designed `positionReadout.intro` to resolve to NOTHING inside the 30 s
 * intro window for a ≤1-position move, leaving the bare "P[n]" — under the
 * engine of that day a null var was a no-op step. #835 later made a null
 * REQUIRED var abort the whole callout, and did not touch this file, so
 * from that release on the bare-number path produced silence instead: the
 * readout claimed the shared cooldown in `where:` and then played nothing
 * (the claim moved to the speak-time gate in #1137, so an abort now costs
 * only its own silence).
 * The script restores what #603 documented — "We're currently" is a lead-in
 * to a number that is a true, complete statement without it ("P four" is
 * the designed terse form), so it may be optional under the #1064 rule —
 * and a pack that wants the intro every time simply drops the `optional`.
 *
 * **The intro's own trackers commit at speak time too** (issue #1138). The
 * `positionReadout.intro` var DECIDES during expansion — that is what keeps
 * the choice measured against the readout the driver last actually heard —
 * but it only stashes that decision ({@link IntroDecision}); the contract's
 * `speakGate` commits it with {@link commitIntroDecision} once the readout is
 * admitted. Recording it at expansion had the same shape of bug the cooldown
 * claim did before #1137: a readout deferred behind a busier line, then
 * refused at its gate because another trigger took the shared window, still
 * stamped `lastIntroAt` / `lastSpokenPosition` — so the next accepted readout,
 * inside the 30 s window and one place away, dropped its lead-in and spoke a
 * bare "P4" that no "We're currently" had introduced.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContext, ScenarioContract, SpeakGate } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { overtakeContextAllows, type OvertakeGateResolver } from "./overtake-gate.js";

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

let lastPositionAnnouncedAt = 0;
/** Last time the "We're currently" intro was spoken (issue #603 bare/full logic). */
let lastIntroAt = 0;
/** Last position number actually spoken by a readout (issue #603 bare/full delta). */
let lastSpokenPosition = 0;
/** Injectable RNG for the reaction gate — overridable in tests. */
let reactionRandom: () => number = Math.random;

/**
 * What one expansion decided about the intro, and the readout it decided it
 * for: the lead-in it would say, the position it resolved, and the moment it
 * resolved it. Committed to the trackers by that fire's speak-time gate, and
 * by nothing else (issue #1138).
 */
export type IntroDecision = { spokeIntro: boolean; position: number; at: number };

/**
 * The intro decision the CURRENT expansion made, waiting for that fire's
 * speak-time gate (issue #1138). The `where:`-may-stash rule's shape, one
 * step later: a var resolver may stash what the gate will read, because the
 * gate follows the very expansion that wrote it — and only a fire that goes
 * on to play commits anything.
 *
 * Keyed by the fire's own {@link ScenarioContext}, which the engine creates
 * once per expansion and hands to both the var resolvers and the gate. An
 * expansion that then aborts (a missing number clip, issue #835) leaves its
 * decision here unclaimed, and the next gate — a different fire, a different
 * context — refuses to take it.
 */
let pendingIntro: (IntroDecision & { ctx: ScenarioContext }) | null = null;

/**
 * Read-only check of whether the position cooldown window has elapsed — the
 * half every position readout's `where:` runs, so a fire outside the cadence
 * is dropped cheaply at event arrival without touching the window.
 */
export function canAnnouncePosition(now: number = Date.now()): boolean {
  return lastPositionAnnouncedAt === 0 || now - lastPositionAnnouncedAt >= POSITION_READOUT_COOLDOWN_MS;
}

/**
 * Atomic check-and-set for the shared position cooldown: returns `true` and
 * starts a fresh window iff the previous announcement is older than
 * {@link POSITION_READOUT_COOLDOWN_MS}. Claimed by EVERY position readout — the
 * two overtake readouts, the lap-completed readout, and the race-status readout
 * — as its `speakGate` (issue #1137), after the script expanded, so a claim
 * always results in an announcement. Whichever readout speaks first claims the
 * window; the rest are dropped by {@link canAnnouncePosition} in their `where:`
 * at event arrival, or — for one already deferred behind a busier line when
 * the claim was made — refused here at their own gate, so the position is
 * never spoken twice (issue #651) even when the spotter focus floor delays a
 * readout's playback by seconds. The position NUMBER is read live at
 * speak-time, so the single surviving readout still states the current
 * position.
 */
export function tryClaimPositionAnnouncement(now: number = Date.now()): boolean {
  if (!canAnnouncePosition(now)) return false;

  lastPositionAnnouncedAt = now;

  return true;
}

/**
 * The sentence the pack reference publishes for the shared-cooldown gate.
 * One string for every readout that claims the window, so the four contracts
 * cannot drift into describing the same rule four ways.
 */
export const POSITION_READOUT_SPEAK_GATE_DESCRIPTION =
  "No other position readout has spoken in the last twenty seconds when this one comes to speak; speaking it starts that window.";

/**
 * The shared position cooldown as a speak-time gate (issue #1137): the claim
 * every position readout commits after its script expanded and before the ops
 * take the bus. Shared by the two overtake readouts and the race-status
 * readout; `position.ts` carries its own, because its contract also fires in
 * qualifying, where the cooldown is not consulted at all.
 */
export const positionReadoutSpeakGate: SpeakGate = {
  description: POSITION_READOUT_SPEAK_GATE_DESCRIPTION,
  admit: (ctx) => {
    // Take this fire's intro decision whatever happens next — a refused fire
    // must leave nothing behind for the next one to inherit — and commit it
    // only once the window is ours (issue #1138).
    const intro = takeIntroDecision(ctx);

    if (!tryClaimPositionAnnouncement()) return false;

    commitIntroDecision(intro);

    return true;
  },
};

/**
 * Whether an overtake gain/loss should speak the reaction catchphrase (issue
 * #603). Podium positions (P1/P2/P3, by EFFECTIVE position) always react —
 * gaining or defending a podium spot is always worth a word. Every other
 * position rolls {@link REACTION_CHANCE} (~1 in 3); when it loses, only the
 * position readout fires. The position readout itself is a separate contract
 * and is unaffected by this gate.
 */
export function shouldReactToOvertake(effectivePosition: number): boolean {
  if (effectivePosition >= 1 && effectivePosition <= REACTION_ALWAYS_MAX_POSITION) return true;

  return reactionRandom() < REACTION_CHANCE;
}

/**
 * Decide whether a position readout should speak the full "We're currently"
 * intro or just the bare "P[n]" (issue #603). The intro plays when: nothing
 * has been spoken yet, the last intro was more than {@link INTRO_COOLDOWN_MS}
 * ago, or the position changed by more than one since the last readout (a
 * multi-position jump always gets the full intro, even inside the window).
 * Otherwise the intro is dropped for the bare number.
 *
 * PURE (issue #1138), like {@link canAnnouncePosition} and the qualifying
 * latch's read half before it: this runs during expansion, and a
 * readout can still be REFUSED afterwards — by its own speak-time gate, when
 * another trigger claimed the shared window while this one waited behind a
 * busier line, or by an abort further down the sequence. Advancing the
 * trackers here recorded a readout nobody heard, and the next accepted one
 * then dropped its lead-in and spoke a bare number. {@link commitIntroDecision}
 * is the write half, committed by the contract's gate.
 */
export function shouldSpeakIntro(currentPosition: number, now: number = Date.now()): boolean {
  return (
    lastSpokenPosition <= 0 ||
    now - lastIntroAt >= INTRO_COOLDOWN_MS ||
    Math.abs(currentPosition - lastSpokenPosition) > 1
  );
}

/**
 * Stash the intro decision this expansion made, for the fire's own speak-time
 * gate to commit. Private: the `positionReadout.intro` var is the one writer,
 * and it writes exactly once per expansion.
 */
function stashIntroDecision(ctx: ScenarioContext, decision: IntroDecision): void {
  pendingIntro = { ...decision, ctx };
}

/**
 * Take the intro decision THIS fire's expansion stashed, and clear the slot
 * whatever the caller then does with it — a decision serves one gate, and a
 * refused fire must leave nothing for the next one. Returns `null` for a fire
 * whose expansion stashed nothing: an imperative `fire(id)`, a voice whose
 * script never names `positionReadout.intro`, or a fire whose own decision was
 * orphaned by an abort (the stash belongs to another context by then).
 *
 * @internal Exported for `position.ts`'s gate and for tests.
 */
export function takeIntroDecision(ctx: ScenarioContext): IntroDecision | null {
  const pending = pendingIntro;
  pendingIntro = null;

  return pending !== null && pending.ctx === ctx ? pending : null;
}

/**
 * Record a readout the driver is about to hear as the latest one, so the next
 * readout's bare/full decision measures from it (issue #603). The write half
 * of {@link shouldSpeakIntro}, committed by a contract's `speakGate` once the
 * fire is admitted — never during expansion (issue #1138). A `null` decision
 * is a no-op, so a gate can hand its take straight through.
 *
 * @internal Exported for `position.ts`'s gate and for tests.
 */
export function commitIntroDecision(decision: IntroDecision | null): void {
  if (decision === null) return;

  if (decision.spokeIntro) lastIntroAt = decision.at;

  lastSpokenPosition = decision.position;
}

/**
 * Override the reaction-gate RNG. @internal test isolation only — pass a stub
 * returning a fixed value to make {@link shouldReactToOvertake} deterministic.
 */
export function _setReactionRandom(rng: () => number): void {
  reactionRandom = rng;
}

/**
 * Reset all position-readout cooldowns, the uncommitted intro decision and
 * the reaction RNG. @internal test isolation only.
 */
export function _resetPositionReadoutCooldown(): void {
  lastPositionAnnouncedAt = 0;
  lastIntroAt = 0;
  lastSpokenPosition = 0;
  pendingIntro = null;
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

/**
 * Whether the live position is currently known. Whether it is *speakable*
 * derives from the clips that exist for the active voice (issues #835/#836):
 * a position with no clip aborts the readout at expansion time.
 */
export function liveCurrentlyAnnounceable(live: LivePosition | null): boolean {
  return selectLivePosition(live) !== null;
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

/**
 * Register the vocabulary the position-readout scripts reference (issue
 * #1065): the intro and the live-position number. Both read the live resolver
 * at expansion time; a `null` number is a defensive guard — the contract's
 * `where:` already gates on the live position being readable. NOTHING is
 * recorded here (issue #1138): the cooldown is claimed by the contract's
 * `speakGate` via {@link tryClaimPositionAnnouncement}, and the intro's own
 * decision is only STASHED, for that same gate to commit with
 * {@link commitIntroDecision} — both run after this expansion, and only for a
 * fire that goes on to play. Must run before the contracts are defined so the
 * first `setScripts` compile sees the vars.
 */
export function registerPositionReadoutVocabulary(
  engine: Pick<IScenarioEngine, "defineVar">,
  getLivePosition: LivePositionResolver,
): void {
  // "We're currently" intro — resolves to the intro clip when due, or to
  // nothing (leaving a bare "P[n]" under the script's optional clause) inside
  // the 30 s window for a ≤1-position move (issue #603). It reads the last
  // readout the driver actually heard for the delta, and proposes this one —
  // the gate records it (issue #1138).
  engine.defineVar(
    "positionReadout.intro",
    (ctx) => {
      const n = selectLivePosition(getLivePosition());

      if (n === null) return null;

      // Decide, and stash the decision for this fire's speak-time gate to
      // commit (issue #1138). Deciding here is what keeps the words fresh;
      // recording here recorded readouts that were then refused or aborted,
      // and the next accepted one lost its lead-in to them.
      const spokeIntro = shouldSpeakIntro(n, ctx.now);

      stashIntroDecision(ctx, { spokeIntro, position: n, at: ctx.now });

      return spokeIntro ? poolRef(POSITION_GROUP_INTRO_WORSE, "currently") : null;
    },
    "The \"We're currently\" lead-in of a position readout, from position-intro-worse/currently. Resolves to nothing for a second readout within 30 seconds of the last one that moved at most one place — the number is then spoken bare — so the bundled script wraps it in an optional clause; a script that wants the lead-in every time drops the optional. Resolving it also records this readout for the next one's decision, so name it at most once per entry.",
  );

  engine.defineVar(
    "positionReadout.number",
    () => {
      const n = selectLivePosition(getLivePosition());

      return n !== null ? poolRef(POSITION_GROUP_NUMBER, String(n)) : null;
    },
    'The driver\'s current race position as a spoken number, drawn from the position-number group (position-number/4 is "P4"), read live at the moment it is spoken — class position in a multi-class race. The whole point of the readout, so a script keeps it required.',
  );
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
 * Reads the shared position cooldown with {@link canAnnouncePosition} as the
 * last `where:` gate and claims it in its `speakGate` (issue #1137), so a
 * position already announced by any trigger (another overtake, a
 * lap-completed, or a race-status readout — possibly delayed by the spotter
 * focus floor) suppresses this readout instead of doubling it up (issue #651).
 * The reaction catchphrase is a separate contract and still plays.
 * Suppressed after the race ends and whenever {@link overtakeContextAllows}
 * fails (cars alongside, off-track, crawling, pit road, recent incident).
 */
export function buildOvertakeGainedPositionContract(
  getLivePosition: LivePositionResolver,
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.overtake-gained-position",
    description:
      "You gain a place below the podium (a podium gain has its own reaction line) in a running race and hold it a few seconds in a clean moment, with no other position readout in the last twenty seconds.",
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

        // Pure cadence check only — the claim is the gate's (issue #1137), so
        // a fire the script cannot expand never burns the window. If a
        // position was just announced (another overtake, a lap-completed, or a
        // race-status readout, possibly deferred by the spotter focus floor),
        // defer to it so the position is never spoken twice (issue #651). The
        // reaction catchphrase is a separate contract and still plays.
        return canAnnouncePosition();
      },
    },
    speakGate: positionReadoutSpeakGate,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "position-readout",
  };
}

/** Build the position readout that follows a LOST-overtake reaction (issue #574). */
export function buildOvertakeLostPositionContract(
  getLivePosition: LivePositionResolver,
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
): ScenarioContract {
  return {
    id: "pit-crew.overtake-lost-position",
    description:
      "You lose a place in a running race and the drop holds a few seconds, with no car alongside, not on pit road, no incident in the last ten seconds and no other position readout in the last twenty.",
    when: {
      event: "overtake.lost",
      where: (ev) => {
        if (ev.event !== "overtake.lost") return false;

        if (getRaceFinishedFired()) return false;

        if (!overtakeContextAllows(getGate())) return false;

        if (!liveCurrentlyAnnounceable(getLivePosition())) return false;

        // Pure cadence check only — the claim is the gate's (issue #1137), so
        // a fire the script cannot expand never burns the window. Same shared
        // window as the gained readout: never double up the position (issue
        // #651). The loss reaction catchphrase still plays.
        return canAnnouncePosition();
      },
    },
    speakGate: positionReadoutSpeakGate,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "position-readout",
  };
}

export const OVERTAKE_POSITION_SCENARIO_IDS = [
  "pit-crew.overtake-gained-position",
  "pit-crew.overtake-lost-position",
] as const;
