/**
 * Approaching-traffic family (issue #1113, amended 2026-11-11) — the Race
 * Engineer's answer to "is anything coming?" at two moments: stopped or
 * crawling on track after a spin or a stall (`traffic.rejoin`), and leaving
 * the pit box (`traffic.pitExit`). The translator's detectors
 * (`diff/traffic-rejoin.ts`, `diff/traffic-pit-exit.ts` in
 * `@iracedeck/sim-events-iracing`) decide the band, the number and every
 * timing rule — when a line is first said, when it is counted down, when the
 * next car's band follows a close one; the contracts here only map the event
 * to a line and schedule it.
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.traffic-rejoin-near-first"]`, …), paired
 * at `setScripts` time.
 *
 * **The engineer alerts, never instructs.** The rejoin lines name a fixed
 * band of the nearest predicted arrival — right behind (under 2 s), a number
 * (2 s to under 10 s), more than ten (10 s to under 15 s), clear (15 s or
 * more, or no car) — and never tell a stopped driver to hold or go. Only the
 * close band speaks a number; the bands are fixed because the words name
 * them.
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
 * - **Cleared** by the reassuring lines' gates ("more than ten", "Clear to
 *   rejoin"), when they take the bus: the approach is over, so the next car
 *   within ten seconds is introduced again.
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
 * lost — the entry "Clear to rejoin" after a spin, behind the incident line,
 * was the case. Two fields keep a waiting line true. Each trigger's contracts
 * share one `supersedeGroup`, so a newer verdict removes a waiting older one
 * instead of letting it play after it. And `maxQueueWaitMs` is per line
 * (`LineSpec.maxQueueWaitMs`): the lines whose words decay while they wait —
 * the close calls, whose seconds count down, and the pit-exit traffic warning
 * — take {@link TRAFFIC_MAX_QUEUE_WAIT_MS}, since "about five seconds" heard
 * four seconds late describes a car that has already passed; the reassuring
 * lines — "more than ten", "Clear to rejoin" and the pit-exit clear — take the
 * engine default, since each stays true for as long as it waits: anything that
 * would make it false is a closer band or a flipped verdict, which the
 * detector publishes and which replaces it in the queue.
 *
 * **Weights (spec decision 6, amended 2026-11-17).** The warnings — right
 * behind, both `near` calls and the pit-exit traffic warning — fire at
 * {@link TRAFFIC_WARNING_WEIGHT}, 85, strictly between `WEIGHT.SAFETY` and
 * `WEIGHT.CRITICAL`, with `interrupt`: a car arriving within seconds cuts
 * routine chatter and a caution or flag line mid-sentence, and a cut caution
 * or flag line, being queueable, replays after it. At `SAFETY` a warning could
 * not cut an equal-weight caution line, and a stop is often exactly when a
 * caution is called: the first call waited behind "Caution is out…" and was
 * dropped after its short wait. The meatball, the start lights and fuel
 * critical (`CRITICAL`) and the spotter's transition calls (`PROXIMITY`) still
 * win: a warning waits behind a `CRITICAL` line within its short wait, and a
 * spotter call cuts a warning. "More than ten" and "clear to rejoin" sit at
 * `SAFETY` without `interrupt` and wait their turn. The pit-exit clear call
 * sits at `SAFETY` and keeps `interrupt`: made the moment the player leaves
 * the box, it trumps the exit readback and the tire-wear report (spec, "Pit
 * exit": both pit-exit lines cut in), which are queueable and play afterwards,
 * but it is not a warning and does not cut a caution line. `PROXIMITY` itself
 * is not used — it is the spotter's, for cars alongside, and these are about
 * cars that are not yet alongside.
 *
 * **Frames.** The rejoin lines are unframed (`NO_FRAME`): they repeat while
 * the car stays stopped, at the detector's cadence, and the open and close
 * ticks around every one would drown the words — the spotter precedent. The
 * pit-exit lines are spoken once per exit (again only if the verdict flips)
 * and keep the default radio frame.
 *
 * Session gating (live in the car, on track, off pit road, past the green)
 * lives in the translator's detectors, NOT here, so the contracts stay
 * harness-firable. The one module state is the introduction above; every
 * resolver otherwise reads the fire's own event.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, TRAFFIC_CALLOUTS } from "@iracedeck/callout-settings";
import {
  type IEventBus,
  type SimEventOf,
  TRAFFIC_REJOIN_NEAR_MAX_SECONDS,
  TRAFFIC_REJOIN_NEAR_MIN_SECONDS,
  type TrafficPitExit,
  type TrafficPitExitVerdict,
  type TrafficRejoin,
} from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract, SpeakGate } from "../../dsl.js";
import { DEFAULT_MAX_QUEUE_WAIT_MS, NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The clip group every traffic line lives in, the fixed lines and the middles alike. */
export const TRAFFIC_GROUP = "traffic";

