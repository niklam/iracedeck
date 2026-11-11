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
 * may cut the one in flight is a contract field, and the lines need different
 * answers: the close calls (right behind, and both number calls) and both
 * pit-exit lines cut whatever the engineer is saying, while "more than ten"
 * and "clear to rejoin" wait their turn. One contract could carry only one
 * `interrupt`. The `near` verdict is two contracts on its `first` flag — the
 * call that brings a car into the band, and the later count — because the
 * two are worded differently and a pack phrases each. Separate contracts also
 * give each line its own harness button, reference description and script
 * entry; the `traffic.rejoinBand` / `traffic.pitExitVerdict` cases and the
 * `traffic.rejoinFirst` condition are still published for a pack that wants
 * to share one body.
 *
 * **Composed lines (maintainer, 2026-11-11).** A first call in the close band
 * is three whole sentences picked at random from three pools — an intro
 * ("Car coming."), the middle naming the seconds ("About five seconds."),
 * an outro ("Watch out.") — and a later count is an update intro and the
 * middle ("Closer now. About five seconds."). The joins fall at sentence
 * ends, where a pause is natural, so variety costs no seam inside a sentence.
 * The middle is the {@link REJOIN_SECONDS_VAR} var: the event's `seconds`
 * resolved to the `traffic/rejoin-mid-<N>` pool, whose takes are the voice's
 * different wordings of the same figure. The fixed lines are pools of four.
 *
 * **One family.** All seven share `family: "traffic"` (spec decision 6): a
 * fresh line replaces a stale one in flight wholesale, whatever the weights —
 * a closer count arriving while the previous one still plays cuts it.
 *
 * **Never queued, never stale.** `queueable: false` on every contract: a line
 * that cannot take the bus is dropped rather than replayed late, because the
 * detector speaks again on the next band change or the next count, so the
 * newer fire is the one worth hearing. Two more fields hold that promise for
 * the fires the engine parks anyway — a heavier fire without `interrupt`
 * waits for the line in flight, queueable or not: each trigger's contracts
 * share one `supersedeGroup`, so a newer verdict removes a waiting older one
 * instead of letting it play after it, and `maxQueueWaitMs` is cut to
 * {@link TRAFFIC_MAX_QUEUE_WAIT_MS}, because the number counts down while a
 * line waits — "about five seconds" heard four seconds late describes a car
 * that has already passed.
 *
 * **Weights (spec decision 6, as amended).** Every line sits at
 * `WEIGHT.SAFETY`. The close calls and both pit-exit lines interrupt: a car
 * arriving within seconds cuts routine chatter mid-sentence, and the pit-exit
 * call — made the moment the player leaves the box — trumps the exit readback
 * and the tire-wear report, which are queueable and play afterwards. "More
 * than ten" and "clear to rejoin" do not interrupt. `PROXIMITY` is not used —
 * it is the spotter's, for cars alongside, and these are about cars that are
 * not yet alongside.
 *
 * **Frames.** The rejoin lines are unframed (`NO_FRAME`): they repeat while
 * the car stays stopped, at the detector's cadence, and the open and close
 * ticks around every one would drown the words — the spotter precedent. The
 * pit-exit lines are spoken once per exit (again only if the verdict flips)
 * and keep the default radio frame.
 *
 * Session gating (live in the car, on track, off pit road, past the green)
 * lives in the translator's detectors, NOT here, so the contracts stay
 * harness-firable. The file keeps no module state: every resolver reads the
 * fire's own event.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, TRAFFIC_CALLOUTS } from "@iracedeck/callout-settings";
import type { SimEventOf, TrafficPitExit, TrafficPitExitVerdict, TrafficRejoin } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The clip group every traffic line lives in, the fixed lines and the middles alike. */
export const TRAFFIC_GROUP = "traffic";

/**
 * How long a traffic fire the engine parked may wait for the bus before it is
 * dropped. Short, because every rejoin number counts down while it waits and
 * the pit-exit verdict is about an arrival a few seconds out; the detector
 * speaks again on the next change, so a dropped verdict is replaced, not
 * lost.
 */
