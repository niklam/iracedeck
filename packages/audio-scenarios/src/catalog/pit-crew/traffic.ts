/**
 * Approaching-traffic family (issue #1113, amended 2026-11-11) — the Race
 * Engineer's answer to "is anything coming?" at two moments: stopped or
 * crawling on track after a spin or a stall (`traffic.rejoin`), and leaving
 * the pits (`traffic.pitExit`, 3 s short of the end of pit road, and the merge
 * warning `traffic.pitExitMerge` in the exit lane, amended 2026-11-20). The
 * translator's detectors
 * (`diff/traffic-rejoin.ts`, `diff/traffic-pit-exit.ts` in
 * `@iracedeck/sim-events-iracing`) decide the band, the number and every
 * timing rule — when a line is first said, when it is counted down, when a
 * close car has gone by; the contracts here only map the event to a line and
 * schedule it.
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.traffic-rejoin-near-first"]`, …), paired
 * at `setScripts` time.
 *
 * **The engineer alerts, never instructs, and speaks only to warn.** The
 * rejoin lines name a fixed band of the nearest predicted arrival — right
 * behind (under 2 s), a number (2 s to under 10 s) — and never tell a stopped
 * driver to hold or go. Nothing reassures him (amended 2026-11-20): the "more
 * than ten" and "Clear to rejoin." lines were removed, so the rejoin feature
 * never gives an all-clear, and silence does not mean that no car is close:
 * a warning may be switched off, waiting behind a higher-priority line, or
 * dropped as stale (below). The bands are fixed because the
 * words name them. A group of cars coming is one line, "A group of cars
 * coming. Join carefully." (`pack`, amended 2026-11-18), said once in place
 * of the first car's band; the detector says nothing more while the group goes
 * by, and the next car under ten seconds after it is a new first call.
 *
 * **One contract per line, not one contract with a `case`.** Whether a line
 * may cut the one in flight, and how heavy it is, are contract fields, and the
 * lines need different answers (weights, below). One contract could carry
 * only one `weight` and one `interrupt`. The `near` verdict is two contracts —
 * the call that introduces a car coming into the band, and the later count —
 * because the two are worded differently and a pack phrases each. Separate
 * contracts also give each line its own harness button, reference description
 * and script entry; the `traffic.rejoinBand` / `traffic.pitExitVerdict` cases
 * and the `traffic.rejoinFirst` condition are still published for a pack that
 * wants to share one body.
 *
 * **A count is an update only once the first call was heard (amended
 * 2026-11-17).** The detector marks the call that brings a car into the band
 * `first: true` and every later count of it `first: false`, but it cannot
 * know whether a line played: a first call that waited past its maximum wait
 * behind a heavier line, or that a newer verdict replaced in the queue, was
 * never heard, and "Getting closer, about five seconds." would then update a
 * car the driver was never told about. So the audio side keeps whether the
 * current approach has been introduced ({@link readTrafficDebugState}), and
 * the two `near` contracts split on it rather than on the flag alone: the
 * first call matches `first === true || !introduced`, the update `first ===
 * false && introduced` — and never the very count whose first call just
 * introduced the car, since the bus asks each contract's `where:` in turn and
 * the first call's can be admitted on an idle bus before the update's is
 * asked — so exactly one of them takes any `near` event and an unheard first
 * call makes the next count a first call ("Car coming in about …"). Only a
 * line that takes the bus moves the state, through its contract's
 * `speakGate.admit` — the `where:` checks read it and never write it:
 * - **Set** by the first call's gate, as its claim, when it takes the bus.
 * - **Cleared** by the pack line's gate, when it takes the bus: the group
 *   replaces the lone car's approach, and it names no seconds a count could
 *   update, so whatever car comes after it is introduced with a first call.
 *   The detector follows a pack with a first call anyway (a count needs a
 *   `near` call before it); clearing keeps an earlier car's introduction from
 *   outliving the group, so no count can ever follow the group as an update.
 * - **Cleared** when the detector starts a new approach (a `near` event with
 *   `first: true`), unless that very event is the one whose first call
 *   already took the bus — the engine can admit it synchronously before this
 *   family's own subscriber sees the event, so the check is by event identity
 *   rather than by order. Without it, an episode that ended silently with the
 *   car driving off would leave its introduction standing, and a next stop
 *   whose first call was dropped would hear an update first.
 * - **Cleared** on `session.changed`, with everything else a session ends.
 * "Right behind" needs no introduction and leaves the state alone.
 *
 * **Composed lines (maintainer, 2026-11-11).** A first call in the close band
 * is one flowing sentence of three clips picked at random from three pools —
 * a lead-in with no period ("Car coming in"), the middle naming the seconds
 * ("about five seconds."), an outro ("Watch out.") — and a later count is an
 * update intro ending in a comma and the middle ("Getting closer, about
 * five seconds."). Both voices use the same texts for these pieces.
 * The middle is the {@link REJOIN_SECONDS_VAR} var: the event's `seconds`
 * resolved to the `traffic/rejoin-mid-<N>` pool, whose takes are the voice's
 * different wordings of the same figure. The fixed lines are pools of four.
 *
 * **One family.** All seven share `family: "traffic"` (spec decision 6): a
 * fresh line replaces a stale one in flight wholesale, whatever the weights —
 * a closer count arriving while the previous one still plays cuts it.
 *
 * **Queued, never stale.** `queueable: true` on every contract: the detector
 * records a line as said when it publishes it and does not say it again
 * unless the picture changes, so a line dropped because the bus was busy is
 * lost — the entry call after a spin, behind the incident line, was the case.
 * Two fields keep a waiting line true. Each trigger's contracts share one
 * `supersedeGroup`, so a newer verdict removes a waiting older one instead of
 * letting it play after it. And `maxQueueWaitMs` is per line
 * (`LineSpec.maxQueueWaitMs`): the lines whose words decay while they wait —
 * every rejoin line (the close calls, whose seconds count down, and the pack
 * line, about cars going by within seconds) and the pit-exit traffic warning
 * and merge warning — take {@link TRAFFIC_MAX_QUEUE_WAIT_MS}, since "about
 * five seconds" heard four seconds late describes a car that has already
 * passed (a queued count still says the event's number, so it can be up to
 * that long out of date; the detector's next count, about a second later,
 * replaces it, and working the number out again at speak time was judged
 * not worth a clock-dependent resolver), and right behind the shorter
 * {@link TRAFFIC_REJOIN_RIGHT_BEHIND_MAX_QUEUE_WAIT_MS} (below); the pit-exit clear takes the engine default, since what would make
 * it false is a flipped verdict, which the detector publishes and which
 * replaces it in the queue. The one gap is a picture the detector cannot
 * judge — the per-car arrays missing — where it publishes nothing, so nothing
 * replaces the waiting line; practically unreachable, since iRacing always
 * fills the arrays.
 *
 * **A tow or a reset cuts the rejoin lines (amended 2026-11-20).** Every
 * rejoin contract declares `endsOn` `traffic.rejoinTowed`, which the detector
 * publishes when the player's car is taken off the track mid-stop — out of the
 * world or in the pit stall (a tow or a reset), out of the car, the garage —
 * and the translator when it wipes a running stop (entering the garage view on
 * leaving the car, a session change, a disconnect), never on a tick that
 * publishes `traffic.rejoin`. The engine's line ends
 * (#1407) then stop a rejoin line playing at once (unframed, so silently; a
 * line already heard in full finishes) and drop one waiting, of any rejoin
 * contract. A stop that ends by driving off publishes nothing, so a line in
 * flight then finishes. The pit-exit lines and the merge warning do not end
 * on it.
 *
 * **Never heard after the moment it warns about.** A warning waits up to
 * {@link TRAFFIC_MAX_QUEUE_WAIT_MS} behind a `CRITICAL` line, and the short
 * wait alone does not keep it true: a car under two seconds away has arrived
 * well inside it. So a speak-time gate checks each line once it reaches the
 * radio, and drops it once the moment it predicts has passed:
 * - **The close calls** ("right behind" and both `near` calls) are dropped
 *   once the fire has waited, since its event, as long as the prediction it
 *   names: {@link TRAFFIC_REJOIN_RIGHT_BEHIND_S} for right behind, and the
 *   event's whole `seconds` for a `near` call, whose car arrives in `seconds`
 *   to `seconds + 1`. A line that plays at once is never refused.
 * - **The pit-exit lines and the merge warning** are dropped once the live
 *   telemetry has the player back on the racing surface (`PlayerTrackSurface` `OnTrack` / `OffTrack`),
 *   the detector's own end of the exit: the merge they are about is over. So
 *   are they once it has the player out of the world (`NotInWorld`, a reset
 *   or a tow to the garage). The exit lane and the stall admit. With no
 *   telemetry (the scenario harness) or no surface read they play.
 * - **The pack line** has no time gate: it waits at most
 *   {@link TRAFFIC_MAX_QUEUE_WAIT_MS}, and a group coming is still worth
 *   hearing as the driver pulls out in front of it.
 * A line cut mid-sentence and replayed is not asked again (`SpeakGate`): the
 * engine replays the fire it admitted, since a gate may claim state. What
 * bounds that replay is the wait, which counts from when the line was first
 * due and keeps counting across the cut (#1681). So right behind waits at
 * most {@link TRAFFIC_REJOIN_RIGHT_BEHIND_MAX_QUEUE_WAIT_MS}, its gate's own
 * two seconds: one the spotter cuts as the car arrives alongside is not
 * replayed once the car is there. A `near` call's bound is its own seconds,
 * per event, which a contract's wait cannot carry: one about a car two
 * seconds away, cut and replayed between two and three seconds after it was
 * due, is heard about a car already there. That replay is the rejoin lines'
 * only: the pit-exit lines and the merge warning declare `dropWhenCut`
 * (#1681), so one an interrupt cuts is gone. Replayed, it would skip its
 * gate, and the clear call could then be heard on the racing surface within
 * its long wait; the line that cut it, the spotter's above all, is the more
 * current word on the cars around the player.
 *
 * **Weights (spec decision 6, amended 2026-11-17).** The warnings — right
 * behind, both `near` calls, the pack line, the pit-exit traffic warning and
 * the merge warning — fire at
 * {@link TRAFFIC_WARNING_WEIGHT}, 85, strictly between `WEIGHT.SAFETY` and
 * `WEIGHT.CRITICAL`, with `interrupt`: a car arriving within seconds cuts
 * routine chatter and a caution or flag line mid-sentence, and a cut caution
 * or flag line, being queueable, replays after it. At `SAFETY` a warning could
 * not cut an equal-weight caution line, and a stop is often exactly when a
 * caution is called: the first call waited behind "Caution is out…" and was
 * dropped after its short wait. The meatball, the start lights and fuel
 * critical (`CRITICAL`) and the spotter's transition calls (`PROXIMITY`) still
 * win: a warning waits behind a `CRITICAL` line within its short wait, and a
 * spotter call cuts a warning. The pit-exit clear call sits at `SAFETY` and
 * keeps `interrupt`: made 3 s short of the end of pit
 * road (amended 2026-11-20), it trumps the exit readback and the tire-wear report (spec, "Pit
 * exit": both pit-exit lines cut in): either, cut in flight, is queueable and
 * picks up again after it, while one already finished is not replayed. Both
 * come `PIT_READBACK_EXIT_DELAY_MS` (4.5 s) after the player leaves pit road,
 * so in practice they follow the call. It is not a warning and does not cut a
 * caution line. `PROXIMITY` itself
 * is not used — it is the spotter's, for cars alongside, and these are about
 * cars that are not yet alongside.
 *
 * **Frames.** The rejoin lines are unframed (`NO_FRAME`): they repeat while
 * the car stays stopped, at the detector's cadence, and the open and close
 * ticks around every one would drown the words — the spotter precedent. The
 * pit-exit lines are spoken once per exit (again only if the verdict flips),
 * the merge warning at most once, and they keep the default radio frame.
 *
 * **The merge warning (amended 2026-11-20).** "Watch for cars.", Niklas's
 * words, said in the exit lane when a timed car will reach the end of the
 * blend within the `trafficPitExitMergeWarnSeconds` slider of the player,
 * whatever the first call said. A contract of its own, on its own event: it
 * answers a different question from the verdict, so it takes no part in the
 * pit-exit lines' `supersedeGroup` — a waiting call is never dropped for it,
 * nor it for a flip. It rides the `pit-exit` opt-in with them.
 *
 * Session gating (live in the car, on track, off pit road, past the green)
 * lives in the translator's detectors, NOT here, so the contracts stay
 * harness-firable. The one module state is the introduction above; every
 * resolver otherwise reads the fire's own event, and the pit-exit gate the
 * live telemetry, which admits when there is none.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, TRAFFIC_CALLOUTS } from "@iracedeck/callout-settings";
import {
  type IEventBus,
  type SimEventOf,
  TRAFFIC_REJOIN_NEAR_MAX_SECONDS,
  TRAFFIC_REJOIN_NEAR_MIN_SECONDS,
  TRAFFIC_REJOIN_RIGHT_BEHIND_S,
  type TrafficPitExit,
  type TrafficPitExitVerdict,
  type TrafficRejoin,
} from "@iracedeck/event-bus";
import { TrkLoc } from "@iracedeck/iracing-sdk";
import type { TelemetryData } from "@iracedeck/sim-events-iracing";

import type { EndsOn, ScenarioContext, ScenarioContract, SpeakGate } from "../../dsl.js";
import { DEFAULT_MAX_QUEUE_WAIT_MS, NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { DevelopmentFeature } from "../../reference/pack-reference.js";

/** The clip group every traffic line lives in, the fixed lines and the middles alike. */
export const TRAFFIC_GROUP = "traffic";

