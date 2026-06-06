/**
 * Start-light family scenarios (issue #480).
 *
 * Three gantry lines (ready / set / go) plus a five-mark numeric pre-start
 * countdown. Each callout wraps its clip in the shared radio frame
 * (`@pit-crew.radio-open` / `@pit-crew.radio-close`) so the engineer voice
 * matches every other Pit Crew message.
 *
 * **Pool-driven clips** (mirrors `flag-alerts.ts`): every scenario draws from a
 * pool defined in `pools.ts` under the `start-light-` prefix, so a future
 * variant pack is a one-line append there.
 *
 * **Family preemption.** All eight share `family: "start-light"` so a newer
 * start-light callout supersedes the in-flight one — e.g. `start-set` arriving
 * while `start-go` is mid-clip, or a faster-than-expected light sequence, never
 * stacks two gantry lines back-to-back; whichever fires last wins.
 *
 * **Weights.** `start-ready` and the five countdown numbers sit at
 * `WEIGHT.SAFETY` (time-critical pre-start information). `start-set` and
 * `start-go` are `WEIGHT.CRITICAL` + `interrupt: true` — "lights are red" and
 * "go, go, go!" must cut anything in flight. The countdown numbers are
 * `queueable: false`: a number that can't take the bus right now is dropped
 * rather than replayed stale a beat later.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf, StartCountdownSeconds } from "@iracedeck/event-bus";
import { isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario, Step } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { POOLS } from "./pools.js";
import { isRaceSession } from "./race-start.js";

function startLightSequence(steps: Step[]): Step[] {
  return ["@pit-crew.radio-open", ...steps, "@pit-crew.radio-close"];
}

// Start lights are a race-only concept spoken to a driver in the car. The diff
// already gates on standing-start + the Warmup/StartReady window, but iRacing
// can raise the grid bits while forming the race grid at the END of a qualifying
// session — so gate on the race session too. Also gate on `isLiveOnTrack` so the
// gantry/countdown stays silent while the user is out of the car at the grid or
// in a replay (issue #480 follow-up). Live-read at fire time. Safe for the
// critical `start-go`: at a real race start the driver is in the car, in "Race".
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  isRaceSession(getSessionType()) && isLiveOnTrack(e.telemetry as TelemetryData | null);

const START_READY: Scenario = {
  id: "pit-crew.start-light-ready",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.SAFETY,
  family: "start-light",
  sequence: startLightSequence(["pool:start-light-ready"]),
  when: { event: "startLight.start-ready.raised", where: liveRaceCar },
};

const START_SET: Scenario = {
  id: "pit-crew.start-light-set",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  family: "start-light",
  sequence: startLightSequence(["pool:start-light-set"]),
  when: { event: "startLight.start-set.raised", where: liveRaceCar },
};

const START_GO: Scenario = {
  id: "pit-crew.start-light-go",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  family: "start-light",
  sequence: startLightSequence(["pool:start-light-go"]),
  when: { event: "startLight.start-go.raised", where: liveRaceCar },
};

/**
 * The five numeric countdown marks. One event (`startLight.countdown.raised`)
 * carries the `seconds` payload; each scenario filters `where: seconds === N`
 * and draws from its own `start-light-countdown-<N>` pool (mirrors pit-box's
 * one-event-per-mark shape). All under the single `calloutEnabledStartCountdown`
 * opt-in via `SCENARIO_ID_TO_START_LIGHT_ID`.
 */
const COUNTDOWN_SECONDS: readonly StartCountdownSeconds[] = [60, 30, 15, 10, 5];

function countdownScenario(seconds: StartCountdownSeconds): Scenario {
  return {
    id: `pit-crew.start-light-countdown-${seconds}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    queueable: false,
    family: "start-light",
    sequence: startLightSequence([`pool:start-light-countdown-${seconds}`]),
    when: {
      event: "startLight.countdown.raised",
      where: (e) => liveRaceCar(e) && (e as SimEventOf<"startLight.countdown.raised">).data.seconds === seconds,
    },
  };
}

export const START_LIGHT_ALERTS: readonly Scenario[] = [
  START_READY,
  START_SET,
  START_GO,
  ...COUNTDOWN_SECONDS.map(countdownScenario),
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const START_LIGHT_SCENARIO_IDS: readonly string[] = START_LIGHT_ALERTS.map((s) => s.id);

/**
 * Pool names referenced by the start-light scenarios. Derived from the single
 * source of truth in `pools.ts` by filtering keys with the `start-light-`
 * prefix, so adding or renaming a pool there automatically flows through
 * `registerPitCrew()` without a parallel list to keep in sync.
 */
export const START_LIGHT_POOL_NAMES: readonly string[] = Object.keys(POOLS).filter((name) =>
  name.startsWith("start-light-"),
);
