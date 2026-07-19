/**
 * Start-light family scenarios (issues #480 / #673 / #829).
 *
 * Two gantry lines (ready / go) plus a four-mark numeric pre-start
 * countdown. Each callout wraps its clip in the shared radio frame
 * (`@pit-crew.radio-open` / `@pit-crew.radio-close`) so the engineer voice
 * matches every other Pit Crew message.
 *
 * **In-car gating differs by half** (issue #829): the gantry lines require
 * the driver live in the car (out of the car at lights-out means the start
 * was missed — "go, go, go" would be noise), while the countdown marks
 * deliberately play OUT of the car too — they're the "get in the car"
 * reminder, audible from the garage / session screen / replay view. The
 * saved-replay case is suppressed translator-side (the pre-guard countdown
 * diff is gated on `SimMode`, #604), not here.
 *
 * **Pool-driven clips** (mirrors `flag-alerts.ts`): every scenario draws from a
 * pool defined in `pools.ts` under the `start-light-` prefix, so a future
 * variant pack is a one-line append there.
 *
 * **Family preemption.** All six share `family: "start-light"` so a newer
 * start-light callout supersedes the in-flight one — e.g. `start-ready`
 * arriving while a countdown number is mid-clip, or a faster-than-expected
 * light sequence, never stacks two lines back-to-back; whichever fires last
 * wins.
 *
 * **Weights.** The four countdown numbers sit at `WEIGHT.NORMAL` — pre-race,
 * low-stakes information (lowered from `SAFETY` by issue #666). `start-ready`
 * and `start-go` are `WEIGHT.CRITICAL` + `interrupt: true` — "lights are up"
 * and "go, go, go!" must cut anything in flight. (The heads-up line fires on
 * the `StartReady` edge — issue #673; the procedure is Ready → Set → Go and
 * `StartSet` lights too late to be useful, so nothing is spoken there.) Both
 * gantry lines are also `queueable: true` (issue #867): a spotter proximity
 * call at `WEIGHT.PROXIMITY` outranks them, and cars are side by side at
 * every race start — without queueable, a gantry line colliding with a ~1 s
 * spotter clip (either direction) would be permanently lost; deferred, it
 * replays the moment the clip ends, and the `family: "start-light"` pending
 * tie-break (newest wins) keeps a stale `start-ready` from replaying after
 * `start-go` has superseded it. The countdown numbers stay
 * `queueable: false`: a number that can't take the bus right now is dropped
 * rather than replayed stale a beat later.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf, StartCountdownSeconds } from "@iracedeck/event-bus";
import { isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario, Step } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { POOL_REGISTRY } from "./pools.js";
import { isRaceSession } from "./race-start.js";

function startLightSequence(steps: Step[]): Step[] {
  return ["@pit-crew.radio-open", ...steps, "@pit-crew.radio-close"];
}

// Start lights are a race-only concept. The diff already gates on
// standing-start + the GetInCar/Warmup pre-start window, but iRacing can raise
// the grid bits while forming the race grid at the END of a qualifying session
// — so gate on the race session too. The GANTRY lines additionally gate on
// `isLiveOnTrack` so they stay silent while the user is out of the car at the
// grid or in a replay (issue #480 follow-up); the countdown marks use the bare
// race gate instead (issue #829 — see the header). Live-read at fire time.
// Safe for the critical `start-go`: at a real race start the driver is in the
// car, in "Race".
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  isRaceSession(getSessionType()) && isLiveOnTrack(e.telemetry as TelemetryData | null);

const START_READY: Scenario = {
  id: "pit-crew.start-light-ready",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  queueable: true,
  family: "start-light",
  sequence: startLightSequence(["pool:start-light-ready"]),
  when: { event: "startLight.start-ready.raised", where: liveRaceCar },
};

const START_GO: Scenario = {
  id: "pit-crew.start-light-go",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  queueable: true,
  family: "start-light",
  sequence: startLightSequence(["pool:start-light-go"]),
  when: { event: "startLight.start-go.raised", where: liveRaceCar },
};

/**
 * The four numeric countdown marks. One event (`startLight.countdown.raised`)
 * carries the `seconds` payload; each scenario filters `where: seconds === N`
 * and draws from its own `start-light-countdown-<N>` pool (mirrors pit-box's
 * one-event-per-mark shape). All under the single `calloutEnabledStartCountdown`
 * opt-in via `SCENARIO_ID_TO_START_LIGHT_ID`.
 *
 * No `isLiveOnTrack` gate here (issue #829): the marks are the "get in the
 * car" reminder and must play while the driver sits in the garage / session
 * screen / replay view. Race-session gating stays (the grid bits leak at the
 * qualifying checkered), and the saved-replay case never emits the event at
 * all (translator-side `SimMode` gate).
 */
const COUNTDOWN_SECONDS: readonly StartCountdownSeconds[] = [90, 60, 30, 10];

function countdownScenario(seconds: StartCountdownSeconds): Scenario {
  return {
    id: `pit-crew.start-light-countdown-${seconds}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.NORMAL,
    queueable: false,
    family: "start-light",
    sequence: startLightSequence([`pool:start-light-countdown-${seconds}`]),
    when: {
      event: "startLight.countdown.raised",
      where: (e) =>
        isRaceSession(getSessionType()) && (e as SimEventOf<"startLight.countdown.raised">).data.seconds === seconds,
    },
  };
}

export const START_LIGHT_ALERTS: readonly Scenario[] = [
  START_READY,
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
export const START_LIGHT_POOL_NAMES: readonly string[] = Object.keys(POOL_REGISTRY).filter((name) =>
  name.startsWith("start-light-"),
);
