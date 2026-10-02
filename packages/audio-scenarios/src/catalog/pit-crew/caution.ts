/**
 * The full-course caution, narrated (issue #1127) — nine contracts over the
 * translator's caution events: the caution out and who to follow, the pace
 * car reaching the track, the pickup ("two to green"), each extra lap, one
 * lap to green, a change to the car ahead, your race position on the last
 * lap, the pace car peeling off, and the green.
 *
 * As everywhere since #1064, the code here decides WHETHER and WHEN the
 * engineer speaks and how the fire is scheduled; WHAT he says lives in the
 * active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.caution-follow"]`, …), paired at `setScripts` time.
 *
 * **The lineup is read at speak time, never frozen into a payload.** The
 * `caution.*` vocabulary registered below reads the translator's lineup
 * through an injected resolver on every resolution, so a call that plays
 * seconds after its trigger names the car that is ahead NOW. That is the
 * whole reason the events carry their lineup values only as a fallback: the
 * captures show a call waiting behind the spotter while the field re-forms in
 * under a second.
 *
 * **Session and replay gating lives here, not in the diff** (the #480
 * precedent in `race-engineer-callout-examples.md`): every contract carries
 * the flag family's `liveRaceCar` predicate — a race session, live in the
 * car, not past the checkered — so the events stay publishable and
 * harness-firable while only a driver in a race hears them.
 *
 * **Eight of the nine also re-check the caution at SPEAK time**, and that is
 * the price of being queueable rather than a belt on a brace. A pending fire
 * replays WITHOUT its `where:` being re-evaluated, and the pending slot has no
 * TTL: a call parked behind a busy bus waits for the bus to idle, however long
 * that takes. So every line here could otherwise drain onto a green-flag track
 * — "we've caught up with the pace car" seconds after the restart, which is
 * the shape #1127 was filed about. `family: "flag"` does not close it, because
 * same-family preemption replaces the IN-FLIGHT fire and never touches a
 * pending one; nor does `triggerDelay`, which moves the fire decision rather
 * than the moment of speaking. `speakGate` is the code-owned second look
 * (#1138), asked after the script expands and before the ops take the bus, on
 * the first attempt and on every replay. `restart` is the exception and must
 * be: it speaks as the caution ENDS, so a gate would silence it.
 *
 * One residual the gate cannot reach: a fire that has already passed it and is
 * then cut by the CRITICAL `restart` is stashed with `admitted: true` and is
 * never asked again, so a `follow` line still PLAYING at the green replays
 * whole once the restart call finishes — and since #1286 a lineup change
 * still playing does too, because it no longer shares the restart's family,
 * whose wholesale replacement used to discard it rather than stash it. Only `queueable: false` would stop
 * that, and this family is queueable by standing ruling — nothing in a caution
 * sequence is dropped for a busy bus. The gate restores most of what leaving
 * that ruling in place costs, not all of it.
 *
 * Three behaviours below are measured rather than assumed, from the
 * 2026-09-17 Homestead capture the spec is built on:
 *
 * **1. The two pace-car events are deliberately generic**, so the two
 * pace-car contracts gate on the caution. `paceCar.deployed` /
 * `paceCar.off` fire at a rolling start (132.35 / 196.53, both with
 * `SessionState` ParadeLaps) exactly as they do under a caution (264.27 /
 * 488.07, Racing) — the spec made them generic on purpose and left "whether
 * the engineer speaks at a given occurrence" to the callout. The rolling
 * start's pace car belonged to the start, whose own "green's coming" line
 * owned that moment — until #1200 took the pace car out of that line, since
 * GreenHeld rises ~10 s before the pace car leaves. So "Pace car's off" now
 * also speaks with no caution while GreenHeld is up (the rolling start's exit,
 * 196.53 with GreenHeld up since 186.28); otherwise these two ask the translator's caution PHASE
 * through {@link CautionPhaseResolver}. Asking the phase rather than
 * re-deriving it from `SessionState` or the caution bits is deliberate: the
 * phase is the value `diffStartLights` reads to tell a restart from a race
 * start, and a second derivation is a second answer waiting to disagree. The
 * same reader answers every other "which stage is the caution in" question
 * below — the second review replaced three private readings of the raw
 * `OneLapToGreen` bit with it, because that bit also means "formation in
 * progress" and the translator had already folded the F2 withdrawal into its
 * phase; a phase reader also holds its last value through a missing telemetry
 * read instead of answering "unknown".
 *
 * **2. The lineup change is judged against the car last NAMED, not the last
 * reading** (issue #1286). "Change — you're behind car twelve" speaks only
 * when the car ahead differs from the one the engineer last told the driver
 * about in this caution. Judged against the previous pace-row reading, as it
 * first was, it repeated what had just been said four ways: a follow car
 * that flickers A → B → A came back to the car already named; the field
 * re-forms double file on the tick BEFORE the one-to-go flag (415.10 vs
 * 415.12, and 793.92 vs 793.93), so the change duplicated the one-to-go
 * call that names the re-formed car itself; a reshuffle between the flag and
 * the follow call was spoken before anyone had been named; and nothing
 * remembered the named car at all. Four calls name the car — follow, two to
 * green, one to go, and the change itself — and each records the lineup's
 * follow car in its `speakGate`, on admission and only when the lineup names
 * one. The gate and not a `where:`, because the gate is the one place a claim
 * may be committed (#1137): it runs after the script expanded and right
 * before the ops take the bus, while a `where:` record would mark a car
 * named for a call later dropped or evicted. The record is tagged with
 * `getCautionEpisode()`'s id, which never repeats, so a car named in an
 * earlier caution — or session — never counts. Before anything is named the
 * change has nothing to judge against while the follow call can still name
 * the car itself — switched on, and the field still waving, the only phase it
 * speaks in (it reads the lineup live). Otherwise it judges against the
 * caution's first readable lineup: the driver who switched the follow call
 * off still hears the first genuine change, and so does one whose follow call
 * never played (the plugin started mid-caution, or the call lost the pending
 * slot) once the field is caught. Switched off, the one-to-go call's
 * gate never runs and records nothing, so the re-form change speaks its lane
 * and car — the only line that user then gets about the re-form.
 *
 * The change call left the `flag` family and sits one notch below it, with
 * `queueBehind` on its siblings, for two engine facts. Same-family
 * preemption replaces the in-flight fire wholesale, regardless of weight —
 * that is how a change cut two to green and one to go mid-sentence. And a
 * fire that finds the bus busy is parked in the single pending slot WITHOUT
 * its gate being asked, and `setPending` replaces on equal weight — that is
 * how a change evicted a waiting one-to-go call it would have refused itself
 * at replay. One notch below, it can never evict a waiting caution call; and
 * `queueBehind` keeps a sibling arriving from evicting a waiting change in
 * turn, playing the pair in order instead. A genuine change arriving
 * mid-call is heard after it, the wait every lower caution line has.
 *
 * `triggerDelay` holds the decision {@link CAUTION_LINEUP_CHANGE_DELAY_MS};
 * a fresh event replaces the held one, so a reshuffle over several ticks is
 * one decision, taken on the car the field settled on. The hold is also why
 * this contract asks whether the caution is still running: a change emitted
 * in the last breath before the green would otherwise be spoken INTO the
 * restart — the exact shape #1127 was filed about ("Yellow cleared." three
 * seconds into a restart).
 *
 * And it is why this contract, and the follow call, ask at SPEAK time
 * whether the player still HOLDS A PACE ROW (second review, R15). In the
 * road capture's second caution the player was stopped off track and passed
 * car by car from 550.47 to 557.67 s, his row going 6 → 17; the hold
 * coalesced the ~14 changes into one decision at about 559 s, by which time
 * he had been towed and held no row at all. The lineup then resolves to
 * `null`, `caution.hasFollowCarNumber` is false, and the numberless fallback
 * — "The car ahead of you has changed." — would play to a car sitting in its
 * stall. That sentence is not true of a car in its stall; the gate is what
 * keeps it from being said. The follow call takes the same gate, since "Line
 * up behind the car ahead" is an instruction about a lineup the player is
 * in. The one-to-go call deliberately does NOT: "One lap to green." is true
 * for a towed driver too, and its numbered branch already drops to the plain
 * wording when the lineup cannot name a car.
 *
 * **3. The pace rows are assigned ~50 ms after the caution flag** (239.88 →
 * 239.93), so the follow call cannot read the lineup on the flag's own tick;
 * it holds for {@link CAUTION_FOLLOW_DELAY_MS} first.
 *
 * Two more come from the first ROAD-COURSE caution, captured on 2026-09-18
 * (`local/telemetry-watch-20260918-185032-545.jsonl`, the committed cut in
 * `sim-events-iracing`'s `__fixtures__/caution-road-20260918.json`):
 *
 * **4. "Two to green" has no moment on a road course, so the pickup call
 * stays silent when one to green rises on the same tick.** The road capture
 * never shows a waving caution going static on its own: at 309.33 it drops
 * straight from `CautionWaving` to `Caution | OneLapToGreen`, one tick, which
 * as first built said "Two to green" and "One lap to green" back to back. On an oval
 * the two are a leader crossing apart and nothing changes. The gate reads the
 * PHASE at event time: the translator emits the two events in that order on
 * the one tick, and the phase both are published against has already settled
 * on `"one-to-go"` — so the pickup speaks only while the phase is `"caught"`.
 *
 * **5. "Pace car's off" speaks only once one to green is up.** On the road
 * course the pace car's `AproachingPits` means two opposite things. That
 * start was a standing start, so the pace car never ran on the road; it
 * waited PARKED, and iRacing reports a waiting pace car as `OnTrack` (its
 * surface reads `OnTrack` from the first record, and its `CarIdxLapCompleted`
 * stays −1 for the whole capture). Mid-caution it shows `AproachingPits` for
 * about three seconds and then `OnTrack` again (152.23 → 155.37, and 562.07 →
 * 565.22 in the second caution): that is the pace car rolling OUT through pit
 * exit onto the circuit — its deployment, not a departure that returns
 * (corrected by the maintainer, 2026-09-18). Read literally, the first half
 * would have said "Pace car's off" at the very moment the pace car arrived.
 * The real exit on both tracks comes after one to green (461.22 there, 5.7 s
 * before the green; 488.07 / 866.98 on the oval), so gating "off" on the
 * phase being `"one-to-go"` tells the two apart and delays nothing — the
 * deployment lands while the phase is still `"waving"` — and "Pace car's out" at 155.37 is
 * right, the road course's deployment moment, later than the oval's ~20 s
 * because the pace car starts from a standstill. A debounce was rejected:
 * waiting five seconds for a return would push the real call to half a second
 * before the green.
 *
 * **The follow call deliberately carries no `family`; since the second
 * review neither does the position call, and since #1286 neither does the
 * lineup change (finding 2).** Every other contract here shares
 * `family: "flag"` so a newer caution call supersedes a stale older one. The
 * follow call cannot: it rides the very event that fires the
 * existing `pit-crew.flag-caution-waving` line ("Caution! Caution! Yellow
 * flag is out."), and the two are the two halves of one moment, meant to be
 * heard in order. Same-family preemption replaces an in-flight family-mate
 * wholesale, regardless of weight and regardless of `interrupt`, so sharing
 * the family would have this call cut the caution announcement mid-word —
 * and no `triggerDelay` fixes that, because the delay would have to exceed a
 * clip length that every voice pack chooses for itself. With no family and
 * `queueable: true` it defers behind that line and speaks after it: the
 * overtake family's reaction-then-readout pairing, applied to one moment
 * described by two calls.
 *
 * The position call's case is the same shape a lap later. It shares its
 * moment with two `family: "flag"` calls — the one-to-go warning (a player
 * whose lap distance is already past 35% when the leader's crossing raises
 * the flag is at most a tick behind it) and Green Held, which on a short
 * oval lands close to the 35% point — and same-family preemption would cut
 * whichever was in flight. So: no family, `queueable`, and a weight one notch
 * below theirs, so it waits behind either rather than cutting it and never
 * evicts either from the single pending slot. If it cannot fit before the
 * green, its `speakGate` drops it, which is the right outcome: a position
 * read out under green is not the position on the last caution lap. The
 * lineup change shares the same choice for the same reason, and adds a
 * `queueBehind` the other two do without: it can arrive at any stage of the
 * caution, beside any sibling.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  type CautionEpisode,
  type CautionLineup,
  type CautionPhase,
  getLatestTelemetry,
} from "@iracedeck/sim-events-iracing";

import type { ScenarioContract, SpeakGate } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { liveRaceCar, WAVING_FLAG_COOLDOWN_MS } from "./flag-alerts.js";
import { type LivePositionResolver, selectLivePosition } from "./position-readout.js";

/** iRacing's GreenHeld bit in the event's own telemetry — false when there is none to read. */
const greenHeld = (telemetry: TelemetryData | null): boolean =>
  telemetry !== null && hasFlag(telemetry.SessionFlags ?? 0, Flags.GreenHeld);

