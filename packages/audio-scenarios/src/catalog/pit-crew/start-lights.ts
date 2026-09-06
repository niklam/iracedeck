/**
 * Start-light contracts (issues #480 / #673 / #829; scripted since #1065).
 *
 * Two gantry lines (ready / go) plus a four-mark numeric pre-start
 * countdown. Each callout is a single clip; the engine wraps it in the
 * active voice's `radio` frame (issue #1064) so the engineer voice matches
 * every other Pit Crew message.
 *
 * The code below decides WHEN each line is due and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same
 * ids (`scenarios["pit-crew.start-light-go"]`, …), paired at `setScripts`
 * time. Each line is one pool the script addresses directly as
 * `pool:start-lights/<base>`; no vocabulary is needed — the countdown mark
 * is decided by the contract's `where:` on the event's `seconds`, so each
 * number is its own contract a pack can phrase on its own.
 *
 * **In-car gating differs by half** (issue #829): the gantry lines require
 * the driver live in the car (out of the car at lights-out means the start
 * was missed — "go, go, go" would be noise), while the countdown marks
 * deliberately play OUT of the car too — they're the "get in the car"
 * reminder, audible from the garage / session screen / replay view. The
 * saved-replay case is suppressed translator-side (the pre-guard countdown
 * diff is gated on `SimMode`, #604), not here.
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

import type { ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { isRaceSession } from "./race-start.js";

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

const START_READY: ScenarioContract = {
  id: "pit-crew.start-light-ready",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  queueable: true,
  family: "start-light",
  when: { event: "startLight.start-ready.raised", where: liveRaceCar },
  description: "The start lights come on over the grid of a standing-start race while you sit live in the car.",
};

const START_GO: ScenarioContract = {
  id: "pit-crew.start-light-go",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  queueable: true,
  family: "start-light",
  when: { event: "startLight.start-go.raised", where: liveRaceCar },
  description: "The start lights go out at a standing-start race and the field is released, with you live in the car.",
};

/**
 * The four numeric countdown marks. One event (`startLight.countdown.raised`)
 * carries the `seconds` payload; each contract filters `where: seconds === N`
 * and the script addresses its own `pool:start-lights/countdown-<N>` (mirrors
 * pit-box's one-event-per-mark shape). All under the single
 * `calloutEnabledStartCountdown` opt-in via `SCENARIO_ID_TO_START_LIGHT_ID`.
 *
 * No `isLiveOnTrack` gate here (issue #829): the marks are the "get in the
 * car" reminder and must play while the driver sits in the garage / session
 * screen / replay view. Race-session gating stays (the grid bits leak at the
 * qualifying checkered), and the saved-replay case never emits the event at
 * all (translator-side `SimMode` gate).
 */
const COUNTDOWN_SECONDS: readonly StartCountdownSeconds[] = [90, 60, 30, 10];

/** One sentence per mark for the generated reference (#1066) — when each countdown line fires, in the sim's terms. */
const COUNTDOWN_DESCRIPTIONS: Readonly<Record<StartCountdownSeconds, string>> = {
  90: "The pre-start countdown of a standing-start race passes ninety seconds to go, whether you are in the car or still in the garage.",
  60: "The pre-start countdown of a standing-start race passes sixty seconds to go, whether you are in the car or still in the garage.",
  30: "The pre-start countdown of a standing-start race passes thirty seconds to go, whether you are in the car or still in the garage.",
  10: "The pre-start countdown of a standing-start race passes ten seconds to go, whether you are in the car or still in the garage.",
};

function countdownContract(seconds: StartCountdownSeconds): ScenarioContract {
  return {
    id: `pit-crew.start-light-countdown-${seconds}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.NORMAL,
    queueable: false,
    family: "start-light",
    when: {
      event: "startLight.countdown.raised",
      where: (e) =>
        isRaceSession(getSessionType()) && (e as SimEventOf<"startLight.countdown.raised">).data.seconds === seconds,
    },
    description: COUNTDOWN_DESCRIPTIONS[seconds],
  };
}

export const START_LIGHT_CONTRACTS: readonly ScenarioContract[] = [
  START_READY,
  START_GO,
  ...COUNTDOWN_SECONDS.map(countdownContract),
];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const START_LIGHT_SCENARIO_IDS: readonly string[] = START_LIGHT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the start-light scripts draw from — every
 * `pool:start-lights/<base>` the bundled script may write, as a literal
 * list, since nothing derives it. The completeness tests read it: the
 * bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder.
 */
export const START_LIGHT_CLIP_SOURCES: readonly { group: "start-lights"; base: string }[] = [
  { group: "start-lights", base: "start-ready" },
  { group: "start-lights", base: "start-go" },
  { group: "start-lights", base: "countdown-90" },
  { group: "start-lights", base: "countdown-60" },
  { group: "start-lights", base: "countdown-30" },
  { group: "start-lights", base: "countdown-10" },
];