/**
 * The weight of the traffic warnings — right behind, both `near` calls, the
 * pack line, the pit-exit traffic warning and the merge warning — strictly
 * between `WEIGHT.SAFETY` (70) and
 * `WEIGHT.CRITICAL` (100), with `interrupt` (spec decision 6, amended
 * 2026-11-17). A car arriving within seconds at a stopped car, or at the
 * merge beside the player, outranks a caution or flag line at `SAFETY`, which
 * is queueable and replays after the warning; at `SAFETY` the warning could
 * only wait behind it, and dropped after its short wait. The `CRITICAL` lines
 * (the meatball, the start lights, fuel critical) and the spotter's
 * `PROXIMITY` calls still win.
 */
export const TRAFFIC_WARNING_WEIGHT = 85;

/**
 * How long a traffic line whose words decay while it waits may wait for the
 * bus before it is dropped: the close calls (right behind, and both `near`
 * calls), whose seconds count down, the pack line, about cars going by within
 * seconds, and the pit-exit traffic warning and merge warning, about a car
 * reaching the merge within seconds of the player. Short, because heard
 * late each describes a car that has already gone by; the detector speaks
 * again on the next closer band or count, so a dropped one is replaced. The
 * pit-exit clear call waits the engine default instead (module header).
 */
export const TRAFFIC_MAX_QUEUE_WAIT_MS = 3000;