/** Stable identifier for each user-toggleable caution callout (issue #1127). */
export type CautionCalloutId =
  | "follow"
  | "pace-car-out"
  | "field-caught"
  | "extra-lap"
  | "one-to-go"
  | "lineup-changed"
  | "position"
  | "pace-car-off"
  | "restart";

/**
 * Reader the plugins wire to `getCautionLineup()` from
 * `@iracedeck/sim-events-iracing`: the player's place in the caution lineup as
 * of the latest tick, or `null` when there is none to read.
 *
 * Injected rather than imported — the shape `registerOpponentFlagVocabulary`
 * takes its live-position reader in. Not because it keeps the package free of
 * the translator: this very file imports `getLatestTelemetry` from it, and
 * `package.json` has depended on it since the catalog was written. The reasons
 * are the ones injection actually buys: a test or the harness can hand over a
 * lineup without standing up the translator's module singleton, the harness
 * can substitute its own, and the contract layer holds no reference to live
 * global state that a second consumer would have to reset.
 */
export type CautionLineupResolver = () => CautionLineup | null;

/**
 * Reader the plugins wire to `isUnderFullCourseCaution()`: the translator's own
 * caution phase not being `"none"`, NOT a re-derivation of the caution bits.
 * Taken by the lap-time and position-change contracts, which fall silent
 * under a caution and need nothing finer than "is one out".
 */
