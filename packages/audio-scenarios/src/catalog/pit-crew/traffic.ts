/**
 * Approaching-traffic family (issue #1113) — the Race Engineer's answer to
 * "is anything coming?" at two moments: stopped or crawling on track after a
 * spin or a stall (`traffic.rejoin`), and on the way out of the pits
 * (`traffic.pitExit`). The translator's detectors (`diff/traffic-rejoin.ts`,
 * `diff/traffic-pit-exit.ts` in `@iracedeck/sim-events-iracing`) decide the
 * verdict and when it is worth saying again; the contracts here only filter
 * on it and schedule the line.
 *
 * The code below decides WHETHER and WHEN each line fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.traffic-rejoin-hold"]`, …), paired at
 * `setScripts` time.
 *
 * **One contract per verdict, not one contract with a `case`.** Whether a
 * line may cut the one in flight is a contract field, and the verdicts need
 * different answers: a hold (a car arriving within the hold window) and a
 * pit-exit traffic warning cut whatever the engineer is saying, while a
 * notice, a clear and a "go" wait their turn. One contract could carry only
 * one `interrupt`. Separate contracts also give each verdict its own harness
 * button, its own reference description and its own script entry, so a pack
 * can phrase every one; the `traffic.rejoinVerdict` / `traffic.pitExitVerdict`
 * cases are still published for a pack that wants to share one body.
 *
 * **One family.** All six share `family: "traffic"` (spec decision 6): a
 * fresh verdict replaces a stale one in flight wholesale, whatever the
 * weights — a "Clear, go." arriving while "hold" still plays cuts it.
 *
 * **Never queued, never stale.** `queueable: false` on every contract: a
 * verdict that cannot take the bus is dropped rather than replayed late,
 * because the detector re-speaks on the next verdict change (or, stopped, on
 * the next few seconds of movement in the nearest gap), so the newer fire is
 * the one worth hearing. Two more fields hold that promise for the fires the
 * engine parks anyway — a heavier fire without `interrupt` waits for the line
 * in flight, queueable or not: each trigger's contracts share one
 * `supersedeGroup`, so a newer verdict removes a waiting older one instead of
 * letting it play after it, and `maxQueueWaitMs` is cut to
 * {@link TRAFFIC_MAX_QUEUE_WAIT_MS}, because the numbers count down while a
 * line waits — "car approaching, three seconds, hold" heard four seconds late
 * describes a car that has already passed.
 *
 * **Weights (spec decision 6).** Hold and pit-exit traffic sit at
 * `WEIGHT.SAFETY` with `interrupt: true`: a car arriving in three seconds cuts
 * routine chatter mid-sentence. Notice, clear and go are `WEIGHT.SAFETY`
 * without interrupt. `PROXIMITY` is not used — it is the spotter's, for cars
 * alongside, and a hold is about a car that is not yet alongside.
 *
 * **Frames.** The rejoin lines are unframed (`NO_FRAME`): they repeat while
 * the car stays stopped, at the detector's cadence, and the open and close
 * ticks around every one would drown the words — the spotter precedent. The
 * pit-exit lines are spoken once per exit and keep the default radio frame.
 *
 * **The numbers are whole lines.** Each numbered rejoin line is recorded
 * once per value, number included ("Car approaching, three seconds, hold.")
 * — a figure spliced between two fixed clips would leave two seams, and
 * conditioning cannot reach a join with sixty predecessors (#1108, #1187).
 * The `traffic.rejoin*Line` vars resolve the event's `seconds` to that value's
 * clip, `traffic/rejoin-<verdict>-<n>`, as a size-one pool; a value the voice
 * has no clip for resolves to nothing and the callout is skipped whole
 * (#835), never a line with a gap. There is no range here: the clips that
 * exist define what is speakable (#836).
 *
 * Session gating (live in the car, on track, off pit road, past the green)
 * lives in the translator's detectors, NOT here, so the contracts stay
 * harness-firable. The file keeps no module state: every resolver reads the
 * fire's own event.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, TRAFFIC_CALLOUTS } from "@iracedeck/callout-settings";
import type {
  SimEventOf,
  TrafficPitExit,
  TrafficPitExitVerdict,
  TrafficRejoin,
  TrafficRejoinVerdict,
} from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The clip group every traffic line lives in, the fixed lines and the numbered ones alike. */
export const TRAFFIC_GROUP = "traffic";