/**
 * How long the right-behind line may wait for the bus, from when it was first
 * due: {@link TRAFFIC_REJOIN_RIGHT_BEHIND_S}, the bound its speak-time gate
 * drops it at (module header, "Never heard after the moment it warns about").
 * The same bound for a line only deferred, which the gate would refuse at
 * replay anyway, and the only one for a line an interrupt cut out of
 * playback, which the engine replays without asking its gate again: the wait
 * keeps counting across a cut (#1681).
 */
export const TRAFFIC_REJOIN_RIGHT_BEHIND_MAX_QUEUE_WAIT_MS = TRAFFIC_REJOIN_RIGHT_BEHIND_S * 1000;

/** The supersede group of the rejoin lines: a newer one makes a waiting older one wrong. */
export const TRAFFIC_REJOIN_SUPERSEDE_GROUP = "traffic-rejoin";

/**
 * What ends every rejoin line (module header, amended 2026-11-20): the
 * player's car taken off the track mid-stop, a tow or a reset above all. A
 * line playing stops at once, and one waiting is dropped.
 */
export const TRAFFIC_REJOIN_ENDS_ON: EndsOn = {
  event: "traffic.rejoinTowed",
  description:
    "Your car is taken off the track while you are stopped: towed or reset to the pits, or you leave the car. A line playing stops at once and a waiting one is dropped.",
};