export type UnderCautionResolver = () => boolean;

/**
 * Reader the plugins wire to `getCautionPhase()`: WHICH stage the translator's
 * caution is in — `"none"`, `"waving"`, `"caught"` or `"one-to-go"`. The
 * caution family's own reader (second review, R6): the follow call speaks
 * only while the field is still waving, the pickup call only while the phase
 * settled on caught, the pace-car-off call only under one to go, and every
 * speak-time gate asks it for "still out". Holds its last value while nothing
 * can advance it, so no caller treats "unknown" as a third answer.
 */
export type CautionPhaseResolver = () => CautionPhase;

/**
 * Reader the plugins wire to `getCautionEpisode()`: WHICH caution is out — an
 * id that never repeats in the process, and the caution's first readable
 * follow car — or `null` while none is. The lineup-change call's memory of
 * the car last named is scoped by it (issue #1286, module header finding 2):
 * the contracts outlive a session, and a car named in the last caution must
 * not count in the next. The translator owns the episode, so it answers for
 * it rather than this family re-deriving one from the phase.
 */
export type CautionEpisodeResolver = () => CautionEpisode | null;

/**
 * What {@link buildCautionContracts} is built against: the phase; the
 * lineup, read at SPEAK time by the two gates that require the player to
 * still hold a pace row and by the four that record the car they name; the
 * episode that scopes that record; and the live opt-in, which the change call
 * asks of the follow call before anything is named (module header, finding 2).
 */