export const TRAFFIC_MAX_QUEUE_WAIT_MS = 3000;

/** The supersede group of the rejoin lines: a newer one makes a waiting older one wrong. */
export const TRAFFIC_REJOIN_SUPERSEDE_GROUP = "traffic-rejoin";

/** The supersede group of the two pit-exit lines. */
export const TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP = "traffic-pit-exit";

/**
 * The close band's whole seconds, as the event defines them: `near` carries
 * 2 to 9 (the nearest arrival from 2 s to under 10 s, rounded down). A value
 * outside is a malformed payload — a harness or third-party publisher — and
 * says nothing rather than naming a figure the band does not hold.
 */
export const TRAFFIC_NEAR_MIN_SECONDS = 2;
export const TRAFFIC_NEAR_MAX_SECONDS = 9;

/** The var that speaks the close band's seconds as a whole sentence. */
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
  /** Whether the line cuts a lower-weight line in flight. */
  interrupt: boolean;
  /** One sentence for a pack author, in the sim's terms (#1066). */
  description: string;
};

const REJOIN_LINES: Record<RejoinLine, LineSpec & { matches: (d: TrafficRejoin) => boolean }> = {
  "rejoin-right-behind": {
    interrupt: true,
    description: "You are stopped or crawling on track and the nearest car will reach you in under two seconds.",
    matches: (d) => d.verdict === "rightBehind",
  },
  "rejoin-near-first": {
    interrupt: true,
    description:
      "You are stopped or crawling on track and a car comes within ten seconds of reaching you: the first call about it, naming its arrival in whole seconds.",
    matches: (d) => d.verdict === "near" && d.first === true,
  },
  "rejoin-near-update": {
    interrupt: true,
    description:
      "You are still stopped and the car within ten seconds keeps closing: called again each time its arrival has dropped by three seconds or more.",
    matches: (d) => d.verdict === "near" && d.first === false,
  },
  "rejoin-over-ten": {
    interrupt: false,
    description:
      "You are stopped or crawling on track and the nearest car is ten to fifteen seconds away, said on stopping, as it closes, or once a close car has gone by.",
    matches: (d) => d.verdict === "overTen",
  },
  "rejoin-clear": {
    interrupt: false,
    description:
      "You are stopped or crawling on track and no car is within fifteen seconds of you, said on stopping or once a close car has gone by.",
    matches: (d) => d.verdict === "clear",
  },
};

const PIT_EXIT_LINES: Record<PitExitLine, LineSpec & { verdict: TrafficPitExitVerdict }> = {
  "pit-exit-traffic": {
    interrupt: true,
    verdict: "traffic",
    description:
      "As you leave your pit box, a car on track is predicted to reach the end of the pit exit blend line around the same time as you.",
  },
  "pit-exit-clear": {
    interrupt: true,
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
 * close band. The payload is checked at run time too, since a harness or a
 * third-party publisher may hand over a malformed one.
 */
export function rejoinMidBase(data: TrafficRejoin | null | undefined): string | null {
  if (!data || data.verdict !== "near") return null;

  const n = data.seconds;

  if (typeof n !== "number" || !Number.isInteger(n)) return null;

  if (n < TRAFFIC_NEAR_MIN_SECONDS || n > TRAFFIC_NEAR_MAX_SECONDS) return null;

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
    "The nearest car's arrival in whole seconds, 2 to 9, as a whole sentence drawn from the traffic group's rejoin-mid pool for that number (traffic/rejoin-mid-5 is \"About five seconds.\"), each take a different wording. Nothing outside the close band.",
  );

  engine.defineCond(
    "traffic.rejoinFirst",
    (ctx) => {
      const data = rejoinOf(ctx);

      return data?.verdict === "near" && data.first === true;
    },
    "True on the call that brings a car within ten seconds of reaching you, false on a later count of the same approach and on every other rejoin line.",
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
    weight: WEIGHT.SAFETY,
    interrupt: spec.interrupt,
    queueable: false,
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description: spec.description,
  };
}

function rejoinContract(line: RejoinLine): ScenarioContract {
  const spec = REJOIN_LINES[line];

  return {
    ...trafficContract(line, spec),
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