/** The supersede group of the two pit-exit lines. */
export const TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP = "traffic-pit-exit";

/**
 * The var that speaks the close band's seconds: the clause that closes the
 * `near` line's sentence after its lead-in ("Car coming in" or "Getting
 * closer,", then "about five seconds."), never a sentence of its own.
 */
export const REJOIN_SECONDS_VAR = "traffic.rejoinSeconds";

/** The condition true on the call that introduces a car (module header). */
export const REJOIN_FIRST_COND = "traffic.rejoinFirst";

/** The case naming the band of the nearest car's arrival while stopped. */
export const REJOIN_BAND_CASE = "traffic.rejoinBand";

/**
 * The seven lines, rejoin first in band order and the group call after them,
 * then the pit exit's verdicts and its merge warning. Each key is the
 * contract id's suffix, `pit-crew.traffic-<key>`.
 */
export type TrafficLine =
  | "rejoin-right-behind"
  | "rejoin-near-first"
  | "rejoin-near-update"
  | "rejoin-pack"
  | "pit-exit-traffic"
  | "pit-exit-clear"
  | "pit-exit-merge";

type RejoinLine = Extract<TrafficLine, `rejoin-${string}`>;
/** The two verdict lines of `traffic.pitExit`; the merge warning has an event of its own. */
type PitExitLine = Exclude<Extract<TrafficLine, `pit-exit-${string}`>, "pit-exit-merge">;

type LineSpec = {
  /** {@link TRAFFIC_WARNING_WEIGHT} for a warning, `WEIGHT.SAFETY` otherwise (module header). */
  weight: number;
  /** Whether the line cuts a lower-weight line in flight. */
  interrupt: boolean;
  /**
   * How long the line may wait for the bus (module header): {@link TRAFFIC_MAX_QUEUE_WAIT_MS}
   * for a line whose words decay while it waits ({@link TRAFFIC_REJOIN_RIGHT_BEHIND_MAX_QUEUE_WAIT_MS}
   * for right behind), the engine default for the
   * pit-exit clear call, since what would make it false is a newer verdict of
   * its trigger, which replaces it in the queue (`supersedeGroup`), short of
   * the one gap the module header names.
   */
  maxQueueWaitMs: number;
  /** One sentence for a pack author, in the sim's terms (#1066). */
  description: string;
};

// ─── The introduction (module header: a count is an update only once the first call was heard) ───

/** Whether the current approach has been introduced: a first call about it took the bus. */
let introduced = false;

/**
 * The payload of the `near` event whose first call introduced the approach,
 * or null (an imperative fire, or not introduced). Compared by identity with
 * a new approach's `first: true` event, so this family's subscriber leaves
 * standing the introduction that very event's call has just made.
 */
let introducedBy: TrafficRejoin | null = null;

/** The bus the approach tracking listens on, and how to stop listening there. */
let trackedBus: IEventBus | null = null;
let stopTracking: (() => void) | null = null;

/** The first call's gate: its claim, the last (and only) thing it does. Always admits. */
function markIntroduced(data: TrafficRejoin | null): boolean {
  introduced = true;
  introducedBy = data;

  return true;
}

/** Forget the current approach's introduction, so the next `near` event is spoken as a first call. */
function clearIntroduction(): void {
  introduced = false;
  introducedBy = null;
}

/** The pack line's gate: the group replaces the lone car's approach. Always admits. */
function endApproach(): boolean {
  clearIntroduction();

  return true;
}

/** A `near` event the detector marks as the first call of a new approach. */
function startsApproach(d: TrafficRejoin): boolean {
  return d.verdict === "near" && d.first === true;
}

/**
 * Whether a `near` event is spoken as the first call: the detector's own first
 * call, or a later count of an approach whose first call never took the bus.
 * A pure read of the module state — the contracts' `where:` call it.
 */
function speaksAsFirstCall(d: TrafficRejoin): boolean {
  return d.verdict === "near" && (d.first === true || !introduced);
}