export type CautionContractDeps = {
  getCautionPhase: CautionPhaseResolver;
  getCautionLineup: CautionLineupResolver;
  getCautionEpisode: CautionEpisodeResolver;
  isCautionCalloutEnabled: (id: CautionCalloutId) => boolean;
};

/** The clip group every car number is spoken from (issue #1127) — `09` and `9` are different clips. */
const CAR_NUMBER_GROUP = "car-number";

/** The existing spoken-position group the restart position is drawn from. */
const POSITION_NUMBER_GROUP = "position-number";

/**
 * How long the follow call holds before deciding and expanding. Two reasons,
 * and the longer one sets the value. The pace rows land ~50 ms after the
 * caution flag in the capture (239.88 → 239.93), so the lineup is unreadable
 * on the flag's own tick — that alone would want a fraction of a second. The
 * binding reason is the single pending slot: this call and the caution
 * announcement ride the same event, and while the bus is held they compete for
 * that one slot. The lower weight above decides who loses; this delay makes
 * the contest rarer, by giving the announcement time to take the bus and drain
 * before the follow fire is even attempted. Two and a half seconds is about
 * the length of the bundled announcement plus its frame.
 */
export const CAUTION_FOLLOW_DELAY_MS = 2500;

/**
 * How long a lineup change holds before deciding (issue #1286). It only
 * coalesces a reshuffle into one decision: a fresh change replaces the held
 * one, so a follow car that flickers away and back inside the hold is decided
 * once, on the car it came back to. Two seconds clears the road capture's
 * longest flicker (1.07 s) by 0.93 s and stays short against the minute a
 * genuine mid-caution reorder has before the green. It no longer has to
 * outlast the gap between the double-file re-form and the one-to-go flag:
 * the memory of the car last named settles that, not the hold.
 */
export const CAUTION_LINEUP_CHANGE_DELAY_MS = 2000;

/** The one spelling of a caution callout's scenario id — the contracts and {@link SCENARIO_ID_TO_CAUTION_ID} both come from it. */
export function cautionScenarioId(id: CautionCalloutId): string {
  return `pit-crew.caution-${id}`;
}

/**
 * Every caution call the lineup change waits behind (issue #1286) — all but
 * itself and the restart, which is CRITICAL with `interrupt` and ends the
 * caution: a change still WAITING then meets its gate at replay and is refused.
 * (One still PLAYING is cut and stashed admitted — the module header's
 * residual.)
 */
const LINEUP_CHANGE_QUEUE_BEHIND: readonly string[] = (
  ["follow", "pace-car-out", "field-caught", "extra-lap", "one-to-go", "position", "pace-car-off"] as const
).map(cautionScenarioId);

/** The family's speak-time gate: the full-course caution is still out. */
function stillOutGate(getCautionPhase: CautionPhaseResolver): SpeakGate {
  return {
    description: "Re-checked at speak time: the full-course caution is still out.",
    admit: () => getCautionPhase() !== "none",
  };
}

/** The fields every contract in the family shares. */
function cautionContract(
  id: CautionCalloutId,
  getCautionPhase: CautionPhaseResolver,
): Omit<ScenarioContract, "description" | "when"> {
  return {
    id: cautionScenarioId(id),
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    family: "flag",
    // Nothing in a caution sequence is ever dropped for a busy bus. The
    // capture is the reason it is stated rather than inherited: the caution
    // call itself fired 0.8 s after `!yellow` and was DISCARDED because the
    // spotter held the bus, which is the "no audio when the caution is
    // thrown" report #1127 was filed with.
    queueable: true,
    // …and being queueable is exactly why every one of them needs the
    // speak-time re-check below. See the module header: a pending fire's
    // `where:` is never re-evaluated and the pending slot has no TTL, so
    // without this a caution line can drain onto a green-flag track.
    speakGate: stillOutGate(getCautionPhase),
  };
}

/**
 * The family, built against the plugin's caution readers. A builder rather
 * than a constant for two reasons. The contracts need the phase reader at two
 * moments: at event time, to say whether THIS occurrence of an event is news
 * (the pace car's, which fires at a rolling start too; the follow call's,
 * whose flag re-raises; the pickup's and the pace-car-off's, which read the
 * stage), and again at speak time in eight of the nine. And one build holds
 * the car last named, shared by the four calls that record it and the change
 * call that reads it (issue #1286) — see the module header for all three.
 */