/**
 * How long a traffic fire the engine parked may wait for the bus before it is
 * dropped. Short, because every rejoin number counts down while it waits and
 * the pit-exit verdict is about an arrival a few seconds out; the detector
 * speaks again on the next change, so a dropped verdict is replaced, not
 * lost.
 */
export const TRAFFIC_MAX_QUEUE_WAIT_MS = 3000;

/** The supersede group of the four rejoin verdicts: a newer one makes a waiting older one wrong. */
export const TRAFFIC_REJOIN_SUPERSEDE_GROUP = "traffic-rejoin";

/** The supersede group of the two pit-exit verdicts. */
export const TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP = "traffic-pit-exit";

/** The rejoin verdicts that speak a number, each through its own line var. */
export type TrafficRejoinNumberedVerdict = Exclude<TrafficRejoinVerdict, "go">;

/**
 * Each contract's `description` (#1066): the sim moment, for a pack author,
 * in the sim's terms rather than the detector's.
 */
const REJOIN_DESCRIPTIONS: Record<TrafficRejoinVerdict, string> = {
  clear:
    "You are stopped or crawling on track, off pit road, and no car will reach you within the notice window set in the Race Engineer settings.",
  notice:
    "You are stopped or crawling on track and the nearest car will reach you inside the notice window but outside the hold window, so you should get moving.",
  hold: "You are stopped or crawling on track and the nearest car will reach you inside the hold window, so you should stay put until it has passed.",
  go: "After a hold call, the car you were holding for has passed and no other car will reach you inside the hold window, so you can rejoin.",
};