/**
 * The weight of the traffic warnings — right behind, both `near` calls and the
 * pit-exit traffic warning — strictly between `WEIGHT.SAFETY` (70) and
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
 * calls), whose seconds count down, and the pit-exit traffic warning, about a
 * car reaching the merge within seconds of the player. Short, because heard
 * late each describes a car that has already gone by; the detector speaks
 * again on the next closer band or count, so a dropped one is replaced. The
 * reassuring lines wait the engine default instead (module header).
 */
export const TRAFFIC_MAX_QUEUE_WAIT_MS = 3000;

/** The supersede group of the rejoin lines: a newer one makes a waiting older one wrong. */
export const TRAFFIC_REJOIN_SUPERSEDE_GROUP = "traffic-rejoin";

/** The supersede group of the two pit-exit lines. */
export const TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP = "traffic-pit-exit";

/**
 * The var that speaks the close band's seconds: the clause that closes the
 * `near` line's sentence after its lead-in ("Car coming in" or "Getting
 * closer,", then "about five seconds."), never a sentence of its own.
 */
export const REJOIN_SECONDS_VAR = "traffic.rejoinSeconds";

/**
 * The seven lines, rejoin first in band order, then the pit exit. Each key is
 * the contract id's suffix, `pit-crew.traffic-<key>`.
 */
export type TrafficLine =
  | "rejoin-right-behind"
  | "rejoin-near-first"
  | "rejoin-near-update"
  | "rejoin-over-ten"
  | "rejoin-clear"
  | "pit-exit-traffic"
  | "pit-exit-clear";

type RejoinLine = Extract<TrafficLine, `rejoin-${string}`>;
type PitExitLine = Extract<TrafficLine, `pit-exit-${string}`>;

type LineSpec = {
  /** {@link TRAFFIC_WARNING_WEIGHT} for a warning, `WEIGHT.SAFETY` otherwise (module header). */
  weight: number;
  /** Whether the line cuts a lower-weight line in flight. */
  interrupt: boolean;
  /**
   * How long the line may wait for the bus (module header): {@link TRAFFIC_MAX_QUEUE_WAIT_MS}
   * for a line whose words decay while it waits, the engine default for a
   * reassuring line, which stays true as long as it waits because whatever
   * would make it false is a newer verdict of its trigger, which replaces it in
   * the queue (`supersedeGroup`).
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

/** The reassuring lines' gate: the approach is over. Always admits. */
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
  /** What taking the bus does to the introduction, when anything. */
  speakGate?: SpeakGate;
};

const REJOIN_LINES: Record<RejoinLine, RejoinLineSpec> = {
  "rejoin-right-behind": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: a car under two seconds away has arrived by the time a late line plays.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description: "You are stopped or crawling on track and the nearest car will reach you in under two seconds.",
    // Needs no introduction, and leaves the introduction alone.
    matches: (d) => d.verdict === "rightBehind",
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
        "Always spoken once it reaches the radio; speaking it marks the car as introduced, so later counts of it are spoken as updates.",
      admit: (ctx) => markIntroduced(rejoinOf(ctx)),
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
  },
  "rejoin-over-ten": {
    weight: WEIGHT.SAFETY,
    interrupt: false,
    // The default: it stays true while it waits, since a car closing into a
    // closer band is a newer rejoin verdict, which replaces it in the queue.
    maxQueueWaitMs: DEFAULT_MAX_QUEUE_WAIT_MS,
    description:
      "You are stopped or crawling on track and the nearest car is ten to fifteen seconds away, said on stopping, as it closes, or once a close car has gone by.",
    matches: (d) => d.verdict === "overTen",
    speakGate: {
      description:
        "Always spoken once it reaches the radio; speaking it ends the approach, so the next car within ten seconds gets a first call.",
      admit: endApproach,
    },
  },
  "rejoin-clear": {
    weight: WEIGHT.SAFETY,
    interrupt: false,
    // The default: it stays true while it waits, since any car coming within
    // fifteen seconds is a closer band, a newer rejoin verdict that replaces it.
    maxQueueWaitMs: DEFAULT_MAX_QUEUE_WAIT_MS,
    description:
      "You are stopped or crawling on track and no car is within fifteen seconds of you, said on stopping or once a close car has gone by.",
    matches: (d) => d.verdict === "clear",
    speakGate: {
      description:
        "Always spoken once it reaches the radio; speaking it ends the approach, so the next car within ten seconds gets a first call.",
      admit: endApproach,
    },
  },
};