export function buildCautionContracts({
  getCautionPhase,
  getCautionLineup,
  getCautionEpisode,
  isCautionCalloutEnabled,
}: CautionContractDeps): readonly ScenarioContract[] {
  /** The shared gate, plus "a caution is actually out" for an event that also fires elsewhere. */
  const underCautionCar = (e: SimEventOf<SimEventName>): boolean => liveRaceCar(e) && getCautionPhase() !== "none";

  /**
   * The speak-time gate for the two calls that tell the driver where he
   * stands in the lineup: the caution is still out AND the player still
   * holds a pace row — read live, never from the event (module header,
   * finding 2, the towed player).
   */
  const stillLinedUp: SpeakGate = {
    description: "Re-checked at speak time: the full-course caution is still out and you still hold a pace row.",
    admit: () => getCautionPhase() !== "none" && getCautionLineup() !== null,
  };

  /** The family's own gate, built once so the two naming calls below can wrap it. */
  const stillOut = stillOutGate(getCautionPhase);

  /**
   * The car the engineer last told the driver about in THIS caution (issue
   * #1286), recorded by the four calls that name it when their gate admits —
   * the one place a claim may be committed (#1137): the script has expanded
   * and the ops take the bus next. Tagged with the caution's id so a record
   * from an earlier caution — or session — never counts.
   */
  let lastNamed: { episodeId: number; followCarIdx: number } | null = null;

  /** Record the car ahead now as named — nothing while no caution is out or the lineup names no car. */
  const recordNamed = (): void => {
    const episode = getCautionEpisode();
    const followCarIdx = getCautionLineup()?.followCarIdx ?? null;

    if (episode === null || followCarIdx === null) return;

    lastNamed = { episodeId: episode.id, followCarIdx };
  };

  /**
   * What a change in `episode` is judged against: the car last named this
   * caution. Before anything is named, nothing while the follow call can still
   * name the car itself — switched on, and the field still waving, the only
   * phase it speaks in — else the caution's first readable lineup. Past the
   * waving phase a follow call that never played (the plugin started
   * mid-caution, the driver was not in the car at the flag, the call lost the
   * pending slot, or the pack has no follow line) has nothing more to say, so
   * waiting for it would leave every genuine change silent until two to green
   * or one to go.
   */
  const referenceCarIdx = (episode: CautionEpisode): number | null => {
    if (lastNamed !== null && lastNamed.episodeId === episode.id) return lastNamed.followCarIdx;

    if (isCautionCalloutEnabled("follow") && getCautionPhase() === "waving") return null;

    return episode.firstFollowCarIdx;
  };

  /** A speak-time gate that also records the car the call names — on admission only. */
  const naming = (gate: SpeakGate): SpeakGate => ({
    description: gate.description,
    admit: (ctx) => {
      if (!gate.admit(ctx)) return false;

      recordNamed();

      return true;
    },
  });

  return [
    {
      ...cautionContract("follow", getCautionPhase),
      family: undefined,
      // One notch BELOW the rest of the family, and deliberately not the
      // family default — do not "tidy" it back. `BusState.pending` is a single
      // slot and `setPending` replaces on `weight >= pending.weight`, silently.
      // This call and `pit-crew.flag-caution-waving` ride the same event, so
      // with the bus held (measured: the spotter held it at +0.8 s) the
      // announcement is sitting in that slot when this one arrives. A tie would
      // evict it. Between "Caution! Caution! Yellow flag is out." and a
      // navigational detail, the announcement is the one that must never be
      // lost — which is the whole point of having made it queueable.
      weight: WEIGHT.SAFETY - 1,
      triggerDelay: CAUTION_FOLLOW_DELAY_MS,
      // The `CautionWaving` bit re-raises on every re-approach of the incident
      // zone, exactly as the yellow one does, so this rides its sibling's
      // cooldown (issue #671).
      cooldown: WAVING_FLAG_COOLDOWN_MS,
      // Speaks only while the field is still WAVING: the bit re-raises on
      // every re-approach of the incident zone, and the translator's own
      // machine ignores a re-raise once the field is caught — this gate is
      // the contract agreeing with it (second review, R4), so a re-raise on
      // a double-file restart lap cannot repeat "Line up behind car N".
      // Decided after the hold, so the phase read is the one the rows landed
      // in. And the lineup gate at speak time: an instruction about a lineup
      // is for a driver who is in it. It names the car, so it records it.
      speakGate: naming(stillLinedUp),
      description:
        "iRacing waves the full-course caution at the field in a race while you are live in the car, and a second later, the field still spread out behind the flag, the pace rows say who you line up behind.",
      when: { event: "flag.caution-waving.raised", where: (e) => liveRaceCar(e) && getCautionPhase() === "waving" },
    },
    {
      ...cautionContract("pace-car-out", getCautionPhase),
      description:
        "The pace car reaches the track during a full-course caution in a race, about twenty seconds after the flag; the pace car leading a rolling start belongs to the start and stays silent here.",
      when: { event: "paceCar.deployed", where: underCautionCar },
    },
    {
      ...cautionContract("field-caught", getCautionPhase),
      // The reference voice names the car ahead here, so it records it.
      speakGate: naming(stillOut),
      description:
        "Two to green: the waving caution goes static at the leader's crossing, a lap before the one-to-go flag, in a race with you live in the car; silent where both flags land on one tick (road courses).",
      when: {
        event: "caution.fieldCaught",
        // Finding 4 in the module header: the road course raises the static
        // caution and one to green together, and "Two to green" a breath
        // before "One to go" is wrong twice over. On that tick the phase has
        // already settled on one to go; on an oval it is caught.
        where: (e) => liveRaceCar(e) && getCautionPhase() === "caught",
      },
    },
    {
      ...cautionContract("extra-lap", getCautionPhase),
      description:
        "The race leader crosses the line under caution and the one-to-go flag does not come with it, so the caution has been extended past the two laps it defaults to.",
      when: { event: "caution.extraLap", where: liveRaceCar },
    },
    {
      ...cautionContract("one-to-go", getCautionPhase),
      // The reference voice names the lane and the car ahead here, so it
      // records the car — the re-formed one, at the double-file re-form. With
      // no lineup to read it still speaks, and records nothing.
      speakGate: naming(stillOut),
      description:
        "iRacing raises the one-lap-to-green flag under a full-course caution and the field forms up for the restart, single or double file.",
      when: { event: "caution.oneLapToGreen", where: liveRaceCar },
    },
    {
      ...cautionContract("lineup-changed", getCautionPhase),
      // Outside the flag family and one notch below it, like the follow and
      // position calls — see the module header, finding 2: same-family
      // preemption cut the phase call this change duplicated, and a fire
      // parked on a busy bus meets no gate before it takes the pending slot,
      // so only weight keeps it from evicting a waiting caution call. Do not
      // "tidy" either back.
      family: undefined,
      weight: WEIGHT.SAFETY - 1,
      // One notch below would lose a waiting change to any sibling arriving;
      // waiting BEHIND them instead plays the pair in order (#1108).
      queueBehind: LINEUP_CHANGE_QUEUE_BEHIND,
      triggerDelay: CAUTION_LINEUP_CHANGE_DELAY_MS,
      speakGate: {
        description:
          "Re-checked at speak time: the caution is still out, you still hold a pace row, and the car ahead is not the one last named in this caution.",
        admit: (ctx) => {
          if (!stillLinedUp.admit(ctx)) return false;

          const episode = getCautionEpisode();
          const now = getCautionLineup()?.followCarIdx ?? null;

          if (episode === null || now === null) return false;

          const reference = referenceCarIdx(episode);

          if (reference === null || now === reference) return false;

          // The car this call names — the one just compared, under the
          // caution just read.
          lastNamed = { episodeId: episode.id, followCarIdx: now };

          return true;
        },
      },
      description:
        "The car you line up behind under caution changes — a car pitted, or the field re-formed — and two seconds later it is still not the car the engineer last named in this caution.",
      // Decided after the hold. Whether the change is news is the gate's
      // question, asked at speak time against what was actually said.
      when: { event: "caution.lineup.changed", where: underCautionCar },
    },
    {
      ...cautionContract("position", getCautionPhase),
      // Outside the flag family and one notch below it — see the module
      // header's closing paragraph: it must wait behind the one-to-go call
      // and Green Held, never cut them, and never evict them from the
      // pending slot. Do not "tidy" either back.
      family: undefined,
      weight: WEIGHT.SAFETY - 1,
      description:
        "About a third of the way into the last caution lap — the one-to-go flag is up and your lap distance passes 35% — your race position from the live running order, the number your display shows.",
      when: { event: "caution.lastLapCheckpoint", where: liveRaceCar },
    },
    {
      ...cautionContract("pace-car-off", getCautionPhase),
      // The family's gate asks "is the caution still out", which an opening
      // rolling start never answers yes to (#1200). So this call also passes
      // while iRacing still holds the green, read off the translator's LATEST
      // tick: a fire queued behind a busy bus that drains after the green
      // finds GreenHeld down and stays silent. No telemetry fails closed — a
      // "Pace car's off" on a green track is worse than a missed one.
      speakGate: {
        description: "Re-checked at speak time: the full-course caution is still out, or the green is still held.",
        admit: () => getCautionPhase() !== "none" || greenHeld(getLatestTelemetry() as TelemetryData | null),
      },
      description:
        "The pace car peels off to pit road about five seconds before the green — on the last caution lap, or with the green held at an opening rolling start — never while deploying on a road course.",
      when: {
        event: "paceCar.off",
        // Finding 5 in the module header: on a road course a parked pace car
        // reads OnTrack, and its three seconds of AproachingPits mid-caution
        // are it rolling OUT through pit exit to deploy — an arrival, not a
        // departure, and it lands while the phase is still waving. The real
        // exit is always after one to go, so waiting for that phase costs
        // nothing. At an opening rolling start there is no caution at all;
        // there the exit comes with iRacing's GreenHeld up (#1200, finding 1).
        where: (e) => {
          if (!liveRaceCar(e)) return false;

          const phase = getCautionPhase();

          return phase === "one-to-go" || (phase === "none" && greenHeld(e.telemetry as TelemetryData | null));
        },
      },
    },
    {
      ...cautionContract("restart", getCautionPhase),
      // The one contract with NO speak-time caution gate, and it cannot have
      // one: it speaks at the exact moment the caution ends, so the phase has
      // already returned to "none" by the time the gate would be asked and the
      // call would silence itself. Its own freshness comes from CRITICAL +
      // `interrupt` — the green lands on the driver's launch, so nothing still
      // playing may delay it, and nothing it displaces matters more.
      speakGate: undefined,
      weight: WEIGHT.CRITICAL,
      interrupt: true,
      description: "The green flag ends a full-course caution and the field is released in a race.",
      when: { event: "caution.restarted", where: liveRaceCar },
    },
  ];
}