/**
 * Whether a `near` event is spoken as an update: a later count of an approach
 * the driver has heard about. Pure. Never the count that introduced it: the
 * bus hands one event to each contract's `where:` in turn, and the first
 * call's can match it, take an idle bus and be admitted — introducing the car
 * — before this one is asked about the same event.
 */
function speaksAsUpdate(d: TrafficRejoin): boolean {
  return d.verdict === "near" && d.first === false && introduced && introducedBy !== d;
}

/** This family's subscriber on `traffic.rejoin`: a new approach starts unintroduced (module header). */
function handleRejoin(event: SimEventOf<"traffic.rejoin">): void {
  // The engine may already have admitted this very event's first call (its
  // handler can run before this one), which set `introducedBy` to it.
  if (startsApproach(event.data) && event.data !== introducedBy) clearIntroduction();
}

/**
 * Listen on `bus` for what ends an introduction outside a line taking the bus
 * (module header): a new approach's first call, and `session.changed`.
 * Registering again on the same bus does nothing; a different bus — a fresh
 * engine — moves the listening there and starts from no introduction, rather
 * than throwing, since every caller of `registerPitCrew` reaches this.
 */
export function registerTrafficApproachTracking(bus: IEventBus): void {
  if (trackedBus === bus) return;

  stopTracking?.();
  clearIntroduction();

  const unsubscribeRejoin = bus.subscribe("traffic.rejoin", handleRejoin);
  const unsubscribeSession = bus.subscribe("session.changed", clearIntroduction);

  trackedBus = bus;
  stopTracking = () => {
    unsubscribeRejoin();
    unsubscribeSession();
  };
}

/** @internal Exported for test isolation only: stops listening and forgets the introduction. */
export function _resetTrafficState(): void {
  stopTracking?.();
  stopTracking = null;
  trackedBus = null;
  clearIntroduction();
}

/**
 * This file's module state, for the Telemetry Snapshot (issue #1387): whether
 * the approach tracking listens on a bus, and whether the current approach
 * has been introduced. A pure read, and safe before
 * {@link registerTrafficApproachTracking}. The introducing payload itself is
 * left out.
 */
export function readTrafficDebugState(): { registered: boolean; introduced: boolean } {
  return { registered: trackedBus !== null, introduced };
}

type RejoinLineSpec = LineSpec & {
  /** The `where:` check: pure, reading the event and at most the introduction. */
  matches: (d: TrafficRejoin) => boolean;
  /** The speak-time gate: whether the line is still true as it reaches the radio, and what taking the bus does to the introduction. */
  speakGate?: SpeakGate;
};

const REJOIN_LINES: Record<RejoinLine, RejoinLineSpec> = {
  "rejoin-right-behind": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // A car under two seconds away has arrived two seconds after the line was
    // due: the gate's bound, which also bounds a replay after a cut.
    maxQueueWaitMs: TRAFFIC_REJOIN_RIGHT_BEHIND_MAX_QUEUE_WAIT_MS,
    description: "You are stopped or crawling on track and the nearest car will reach you in under two seconds.",
    // Needs no introduction, and leaves the introduction alone.
    matches: (d) => d.verdict === "rightBehind",
    speakGate: {
      description:
        "Dropped if it waited for the radio for more than two seconds, since the car has reached you by then.",
      admit: closeCarStillComing,
    },
  },
  "rejoin-near-first": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: its seconds count down while it waits.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description:
      "You are stopped or crawling on track and a car comes within ten seconds of reaching you: the first call about it you hear, naming its arrival in whole seconds.",
    matches: speaksAsFirstCall,
    speakGate: {
      description:
        "Dropped if it waited for the radio as long as the seconds it names, as the car has reached you by then; speaking it marks the car as introduced, so later counts are updates.",
      // The check first, the claim last: a refused call introduces nothing.
      admit: (ctx) => closeCarStillComing(ctx) && markIntroduced(rejoinOf(ctx)),
    },
  },
  "rejoin-near-update": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: its seconds count down while it waits.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description:
      "You are still stopped and the car within ten seconds keeps closing: called again each time its arrival has dropped by three seconds or more, once the first call was heard.",
    matches: speaksAsUpdate,
    speakGate: {
      description:
        "Dropped if it waited for the radio as long as the seconds it names, as the car has reached you by then.",
      admit: closeCarStillComing,
    },
  },
  "rejoin-pack": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: the group is going by within seconds, and heard late it is past.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description:
      "You are stopped or crawling on track and a group of cars is coming, the nearest within ten seconds: said once for the group in place of the per-car calls.",
    matches: (d) => d.verdict === "pack",
    speakGate: {
      description:
        "Always spoken once it reaches the radio; speaking it ends a single car's approach, so the next car within ten seconds after the group gets a first call.",
      admit: endApproach,
    },
  },
};

type PitExitLineSpec = LineSpec & {
  verdict: TrafficPitExitVerdict;
  /** The speak-time gate's sentence for the pack reference: dropped once the player is back on the racing surface or out of the world. */
  gateDescription: string;
};