const PIT_EXIT_DESCRIPTIONS: Record<TrafficPitExitVerdict, string> = {
  traffic:
    "Leaving the pits after a stop, a car on track is predicted to reach the end of the pit exit blend line around the same time as you.",
  clear:
    "Leaving the pits after a stop, no car on track is predicted to reach the end of the pit exit blend line around the same time as you.",
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
 * The clip base a numbered rejoin line speaks for `verdict`, or null when the
 * event is not that verdict or carries no usable count. Only a known-ness
 * check — a positive whole number — never a range: a value the voice has no
 * clip for aborts the callout at expansion (#835, #836).
 */
export function rejoinLineBase(
  verdict: TrafficRejoinNumberedVerdict,
  data: TrafficRejoin | null | undefined,
): string | null {
  if (!data || data.verdict !== verdict) return null;

  const { seconds } = data;

  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) return null;

  return `rejoin-${verdict}-${seconds}`;
}

const REJOIN_LINE_VARS: Record<TrafficRejoinNumberedVerdict, { name: string; description: string }> = {
  clear: {
    name: "traffic.rejoinClearLine",
    description:
      'The whole clear line for the notice window the event carries, drawn from the traffic group (traffic/rejoin-clear-20 is "Nothing behind you for the next twenty seconds."). Nothing on any other verdict, or for a window the voice has no clip for.',
  },
  notice: {
    name: "traffic.rejoinNoticeLine",
    description:
      'The whole notice line for the nearest car\'s arrival in whole seconds, drawn from the traffic group (traffic/rejoin-notice-15 is "Car approaching in about fifteen seconds. Get moving."). Nothing on any other verdict, or for a count the voice has no clip for.',
  },
  hold: {
    name: "traffic.rejoinHoldLine",
    description:
      'The whole hold line for the nearest car\'s arrival in whole seconds, drawn from the traffic group (traffic/rejoin-hold-3 is "Car approaching, three seconds, hold."). Nothing on any other verdict, or for a count the voice has no clip for.',
  },
};

/**
 * Register the vocabulary the traffic script references (issue #1113): one
 * var per numbered rejoin line, and the verdict cases a pack may branch on.
 * Must run before the contracts are defined so the first `setScripts` compile
 * sees every name.
 */
export function registerTrafficVocabulary(engine: Pick<IScenarioEngine, "defineVar" | "defineCase">): void {
  for (const verdict of ["clear", "notice", "hold"] as const) {
    const { name, description } = REJOIN_LINE_VARS[verdict];

    engine.defineVar(
      name,
      (ctx) => {
        const base = rejoinLineBase(verdict, rejoinOf(ctx));

        return base === null ? null : poolRef(TRAFFIC_GROUP, base);
      },
      description,
    );
  }

  engine.defineCase(
    "traffic.rejoinVerdict",
    (ctx) => rejoinOf(ctx)?.verdict ?? null,
    {
      clear: "No car will reach you within the notice window.",
      notice: "A car will reach you inside the notice window but outside the hold window: get moving.",
      hold: "A car will reach you inside the hold window: stay put.",
      go: "After a hold, nothing will reach you inside the hold window any more: go.",
    },
    "The verdict on rejoining the track from a stop, read from the event that fired the line.",
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

function rejoinContract(verdict: TrafficRejoinVerdict): ScenarioContract {
  return {
    id: `pit-crew.traffic-rejoin-${verdict}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "traffic",
    weight: WEIGHT.SAFETY,
    // Only a hold cuts the line in flight: a car is arriving within seconds.
    interrupt: verdict === "hold",
    queueable: false,
    supersedeGroup: TRAFFIC_REJOIN_SUPERSEDE_GROUP,
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    // Unframed: the rejoin lines repeat while the car stays stopped, and the
    // radio ticks around every one would drown the words (the spotter's
    // reason, decision D1 of #651).
    frame: NO_FRAME,
    description: REJOIN_DESCRIPTIONS[verdict],
    when: {
      event: "traffic.rejoin",
      where: (e) => (e as SimEventOf<"traffic.rejoin">).data.verdict === verdict,
    },
  };
}

function pitExitContract(verdict: TrafficPitExitVerdict): ScenarioContract {
  return {
    id: `pit-crew.traffic-pit-exit-${verdict}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "traffic",
    weight: WEIGHT.SAFETY,
    // Traffic at the merge cuts the line in flight; a clear exit waits its turn.
    interrupt: verdict === "traffic",
    queueable: false,
    supersedeGroup: TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP,
    maxQueueWaitMs: TRAFFIC_MAX_QUEUE_WAIT_MS,
    description: PIT_EXIT_DESCRIPTIONS[verdict],
    when: {
      event: "traffic.pitExit",
      where: (e) => (e as SimEventOf<"traffic.pitExit">).data.verdict === verdict,
    },
  };
}

export const TRAFFIC_CONTRACTS: readonly ScenarioContract[] = [
  rejoinContract("clear"),
  rejoinContract("notice"),
  rejoinContract("hold"),
  rejoinContract("go"),
  pitExitContract("traffic"),
  pitExitContract("clear"),
];

/** The traffic family's opt-in ids: `rejoin` and `pit-exit` (`@iracedeck/callout-settings`). */
export type TrafficCalloutId = CalloutIdOf<typeof TRAFFIC_CALLOUTS>;

/** Every rejoin verdict rides the `rejoin` opt-in, both pit-exit verdicts the `pit-exit` one. */
export const SCENARIO_ID_TO_TRAFFIC_ID: Record<string, TrafficCalloutId> = {
  "pit-crew.traffic-rejoin-clear": "rejoin",
  "pit-crew.traffic-rejoin-notice": "rejoin",
  "pit-crew.traffic-rejoin-hold": "rejoin",
  "pit-crew.traffic-rejoin-go": "rejoin",
  "pit-crew.traffic-pit-exit-traffic": "pit-exit",
  "pit-crew.traffic-pit-exit-clear": "pit-exit",
};

export const TRAFFIC_SCENARIO_IDS: readonly string[] = TRAFFIC_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the traffic script addresses directly — every
 * `pool:traffic/<base>` the bundled script may write, as a literal list. The
 * completeness tests read it: the bundled voice must ship a clip for each, and
 * the bundled script must reference exactly this set. The numbered rejoin
 * lines are not sources: they are the `traffic.rejoin*Line` vars, drawn from
 * the same group at speak time.
 */
export const TRAFFIC_CLIP_SOURCES: readonly { group: typeof TRAFFIC_GROUP; base: string }[] = [
  { group: TRAFFIC_GROUP, base: "rejoin-go" },
  { group: TRAFFIC_GROUP, base: "pit-exit-traffic" },
  { group: TRAFFIC_GROUP, base: "pit-exit-clear" },
];