/**
 * The family's scenario ids, in the order a caution runs through them. Derived
 * from the contracts themselves so the two can never drift; the resolver they
 * are built with cannot change an id.
 */
export const CAUTION_SCENARIO_IDS: readonly string[] = buildCautionContracts({
  getCautionPhase: () => "none",
  getCautionLineup: () => null,
  getCautionEpisode: () => null,
  isCautionCalloutEnabled: () => true,
}).map((c) => c.id);

/**
 * Canonical mapping from {@link CautionCalloutId} to its plugin-global setting
 * key in `GlobalSettingsSchema`. Plugin entry points read the live opt-in
 * through it without duplicating the key strings.
 */
export const CAUTION_CALLOUT_SETTING_KEYS: Record<CautionCalloutId, string> = {
  follow: "calloutEnabledCautionFollow",
  "pace-car-out": "calloutEnabledCautionPaceCarOut",
  "field-caught": "calloutEnabledCautionFieldCaught",
  "extra-lap": "calloutEnabledCautionExtraLap",
  "one-to-go": "calloutEnabledCautionOneToGo",
  "lineup-changed": "calloutEnabledCautionLineupChanged",
  position: "calloutEnabledCautionPosition",
  "pace-car-off": "calloutEnabledCautionPaceCarOff",
  restart: "calloutEnabledCautionRestart",
};