const PIT_EXIT_LINES: Record<PitExitLine, PitExitLineSpec> = {
  "pit-exit-traffic": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: a warning about a car at the merge within seconds of the player
    // is no use once the player is merging.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    verdict: "traffic",
    // The call point, the held flip and the untimed car: `traffic-pit-exit.ts`'s module header.
    description:
      "About 3 s before pit road ends (on leaving a nearer stall, past it if landmarks or pit limit come late), again on a held flip before the merge: a car on track meets you at the blend end or is untimed.",
    gateDescription:
      "Dropped once you are back on the racing surface or reset to the garage, since the merge it warns about is over.",
  },
  "pit-exit-clear": {
    // Not a warning: SAFETY, so it does not cut a caution line; it still cuts
    // an exit readback or a tire-wear report in flight (module header).
    weight: WEIGHT.SAFETY,
    interrupt: true,
    // The default: traffic turning up is a flipped verdict, which replaces it
    // in the queue once it has held (the one gap: module header).
    maxQueueWaitMs: DEFAULT_MAX_QUEUE_WAIT_MS,
    verdict: "clear",
    description:
      "About 3 s before pit road ends (on leaving a nearer stall, past it if landmarks or pit limit come late), again on a held flip before the merge: no car on track meets you at the blend end.",
    gateDescription:
      "Dropped once you are back on the racing surface or reset to the garage, since the merge it is about is over.",
  },
};

/** The rejoin payload of the fire's own event, or null for any other event (or an imperative fire). */
function rejoinOf(ctx: Pick<ScenarioContext, "event">): TrafficRejoin | null {
  return ctx.event?.event === "traffic.rejoin" ? (ctx.event as SimEventOf<"traffic.rejoin">).data : null;
}

/**
 * Whether the car a close call is about is still to reach the player as the
 * line is about to be heard (module header): the fire's age, from its event's
 * timestamp to the gate's `now`, is at most {@link TRAFFIC_REJOIN_RIGHT_BEHIND_S}
 * for right behind, and under the event's `seconds` for a `near` call. Admits
 * an imperative fire, any other verdict, an event without a usable timestamp
 * and a clock that stepped back, so a line that plays at once always does. A
 * pure read of the fire.
 */
function closeCarStillComing(ctx: Pick<ScenarioContext, "event" | "now">): boolean {
  const data = rejoinOf(ctx);
  const timestamp = ctx.event?.timestamp;

  if (data === null || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return true;

  const ageMs = ctx.now - timestamp;

  if (!(ageMs > 0)) return true;

  if (data.verdict === "rightBehind") return ageMs <= TRAFFIC_REJOIN_RIGHT_BEHIND_S * 1000;

  if (data.verdict !== "near" || typeof data.seconds !== "number" || !Number.isFinite(data.seconds)) return true;

  return ageMs < data.seconds * 1000;
}

/** The pit-exit payload of the fire's own event, or null for any other event (or an imperative fire). */
function pitExitOf(ctx: Pick<ScenarioContext, "event">): TrafficPitExit | null {
  return ctx.event?.event === "traffic.pitExit" ? (ctx.event as SimEventOf<"traffic.pitExit">).data : null;
}

/**
 * The merge warning (module header): a warning, like the pit-exit traffic
 * line, with its weight, interrupt, short wait and speak-time gate.
 */
const PIT_EXIT_MERGE_LINE: LineSpec & { gateDescription: string } = {
  weight: TRAFFIC_WARNING_WEIGHT,
  interrupt: true,
  // Short: a car at the merge within a second or two of the player is there
  // by the time a late line plays.
  maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
  description:
    "In the pit exit lane, past the end of pit road, a car on track is predicted to reach the end of the pit exit blend line within the Pit exit merge warning seconds of you: said once per pit exit.",
  gateDescription:
    "Dropped once you are back on the racing surface or reset to the garage, since the merge it warns about is over.",
};

/**
 * The middle's clip base for a rejoin payload, `rejoin-mid-<N>`, or null when
 * it is not a `near` verdict or its `seconds` is not a whole number in the
 * close band — `TRAFFIC_REJOIN_NEAR_MIN_SECONDS` to
 * `TRAFFIC_REJOIN_NEAR_MAX_SECONDS`, 2 to 9, the event's own range, imported
 * from `@iracedeck/event-bus` as the translator's detector imports the band
 * edges they come from. A value outside is a malformed payload — a harness or
 * third-party publisher — and says nothing rather than naming a figure the
 * band does not hold.
 */
export function rejoinMidBase(data: TrafficRejoin | null | undefined): string | null {
  if (!data || data.verdict !== "near") return null;

  const n = data.seconds;

  if (typeof n !== "number" || !Number.isInteger(n)) return null;

  if (n < TRAFFIC_REJOIN_NEAR_MIN_SECONDS || n > TRAFFIC_REJOIN_NEAR_MAX_SECONDS) return null;

  return `rejoin-mid-${n}`;
}

/**
 * Register the vocabulary the traffic script references (issue #1113): the
 * middle var, the band case and the first-call condition for the rejoin, and
 * the verdict and nearest-side cases for the pit exit. Must run before the
 * contracts are defined so the first `setScripts` compile sees every name.
 */
export function registerTrafficVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">,
): void {
  engine.defineVar(
    REJOIN_SECONDS_VAR,
    (ctx) => {
      const base = rejoinMidBase(rejoinOf(ctx));

      return base === null ? null : poolRef(TRAFFIC_GROUP, base);
    },
    'The nearest car\'s arrival in whole seconds, 2 to 9, as the clause that closes the near line after its lead-in ("Car coming in" or "Getting closer,", then traffic/rejoin-mid-5, "about five seconds."), drawn from the traffic group\'s rejoin-mid pool for that number, each take a different wording. Nothing outside the close band.',
  );

  engine.defineCond(
    REJOIN_FIRST_COND,
    (ctx) => {
      const data = rejoinOf(ctx);

      if (data === null) return false;

      // Pure: the introduction is read, never written. A first call replayed
      // whole after a cut is still one: its own admit introduced the car.
      return speaksAsFirstCall(data) || (introducedBy !== null && introducedBy === data);
    },
    "True on the call that introduces a car coming within ten seconds of reaching you (a later count too when the first call about it was never heard), false on a count after it and on every other rejoin line.",
  );

  engine.defineCase(
    REJOIN_BAND_CASE,
    (ctx) => rejoinOf(ctx)?.verdict ?? null,
    {
      rightBehind: "The nearest car will reach you in under two seconds.",
      near: "The nearest car will reach you in two to nine seconds.",
      pack: "A group of cars is coming: the nearest under ten seconds away and more close behind it.",
    },
    "The band the nearest car's predicted arrival falls in while you are stopped on track, read from the event that fired the line.",
  );

  engine.defineCase(
    "traffic.pitExitVerdict",
    (ctx) => pitExitOf(ctx)?.verdict ?? null,
    {
      traffic:
        "A car on track will reach the end of the pit exit blend line around the same time as you, or a car on track could not be timed.",
      clear: "No car on track will reach the end of the pit exit blend line around the same time as you.",
    },
    "The verdict on leaving the pits, read from the event that fired the line.",
  );

  engine.defineCase(
    "traffic.pitExitNearestSide",
    (ctx) => {
      const seconds = pitExitOf(ctx)?.seconds;

      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;

      return seconds < 0 ? "before" : "after";
    },
    {
      before:
        "The nearest car reaches the end of the pit exit blend line before you do: it will be beside or ahead of you.",
      after:
        "The nearest car reaches the end of the pit exit blend line when you do or after you: it will be beside or behind you.",
    },
    "Which side of your own arrival at the end of the pit exit blend line the nearest timed car arrives on; nothing when no car on track could be timed.",
  );
}