const PIT_EXIT_LINES: Record<PitExitLine, LineSpec & { verdict: TrafficPitExitVerdict }> = {
  "pit-exit-traffic": {
    weight: TRAFFIC_WARNING_WEIGHT,
    interrupt: true,
    // Short: a warning about a car at the merge within seconds of the player
    // is no use once the player is merging.
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    verdict: "traffic",
    description:
      "As you leave your pit box, a car on track is predicted to reach the end of the pit exit blend line around the same time as you.",
  },
  "pit-exit-clear": {
    // Not a warning: SAFETY, so it does not cut a caution line; it still cuts
    // the exit readback and the tire-wear report (module header).
    weight: WEIGHT.SAFETY,
    interrupt: true,
    // The default: it stays true while it waits, since traffic turning up is a
    // flipped verdict, which replaces it in the queue.
    maxQueueWaitMs: DEFAULT_MAX_QUEUE_WAIT_MS,
    verdict: "clear",
    description:
      "As you leave your pit box, no car on track is predicted to reach the end of the pit exit blend line around the same time as you.",
  },
};

/** The rejoin payload of the fire's own event, or null for any other event (or an imperative fire). */
function rejoinOf(ctx: Pick<ScenarioContext, "event">): TrafficRejoin | null {
  return ctx.event?.event === "traffic.rejoin" ? (ctx.event as SimEventOf<"traffic.rejoin">).data : null;
}

/** The pit-exit payload of the fire's own event, or null for any other event (or an imperative fire). */
function pitExitOf(ctx: Pick<ScenarioContext, "event">): TrafficPitExit | null {
  return ctx.event?.event === "traffic.pitExit" ? (ctx.event as SimEventOf<"traffic.pitExit">).data : null;
}

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
    "traffic.rejoinFirst",
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
    "traffic.rejoinBand",
    (ctx) => rejoinOf(ctx)?.verdict ?? null,
    {
      rightBehind: "The nearest car will reach you in under two seconds.",
      near: "The nearest car will reach you in two to nine seconds.",
      overTen: "The nearest car is ten to fifteen seconds away.",
      clear: "No car is within fifteen seconds of you.",
    },
    "The band the nearest car's predicted arrival falls in while you are stopped on track, read from the event that fired the line.",
  );

  engine.defineCase(
    "traffic.pitExitVerdict",
    (ctx) => pitExitOf(ctx)?.verdict ?? null,
    {
      traffic: "A car on track will reach the end of the pit exit blend line around the same time as you.",
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

function pitExitContract(line: PitExitLine): ScenarioContract {
  const spec = PIT_EXIT_LINES[line];

  return {
    ...trafficContract(line, spec),
    supersedeGroup: TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP,
    when: {
      event: "traffic.pitExit",
      where: (e) => (e as SimEventOf<"traffic.pitExit">).data.verdict === spec.verdict,
    },
  };
}

export const TRAFFIC_CONTRACTS: readonly ScenarioContract[] = [
  rejoinContract("rejoin-right-behind"),
  rejoinContract("rejoin-near-first"),
  rejoinContract("rejoin-near-update"),
  rejoinContract("rejoin-over-ten"),
  rejoinContract("rejoin-clear"),
  pitExitContract("pit-exit-traffic"),
  pitExitContract("pit-exit-clear"),
];

/** The traffic family's opt-in ids: `rejoin` and `pit-exit` (`@iracedeck/callout-settings`). */
export type TrafficCalloutId = CalloutIdOf<typeof TRAFFIC_CALLOUTS>;

/** Every rejoin line rides the `rejoin` opt-in, both pit-exit lines the `pit-exit` one. */
export const SCENARIO_ID_TO_TRAFFIC_ID: Record<string, TrafficCalloutId> = {
  "pit-crew.traffic-rejoin-right-behind": "rejoin",
  "pit-crew.traffic-rejoin-near-first": "rejoin",
  "pit-crew.traffic-rejoin-near-update": "rejoin",
  "pit-crew.traffic-rejoin-over-ten": "rejoin",
  "pit-crew.traffic-rejoin-clear": "rejoin",
  "pit-crew.traffic-pit-exit-traffic": "pit-exit",
  "pit-crew.traffic-pit-exit-clear": "pit-exit",
};

export const TRAFFIC_SCENARIO_IDS: readonly string[] = TRAFFIC_CONTRACTS.map((c) => c.id);

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
  { group: TRAFFIC_GROUP, base: "rejoin-over-ten" },
  { group: TRAFFIC_GROUP, base: "rejoin-clear" },
  { group: TRAFFIC_GROUP, base: "pit-exit-traffic" },
  { group: TRAFFIC_GROUP, base: "pit-exit-clear" },
];