/**
 * Scenario id → callout id, the map `registerPitCrew`'s opt-in wrapper is
 * given. DERIVED from the setting-key map through {@link cautionScenarioId}
 * rather than written out, because the wrapper THROWS on a scenario id it
 * cannot map — at plugin startup, taking every Race Engineer callout down with
 * it, not just this family. A hand-written copy had exactly that failure
 * waiting in it for the next id added to the family.
 */
export const SCENARIO_ID_TO_CAUTION_ID: Record<string, CautionCalloutId> = Object.fromEntries(
  (Object.keys(CAUTION_CALLOUT_SETTING_KEYS) as CautionCalloutId[]).map((id) => [cautionScenarioId(id), id]),
);

/**
 * Where the position-number group ends: the bundled voice ships one clip per
 * position from 1 to this. iRacing fields CAN exceed it — the pace car counts,
 * and the 64-slot `IRSDK_MAX_CARS` is stale — so a restart position past the
 * end resolves to no clip here and the position call drops whole through the
 * script's optional clause, the position spoken as nothing rather than as a
 * wrong number. Made visible rather than left to the empty pool so the gap is
 * a logged decision and not a silent one.
 */
export const POSITION_NUMBER_MAX = 64;

/**
 * Register the vocabulary the caution scripts name (issue #1127). Must run
 * before the contracts are defined so the first `setScripts` compile sees it;
 * a later registration only marks the compiled scripts dirty.
 *
 * Every entry reads the lineup afresh through `getCautionLineup`, so a call
 * that waited behind a busier bus names the car that is ahead at the moment it
 * is spoken rather than the one that was ahead when it fired. The one entry
 * that does not read the lineup is `caution.racePosition`, which reads the
 * canonical live position through `getLivePosition` — the SAME dependency the
 * position-change and race-status vocabularies take, threaded in rather than
 * added beside them, so two readings of "position" cannot drift apart.
 */