function trafficContract(line: TrafficLine, spec: LineSpec): ScenarioContract {
  return {
    id: `pit-crew.traffic-${line}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "traffic",
    weight: spec.weight,
    interrupt: spec.interrupt,
    // Queued: the detector says a line once and not again until the picture
    // changes, so a dropped one is lost (module header).
    queueable: true,
    maxQueueWaitMs: spec.maxQueueWaitMs,
    description: spec.description,
  };
}

function rejoinContract(line: RejoinLine): ScenarioContract {
  const spec = REJOIN_LINES[line];

  return {
    ...trafficContract(line, spec),
    ...(spec.speakGate ? { speakGate: spec.speakGate } : {}),
    // A tow or a reset cuts it, playing or waiting (module header).
    endsOn: TRAFFIC_REJOIN_ENDS_ON,
    supersedeGroup: TRAFFIC_REJOIN_SUPERSEDE_GROUP,
    // Unframed: the rejoin lines repeat while the car stays stopped, and the
    // radio ticks around every one would drown the words (the spotter's
    // reason, decision D1 of #651).
    frame: NO_FRAME,
    when: {
      event: "traffic.rejoin",
      where: (e) => spec.matches((e as SimEventOf<"traffic.rejoin">).data),
    },
  };
}

/** What the pit-exit lines' speak-time gates read: the live telemetry (#1378's reader). */
export type TrafficContractDeps = {
  /** The latest telemetry tick as the sim reported it; `null` with none (no sim, or the scenario harness). */
  getLatestTelemetry: () => TelemetryData | null;
};

/**
 * Whether the player is still short of the merge as a pit-exit line is about
 * to be heard (module header): not back on the racing surface, the pit-exit
 * detector's own end of the exit, and not out of the world (`NotInWorld`: a
 * reset or a tow to the garage, which ends the detector's episode too). The
 * exit lane and the stall admit: the surface can still read the stall for a
 * tick after the car has driven out, the tick a near stall's call is made
 * on. No telemetry, or no surface read, admits.
 */
function stillLeavingThePits(deps: TrafficContractDeps): boolean {
  const surface = deps.getLatestTelemetry()?.PlayerTrackSurface;

  return surface !== TrkLoc.OnTrack && surface !== TrkLoc.OffTrack && surface !== TrkLoc.NotInWorld;
}

function pitExitContract(line: PitExitLine, deps: TrafficContractDeps): ScenarioContract {
  const spec = PIT_EXIT_LINES[line];

  return {
    ...trafficContract(line, spec),
    speakGate: { description: spec.gateDescription, admit: () => stillLeavingThePits(deps) },
    // A cut call is gone, never replayed (module header): its gate is not
    // asked again on a replay, and what cut it is the more current line.
    dropWhenCut: true,
    supersedeGroup: TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP,
    when: {
      event: "traffic.pitExit",
      where: (e) => (e as SimEventOf<"traffic.pitExit">).data.verdict === spec.verdict,
    },
  };
}

/** The merge warning's contract (module header): on `traffic.pitExitMerge`, gated like the pit-exit lines. */
function pitExitMergeContract(deps: TrafficContractDeps): ScenarioContract {
  return {
    ...trafficContract("pit-exit-merge", PIT_EXIT_MERGE_LINE),
    speakGate: { description: PIT_EXIT_MERGE_LINE.gateDescription, admit: () => stillLeavingThePits(deps) },
    // Like the calls: a cut merge warning is gone, never replayed (module header).
    dropWhenCut: true,
    when: { event: "traffic.pitExitMerge" },
  };
}

/**
 * The seven contracts, rejoin first in band order, the pit-exit gates closing
 * over `deps`' telemetry read. `registerPitCrew` builds them with the live
 * reader.
 */
export function buildTrafficContracts(deps: TrafficContractDeps): readonly ScenarioContract[] {
  return [
    rejoinContract("rejoin-right-behind"),
    rejoinContract("rejoin-near-first"),
    rejoinContract("rejoin-near-update"),
    rejoinContract("rejoin-pack"),
    pitExitContract("pit-exit-traffic", deps),
    pitExitContract("pit-exit-clear", deps),
    pitExitMergeContract(deps),
  ];
}

/**
 * A build with no sim wired, for the id lists and the tests: a read cannot
 * change an id, and with no telemetry the telemetry-reading gates admit, as
 * they do in the scenario harness.
 */
export const TRAFFIC_CONTRACTS: readonly ScenarioContract[] = buildTrafficContracts({ getLatestTelemetry: () => null });

/** The traffic family's opt-in ids: `rejoin` and `pit-exit` (`@iracedeck/callout-settings`). */
export type TrafficCalloutId = CalloutIdOf<typeof TRAFFIC_CALLOUTS>;

/** Every rejoin line rides the `rejoin` opt-in, both pit-exit lines and the merge warning the `pit-exit` one. */
export const SCENARIO_ID_TO_TRAFFIC_ID: Record<string, TrafficCalloutId> = {
  "pit-crew.traffic-rejoin-right-behind": "rejoin",
  "pit-crew.traffic-rejoin-near-first": "rejoin",
  "pit-crew.traffic-rejoin-near-update": "rejoin",
  "pit-crew.traffic-rejoin-pack": "rejoin",
  "pit-crew.traffic-pit-exit-traffic": "pit-exit",
  "pit-crew.traffic-pit-exit-clear": "pit-exit",
  "pit-crew.traffic-pit-exit-merge": "pit-exit",
};

export const TRAFFIC_SCENARIO_IDS: readonly string[] = TRAFFIC_CONTRACTS.map((c) => c.id);

/**
 * The rejoin warnings as a development feature (#1113, the spec's fourth
 * amendment): they do not ship. The `trafficRejoin` platform flag, off in
 * every plugin's committed `platform-features.json`, keeps the translator's
 * detector from running and the rejoin lines silent (`getTrafficRejoinAvailable`
 * on `PitCrewDeps`), and its checkbox out of the settings window (the
 * `rejoin` entry's `requiresFeature` in `@iracedeck/callout-settings`, which
 * names the same flag). Their contracts, vocabulary, script entries and clips
 * stay, so a development build and the scenario harness run them as before;
 * what this names is what the pack-author reference withholds while no release
 * build carries the flag: the four rejoin contracts, the seconds var, the
 * first-call condition and the band case.
 */
export const TRAFFIC_REJOIN_DEVELOPMENT_FEATURE: DevelopmentFeature = {
  flag: "trafficRejoin",
  withheld: {
    contracts: Object.entries(SCENARIO_ID_TO_TRAFFIC_ID)
      .filter(([, id]) => id === "rejoin")
      .map(([scenarioId]) => scenarioId),
    vars: [REJOIN_SECONDS_VAR],
    conds: [REJOIN_FIRST_COND],
    cases: [REJOIN_BAND_CASE],
  },
};

/**
 * The clip sources the traffic script addresses directly — every
 * `pool:traffic/<base>` the bundled script may write, as a literal list. The
 * completeness tests read it: the bundled voice must ship a clip for each, and
 * the bundled script must reference exactly this set. The middles are not
 * sources: they are the {@link REJOIN_SECONDS_VAR} var, drawn from the same
 * group at speak time.
 */
export const TRAFFIC_CLIP_SOURCES: readonly { group: typeof TRAFFIC_GROUP; base: string }[] = [
  { group: TRAFFIC_GROUP, base: "rejoin-intro" },
  { group: TRAFFIC_GROUP, base: "rejoin-outro" },
  { group: TRAFFIC_GROUP, base: "rejoin-update" },
  { group: TRAFFIC_GROUP, base: "rejoin-right-behind" },
  { group: TRAFFIC_GROUP, base: "rejoin-pack" },
  { group: TRAFFIC_GROUP, base: "pit-exit-traffic" },
  { group: TRAFFIC_GROUP, base: "pit-exit-clear" },
  { group: TRAFFIC_GROUP, base: "pit-exit-merge" },
];
