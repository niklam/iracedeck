/**
 * Pit limiter warnings — four contracts covering the different limiter
 * anomaly states emitted by `@iracedeck/sim-events-iracing` (issue #1051;
 * scripted since #1065):
 *
 *   - `pitLane.exited` (delayed): limiter still engaged a beat after leaving
 *     pit road. Suppressed while on pit road because that's the expected
 *     behavior.
 *   - `limiter.missing` (delayed): entered pit road without the limiter on.
 *   - `limiter.dropped`: limiter disengaged while still between pit cones.
 *     Ended by `pitLane.exited` (`endsOn`, issue #1407), because the warning
 *     is only true while the car is on pit road: a fire still waiting is
 *     dropped, one still in its open click stops silently, and one already
 *     speaking is cut and abandoned through the voice's `cut` tail.
 *   - `limiter.speeding`: above the pit speed limit.
 *
 * The code below decides WHETHER and WHEN each warning fires and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.limiter-on-track"]`, …), where the
 * bundled script addresses each line as `pool:pit-limiter/<base>`. The two
 * DELAYED warnings additionally carry their speak-time re-check as the
 * contract's `speakGate` (issue #1138), and publish the same read as a
 * condition (the family's `registerVocabulary`) — see the note on the two
 * delayed conditions below. Both halves come from one
 * {@link buildPitLimiter} over the family's one sim read, the latest
 * telemetry tick (#1378).
 *
 * All four use the default weight (`WEIGHT.NORMAL`) — informational callouts
 * that yield to higher-weight in-flight pit-lane messages.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, PIT_LIMITER_CALLOUTS } from "@iracedeck/callout-settings";
import { hasPitLimiter, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ScenarioContract } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Delay before re-checking that the limiter is STILL engaged after leaving pit
 * road, and before re-checking that it is STILL not engaged after arriving
 * (issue #1051). Both are deliberately short: long enough for a driver who is
 * already reaching for the button to beat the callout, short enough that the
 * line still arrives while it is worth acting on.
 */
export const LIMITER_ON_TRACK_DELAY_MS = 1500;
export const LIMITER_MISSING_DELAY_MS = 2500;

/**
 * The family's one sim read (#1378): live telemetry for the two DELAYED
 * contracts below, injected rather than imported from the translator.
 *
 * Read live, NOT from `e.telemetry`, and that distinction is the whole point of
 * the delay. `triggerDelay` re-runs `where:` after N ms, but the interpreter
 * calls it with the ORIGINAL event envelope, whose telemetry was captured when
 * the event was published. Testing `e.telemetry` would therefore re-examine a
 * snapshot from before the window we are waiting through — the delay would be
 * decorative, the callout would fire at a driver who has already fixed it, and
 * every test that only checks "does it fire" would still pass.
 *
 * Same reasoning and same source as `flag-alerts.ts`'s `furledBitUp` /
 * `penaltyBitUp` (#846). Do not "simplify" these back to `e.telemetry`.
 */
export type PitLimiterDeps = {
  getLatestTelemetry: () => TelemetryData | null;
};

/**
 * One build of the pit-limiter family (#1378): the two delayed re-checks as
 * conditions, and the four contracts whose gates are those same reads.
 * Register the vocabulary before the contracts, as every family does.
 */
export type PitLimiterFamily = {
  registerVocabulary(engine: Pick<IScenarioEngine, "defineCond">): void;
  contracts: readonly ScenarioContract[];
};

/**
 * The two delayed re-checks, each written ONCE and used three times: as the
 * `where:` fire decision, as the contract's `speakGate` (issue #1138) when
 * the line comes to speak, and — through the vocabulary — as a condition a
 * pack may write its own `if` on. Sharing the definition is deliberate: the
 * flag-alerts precedent (#846) notes that two layers with their own copy of
 * "is this still true" can drift apart, and here a drift would mean
 * announcing a limiter state the driver already fixed. Both are pure reads,
 * which is what lets the same function be a published condition.
 */
function limiterStillEngagedOffPitRoad(deps: PitLimiterDeps): boolean {
  const telemetry = deps.getLatestTelemetry();

  // Suppress on cars without a pit limiter (issue #639).
  if (!hasPitLimiter(telemetry)) return false;

  return telemetry?.dcPitSpeedLimiterToggle === true && telemetry?.OnPitRoad !== true;
}