export function registerCautionVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">,
  getCautionLineup: CautionLineupResolver,
  getLivePosition: LivePositionResolver,
  logger?: ILogger,
): void {
  /**
   * The car number the follow lines would name, as a pool reference, or
   * `null` when there is none to name — the pace car is what is ahead, the
   * field carries no readable lineup, or the session cannot spell the car.
   * One function behind both the var and the `caution.hasFollowCarNumber`
   * condition, so the two can never answer differently about the same tick.
   */
  const followCarNumberRef = (): string | null => {
    const lineup = getCautionLineup();

    // Following the pace car is not a car number. The lineup names the pace
    // car's own number there, and a script that spoke it would say "line up
    // behind car zero" — so the number is withheld and the answer to
    // "who is ahead" is the `caution.followsPaceCar` condition below. A pack
    // that names the number without asking that first gets a callout that
    // drops rather than a wrong one, which is the safe way round.
    if (lineup === null || lineup.followsPaceCar) return null;

    const number = lineup.followCarNumber;

    return number !== null && number !== "" ? poolRef(CAR_NUMBER_GROUP, number) : null;
  };

  engine.defineVar(
    "caution.followCarNumber",
    followCarNumberRef,
    'The car number you line up behind under caution, spoken from the car-number group exactly as the sim spells it — "09" and "9" are different clips. Null while the pace car is the only thing ahead of you, and while the field carries no readable lineup, so branch on caution.followsPaceCar before naming it. Nothing to say is common rather than exceptional here, so keep the number in an optional clause with the words that introduce it: a null var in a required step aborts the whole callout, silently and at debug level, and the driver hears nothing at all. Where the callout must still say SOMETHING without the number — one lap to green, above all — branch on caution.hasFollowCarNumber and give the other branch a numberless wording.',
  );

  engine.defineVar(
    "caution.restartPosition",
    () => {
      const position = getCautionLineup()?.restartPosition ?? null;

      if (position === null || !Number.isInteger(position) || position < 1) return null;

      // The spoken positions stop at POSITION_NUMBER_MAX and a field can run
      // past it (the pace car counts). The clause is dropped rather than
      // handed a pool reference that resolves to nothing, and the drop is
      // logged so a driver's missing position is a decision on record.
      if (position > POSITION_NUMBER_MAX) {
        logger?.debug(
          `caution.restartPosition ${position} is past the spoken range (1–${POSITION_NUMBER_MAX}); the position clause is dropped`,
        );

        return null;
      }

      return poolRef(POSITION_NUMBER_GROUP, String(position));
    },
    `Your place in the restart LINEUP, spoken from the position-number group, which stops at ${POSITION_NUMBER_MAX} — a position past that is null, since there is no clip to say it with. Counted off the pace rows rather than the running order — that is what iRacing lines the field up by — and null whenever the rows carry no absolute position, which happens whenever session info cannot name the pace car. This is NOT the race position: a lapped car lined up ahead of you is behind you in the race, so a spoken "P" belongs to caution.racePosition, which is what the reference position call uses. Keep it in an optional clause with the words that introduce it: a null var in a required step aborts the whole callout, silently and at debug level.`,
  );

  engine.defineVar(
    "caution.racePosition",
    () => {
      // The canonical live order (`getLivePosition`), the same reader the
      // position-change and race-status calls speak from — in your class in a
      // multi-class race, as they do. Not the lineup: the 2026-09-19 snapshot
      // had the player 20th in the lineup, 19th in the race, and 19 on the
      // display, because car #7 was two laps down and lined up ahead of him.
      const position = selectLivePosition(getLivePosition());

      if (position === null) return null;

      // The spoken positions stop at POSITION_NUMBER_MAX and a field can run
      // past it (the pace car counts). The clause is dropped rather than
      // handed a pool reference that resolves to nothing, and the drop is
      // logged so a driver's missing position is a decision on record.
      if (position > POSITION_NUMBER_MAX) {
        logger?.debug(
          `caution.racePosition ${position} is past the spoken range (1–${POSITION_NUMBER_MAX}); the position clause is dropped`,
        );

        return null;
      }

      return poolRef(POSITION_NUMBER_GROUP, String(position));
    },
    `Your race position at the moment the call is spoken, from the canonical live running order — the number your display shows, in your class in a multi-class race — spoken from the position-number group, which stops at ${POSITION_NUMBER_MAX}; a position past that is null, since there is no clip to say it with. This is what the position call on the last caution lap speaks. It is not your place in the restart lineup (caution.restartPosition): a lapped car lined up ahead of you is behind you in the race, and the two differ by exactly those cars. Null while the order cannot be read. Keep it in an optional clause with the words that introduce it: a null var in a required step aborts the whole callout, silently and at debug level. In the position call that clause IS the whole callout, and there that is right — a position call with no position has nothing true to say.`,
  );

  engine.defineCond(
    "caution.hasFollowCarNumber",
    () => followCarNumberRef() !== null,
    'The car ahead of you in your line can be named — caution.followCarNumber would resolve. False while the pace car is the only thing ahead (ask caution.followsPaceCar for that), while the field carries no readable lineup, and when the session cannot spell the car\'s number. The condition to branch on when a callout must still speak without the number: the one-lap-to-green call says a plain "One lap to green." in the other branch rather than nothing, because an optional clause alone expands to an empty callout and the driver hears no warning at all.',
  );

  engine.defineCond(
    "caution.isLeader",
    () => getCautionLineup()?.isLeader === true,
    "You would restart first. Not the same as having only the pace car ahead of you, which is true of both front cars on a double-file restart — that is caution.followsPaceCar.",
  );

  engine.defineCond(
    "caution.followsPaceCar",
    () => getCautionLineup()?.followsPaceCar === true,
    "There is nobody ahead of you in your own line, so the pace car is the only thing in front. True for the leader and for the outside front car on a double-file restart; the condition to ask before naming a car number.",
  );

  engine.defineCond(
    "caution.isDoubleFile",
    () => getCautionLineup()?.doubleFile === true,
    "The field is lined up in two columns rather than one. iRacing re-forms the field double file on the tick before the one-to-go flag when the restart is a double-file one.",
  );

  engine.defineCase(
    "caution.line",
    () => getCautionLineup()?.line ?? null,
    {
      inside: "You line up in the inside lane.",
      outside: "You line up in the outside lane.",
    },
    "Which lane you line up in. Only ever answered on an oval running double file — on any other discipline, and single file, there is no lane to name and the default branch runs.",
  );
}