function limiterStillMissingOnPitRoad(deps: PitLimiterDeps): boolean {
  const telemetry = deps.getLatestTelemetry();

  // Cars without a pit limiter can't be "missing" one (issue #639).
  if (!hasPitLimiter(telemetry)) return false;

  return telemetry?.dcPitSpeedLimiterToggle !== true && telemetry?.OnPitRoad === true;
}

/**
 * Define the vocabulary the pit-limiter family publishes (issue #1065) — what
 * a build's `registerVocabulary` does, over that build's reads (#1378):
 * the two delayed warnings' re-checks, as conditions. Queueing (below)
 * reintroduces the staleness the delay removed — a fire that waited behind a
 * busier line can speak after the driver fixed the problem — and since #1138
 * the engine asks the question itself through each contract's `speakGate`, so
 * the bundled entries are the clip alone and reference neither name. They
 * stay published for a pack that wants its own `if`: harmless where it says
 * the same thing, and the pack's own choice where it says less.
 * Descriptions feed the generated reference (#1066).
 */
function definePitLimiterVocabulary(
  engine: Pick<IScenarioEngine, "defineCond">,
  stillEngagedOffPitRoad: () => boolean,
  stillMissingOnPitRoad: () => boolean,
): void {
  engine.defineCond(
    "limiter.stillEngagedOffPitRoad",
    stillEngagedOffPitRoad,
    "The car has a pit limiter and it is still engaged out on the track, according to live telemetry when the line comes to speak — about a second and a half after leaving pit road. The engine already asks this at speak time (it is the warning's own gate), so wrapping the body in it changes nothing; it is here for a pack that wants the warning silent on its own terms. False on a car without a limiter or when telemetry is unavailable.",
  );
  engine.defineCond(
    "limiter.stillMissingOnPitRoad",
    stillMissingOnPitRoad,
    "The car has a pit limiter and it is still NOT engaged on pit road, according to live telemetry when the line comes to speak — a couple of seconds after the pit-entry reminder. The engine already asks this at speak time (it is the warning's own gate), so wrapping the body in it changes nothing; it is here for a pack that wants the warning silent on its own terms. False on a car without a limiter or when telemetry is unavailable.",
  );
}

const limiterOnTrack = (stillEngagedOffPitRoad: () => boolean): ScenarioContract => ({
  id: "pit-crew.limiter-on-track",
  when: {
    // Fires a beat AFTER leaving pit road, not on the limiter toggle (#1051).
    // The toggle is a pure bit-change edge, so a limiter left engaged through
    // the pit exit changes nothing and emits nothing — which made the case
    // everyone actually means ("I forgot to switch it off") permanently silent,
    // while the only reachable case was pressing the button out on track, which
    // a driver already knows they did.
    event: "pitLane.exited",
    where: stillEngagedOffPitRoad,
  },
  description:
    "About a second and a half after you leave pit road, the pit limiter is still switched on, in a car that has one.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  triggerDelay: LIMITER_ON_TRACK_DELAY_MS,
  // `queueable` because at 1.5s after leaving pit road the Voice bus is often
  // still busy with an equal-or-higher-weight line (a flag call, a toggle
  // confirmation, the spotter), and a non-queueable fire arriving then is dropped.
  // Without this the callout would be dropped nearly every time in real
  // driving while passing every test that lets the bus idle first.
  queueable: true,
  // ...and the re-check below, because `queueable` reintroduces the staleness
  // the delay existed to remove: the gate is what removes it again, for every
  // voice (issue #1138).
  speakGate: {
    description:
      "The pit limiter is still engaged out on the track when the warning comes to speak, in a car that has one.",
    admit: stillEngagedOffPitRoad,
  },
});

const limiterMissing = (stillMissingOnPitRoad: () => boolean): ScenarioContract => ({
  id: "pit-crew.limiter-missing",
  when: {
    event: "limiter.missing",
    // Delayed so this is an ESCALATION rather than a duplicate (#1051). The
    // pit-service readback already says "Remember the pit limiter." on the same
    // transition; that early nudge is kept, and this only speaks if it went
    // unheeded. Re-checked live, so engaging the limiter in the meantime is
    // silence rather than a scolding.
    where: stillMissingOnPitRoad,
  },
  description:
    "You drive onto pit road, or pull away from your stall, with the pit limiter off, and it is still off two and a half seconds later, in a car that has one.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  triggerDelay: LIMITER_MISSING_DELAY_MS,
  // Same pair as LIMITER_ON_TRACK: queue rather than be dropped behind the
  // pit-entry traffic this deliberately follows, and re-check at speak time
  // so a driver who engaged the limiter while this waited hears nothing
  // (issue #1138 — the gate is the contract's, so it holds for every voice).
  queueable: true,
  speakGate: {
    description: "The pit limiter is still off on pit road when the warning comes to speak, in a car that has one.",
    admit: stillMissingOnPitRoad,
  },
});

export const LIMITER_DROPPED: ScenarioContract = {
  id: "pit-crew.limiter-dropped",
  when: {
    event: "limiter.dropped",
    // Cars without a pit limiter can't drop one (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  description:
    "You switch the pit limiter off while still between the pit cones and moving at more than a crawl, in a car that has one.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  // The warning is only true on pit road, and on a busy bus it can wait up to
  // `maxQueueWaitMs` and then speak out on the track (issue #1407). The end
  // is this contract's, never the family's: `limiter-on-track` is TRIGGERED
  // by the same event and must still play after it.
  endsOn: {
    event: "pitLane.exited",
    description: "You leave pit road while the warning is waiting or still being spoken.",
  },
};

export const LIMITER_SPEEDING: ScenarioContract = {
  id: "pit-crew.limiter-speeding",
  when: {
    event: "limiter.speeding",
    // A pit-limiter speeding warning is meaningless without a limiter (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  description:
    "You go over the pit speed limit on pit road in a car that has a pit limiter, no more than once every five seconds.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
};

/**
 * Build the pit-limiter family over its sim read (#1378). The two delayed
 * re-checks are each written ONCE per build and used three times — the
 * `where:`, the `speakGate` and the published condition — so the three can
 * never drift apart (the #846 / #1138 rule above).
 */
export function buildPitLimiter(deps: PitLimiterDeps): PitLimiterFamily {
  const stillEngagedOffPitRoad = (): boolean => limiterStillEngagedOffPitRoad(deps);
  const stillMissingOnPitRoad = (): boolean => limiterStillMissingOnPitRoad(deps);

  return {
    registerVocabulary: (engine) => definePitLimiterVocabulary(engine, stillEngagedOffPitRoad, stillMissingOnPitRoad),
    contracts: [
      limiterOnTrack(stillEngagedOffPitRoad),
      limiterMissing(stillMissingOnPitRoad),
      LIMITER_DROPPED,
      LIMITER_SPEEDING,
    ],
  };
}

/** The family's scenario ids, derived from a build with no sim wired — a read cannot change an id. */
export const PIT_LIMITER_SCENARIO_IDS: readonly string[] = buildPitLimiter({
  getLatestTelemetry: () => null,
}).contracts.map((c) => c.id);

/** Stable identifier for each user-toggleable pit-limiter callout (issue #1051). */
export type PitLimiterCalloutId = CalloutIdOf<typeof PIT_LIMITER_CALLOUTS>;

/** Scenario id -> callout id, consumed by `wrapCalloutScenario` in `index.ts`. */
export const SCENARIO_ID_TO_PIT_LIMITER_ID: Record<string, PitLimiterCalloutId> = {
  "pit-crew.limiter-on-track": "on-track",
  "pit-crew.limiter-missing": "missing",
  "pit-crew.limiter-dropped": "dropped",
  "pit-crew.limiter-speeding": "speeding",
};

/**
 * The clip sources the pit-limiter scripts draw from — every
 * `pool:pit-limiter/<base>` the bundled script may write. The clip group is
 * shared with the no-limiter family (the split between the two is by remedy,
 * not by clip location), so this list names only THIS family's bases. The
 * completeness tests read it: the bundled voice must ship at least one clip
 * for each, and the bundled script must reference exactly this set. A
 * `(group, base)` a script addresses is published — renaming a base is a
 * rename in every pack's script and every pack's clip folder. Every base is
 * two-digit-suffixed on disk per the manifest matcher (`<base>(?:-\d{2})?.mp3`);
 * the three-digit names these clips first shipped with matched nothing.
 */
export const PIT_LIMITER_CLIP_SOURCES: readonly { group: "pit-limiter"; base: string }[] = [
  { group: "pit-limiter", base: "on-track" },
  { group: "pit-limiter", base: "missing" },
  { group: "pit-limiter", base: "dropped" },
  { group: "pit-limiter", base: "speeding" },
];
