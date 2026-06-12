/**
 * Flag alert scenarios — one scenario per flag transition the translator
 * publishes. Each callout wraps a short clip in the shared radio frame
 * (`@pit-crew.radio-open` / `@pit-crew.radio-close`) so the engineer voice
 * sounds like every other Pit Crew message.
 *
 * **Pool-driven clips.** Every flag scenario draws from a pool defined in
 * `pools.ts` (e.g. `pool:flag-yellow-local`, `pool:flag-blue`) — even the
 * single-clip flags. The interpreter picks from multi-element pools at
 * random (no immediate repeat) and resolves single-element pools
 * deterministically, so behavior is unchanged today, but adding a variant
 * later is a one-line append in `pools.ts` instead of a scenario rewrite.
 *
 * **Family preemption.** All non-meatball flag scenarios share
 * `family: "flag"` so a newer flag callout supersedes the in-flight one
 * (yellow → green at restart no longer plays both back-to-back; whichever
 * flag fires last wins). Meatball is intentionally excluded from the
 * family — we want it to preempt anything in flight (handled by
 * `weight: WEIGHT.CRITICAL` + `interrupt: true`), but we do NOT want a routine
 * yellow to cancel a still-playing meatball.
 *
 * **Yellow scope.** `flag.yellow.raised` carries `data.scope` (`"local"` or
 * `"full"` — set by the translator from the iRacing SessionFlags bits).
 * Two scenarios filter on the scope so we get a meaningfully different
 * line for full-course yellows ("pace car deployed") vs local sector
 * yellows ("mind the slow cars").
 *
 * **Session-aware flags.** Green, white and checkered all have three
 * recorded variants — practice, qualifying, race — because the engineer's
 * wording differs per session ("that's it for the race, well done" only
 * fits after a race; a green-flag "push now!" only fits a race start).
 * Each scenario nests `if`-step branches on `getSessionType()` to pick
 * the right pool at fire time.
 *
 * **Yellow-cleared delivery + waving debounce (issue #671).**
 * `flag.yellow.cleared` is a one-shot event, so the cleared scenario is
 * `queueable` — a fire deferred behind an equal-weight non-flag line
 * (spotter call, pit chatter) replays when the bus idles instead of being
 * silently dropped. The waving scenarios carry a 30 s `cooldown`
 * ({@link WAVING_FLAG_COOLDOWN_MS}) because iRacing re-raises the waving
 * bits on every re-approach of a persistent incident zone.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { isLiveOnTrack, isPostRace, isPreGreen, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getSessionType, getStandingStart } from "@iracedeck/sim-events-iracing";

import type { Scenario, Step } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { POOLS } from "./pools.js";
import { isRaceSession } from "./race-start.js";

// Race-progression / formation flags (one-pace-lap-to-go, green-held, ten-to-go,
// five-to-go, crossed) are race-only concepts. iRacing raises the grid bits
// while forming the race grid at the END of a qualifying session, so without
// this gate they fired at the qualifying checkered (issue #480 follow-up).
// Live-read at fire time, mirroring the session branching the
// green/white/checkered scenarios already use.
const raceOnly = () => isRaceSession(getSessionType());

// These callouts only make sense to a driver IN the car and live, so also gate
// on `isLiveOnTrack` — silent while out of the car at the grid / in a replay
// (issue #480 follow-up). And gate OFF after the race finishes (`isPostRace` —
// Checkered / CoolDown): iRacing re-asserts the grid bits during cool-down /
// next-session grid formation, which would otherwise re-fire the bit-driven
// progression callouts (crossed / green-held / ten- / five-to-go) after the
// checkered — the #657 post-race misfire. (`one-pace-lap-to-go` is additionally
// ParadeLaps-gated in its own diff, so it can't reach post-race regardless.)
// Read from the event's telemetry at fire time.
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  raceOnly() && isLiveOnTrack(e.telemetry as TelemetryData | null) && !isPostRace(e.telemetry as TelemetryData | null);

// Rolling-only formation cue (green-held). A standing start has no pace lap, yet
// iRacing sets the grid bits throughout the standing grid — so suppress during a
// standing-start pre-green phase (the start-light family owns that lead-in).
// Restarts (Racing state) and rolling starts still fire (issue #480 follow-up).
// (The sibling "one pace lap to go" cue is gated rolling-only in its diff
// instead — `diff/pace-laps.ts`, issue #657 — so it uses `liveRaceCar` here.)
const rollingFormationOnly = (e: SimEventOf<SimEventName>): boolean =>
  liveRaceCar(e) && !(getStandingStart() && isPreGreen(e.telemetry as TelemetryData | null));

function flagSequence(steps: Step[]): Step[] {
  return ["@pit-crew.radio-open", ...steps, "@pit-crew.radio-close"];
}

function flagScenario(id: string, body: Step[]): Scenario {
  return {
    id: `pit-crew.flag-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    family: "flag",
    sequence: flagSequence(body),
  };
}

const YELLOW_LOCAL: Scenario = {
  ...flagScenario("yellow-local", ["pool:flag-yellow-local"]),
  when: {
    event: "flag.yellow.raised",
    where: (e) => (e as SimEventOf<"flag.yellow.raised">).data.scope === "local",
  },
};

const YELLOW_FULL: Scenario = {
  ...flagScenario("yellow-full", ["pool:flag-yellow-full"]),
  when: {
    event: "flag.yellow.raised",
    where: (e) => (e as SimEventOf<"flag.yellow.raised">).data.scope === "full",
  },
};

// `queueable: true` (issue #671) mirrors the FURLED precedent below: the
// cleared event is one-shot and the all-clear is a sustained state, so a fire
// deferred behind an equal-weight line (spotter call, pit chatter) must replay
// when the bus idles instead of being dropped — the "no Yellow cleared heard"
// bug.
const YELLOW_CLEARED: Scenario = {
  ...flagScenario("yellow-cleared", ["pool:flag-yellow-cleared"]),
  queueable: true,
  when: { event: "flag.yellow.cleared" },
};

const GREEN: Scenario = {
  ...flagScenario("green", [
    {
      if: () => getSessionType() === "Practice",
      then: ["pool:flag-green-practice"],
      else: [
        {
          if: () => getSessionType().includes("Qualify"),
          then: ["pool:flag-green-qualifying"],
          else: ["pool:flag-green-race"],
        },
      ],
    },
  ]),
  when: { event: "flag.green.raised" },
};

const BLUE: Scenario = {
  ...flagScenario("blue", ["pool:flag-blue"]),
  when: { event: "flag.blue.raised" },
};

const WHITE: Scenario = {
  ...flagScenario("white", [
    {
      if: () => getSessionType() === "Practice",
      then: ["pool:flag-white-practice"],
      else: [
        {
          if: () => getSessionType().includes("Qualify"),
          then: ["pool:flag-white-qualifying"],
          else: ["pool:flag-white-race"],
        },
      ],
    },
  ]),
  when: { event: "flag.white.raised" },
};

const RED: Scenario = {
  ...flagScenario("red", ["pool:flag-red"]),
  when: { event: "flag.red.raised" },
};

const BLACK: Scenario = {
  ...flagScenario("black", ["pool:flag-black"]),
  when: { event: "flag.black.raised" },
};

const CHECKERED: Scenario = {
  ...flagScenario("checkered", [
    {
      if: () => getSessionType() === "Practice",
      then: ["pool:flag-checkered-practice"],
      else: [
        {
          if: () => getSessionType().includes("Qualify"),
          then: ["pool:flag-checkered-qualifying"],
          else: ["pool:flag-checkered-race"],
        },
      ],
    },
  ]),
  when: { event: "flag.checkered.raised" },
};

const DEBRIS: Scenario = {
  ...flagScenario("debris", ["pool:flag-debris"]),
  when: { event: "flag.debris.raised" },
};

// Meatball is the one flag the driver may genuinely miss — failing to
// pit on a meatball is a black-flag penalty. Give it `weight: WEIGHT.CRITICAL`
// with `interrupt: true` so it cuts in-flight engineer chatter mid-message.
// Intentionally NOT in `family: "flag"`: a routine yellow must not cancel
// a still-playing meatball.
const MEATBALL: Scenario = {
  id: "pit-crew.flag-meatball",
  when: { event: "flag.meatball.raised" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  sequence: flagSequence(["pool:flag-meatball"]),
};

// Driver-black splits (issue #480). `Disqualify` is split out of the generic
// `black` callout — "Disqualified. Pull off." carries different urgency than a
// routine black flag. `Furled` and `DqScoringInvalid` are new bits the engineer
// previously ignored. All share `family: "flag"` + `WEIGHT.SAFETY` like the
// other flags.
const DISQUALIFY: Scenario = {
  ...flagScenario("disqualify", ["pool:flag-disqualify"]),
  when: { event: "flag.disqualify.raised" },
};

// `queueable: true` so a furled-black-flag call deferred behind another
// safety-level line (another flag / spotter focus) replays when the bus next
// idles instead of being dropped — it carries a give-the-time-back instruction
// the driver needs to hear, and the furled state is sustained so a slightly
// late call is still correct.
const FURLED: Scenario = {
  ...flagScenario("furled", ["pool:flag-furled"]),
  queueable: true,
  when: { event: "flag.furled.raised" },
};

// Fires when an announced furled warning is withdrawn (issue #669) — the
// translator gates `flag.furled.cleared` on the raised callout having fired,
// so the all-clear never plays for a warning the driver was never told about.
// `queueable: true` like YELLOW_CLEARED: the all-clear is a sustained state,
// so a fire deferred behind an equal-weight line replays when the bus next
// idles instead of being dropped.
const FURLED_CLEARED: Scenario = {
  ...flagScenario("furled-cleared", ["pool:flag-furled-cleared"]),
  queueable: true,
  when: { event: "flag.furled.cleared" },
};

const DQ_SCORING_INVALID: Scenario = {
  ...flagScenario("dq-scoring-invalid", ["pool:flag-dq-scoring-invalid"]),
  when: { event: "flag.dq-scoring-invalid.raised" },
};

// Race-progression flags (issue #480) — crossed, one-pace-lap-to-go, green-held,
// ten-to-go, five-to-go.
const CROSSED: Scenario = {
  ...flagScenario("crossed", ["pool:flag-crossed"]),
  when: { event: "flag.crossed.raised", where: liveRaceCar },
};

// "One pace lap to go" on a rolling start (issue #657). The translator's
// `diff/pace-laps.ts` already owns the rolling-only / ParadeLaps / final-lap
// gating, so the scenario only needs the shared live-race-car gate (race
// session + in the car + not post-race).
const ONE_PACE_LAP_TO_GO: Scenario = {
  ...flagScenario("one-pace-lap-to-go", ["pool:flag-one-pace-lap-to-go"]),
  when: { event: "flag.one-pace-lap-to-go.raised", where: liveRaceCar },
};

const GREEN_HELD: Scenario = {
  ...flagScenario("green-held", ["pool:flag-green-held"]),
  when: { event: "flag.green-held.raised", where: rollingFormationOnly },
};

const TEN_TO_GO: Scenario = {
  ...flagScenario("ten-to-go", ["pool:flag-ten-to-go"]),
  when: { event: "flag.ten-to-go.raised", where: liveRaceCar },
};

const FIVE_TO_GO: Scenario = {
  ...flagScenario("five-to-go", ["pool:flag-five-to-go"]),
  when: { event: "flag.five-to-go.raised", where: liveRaceCar },
};

/**
 * Issue #671 — iRacing re-raises the waving bits on every zone re-approach
 * while an incident persists; the cooldown collapses the repeats to one
 * callout per 30 s window, mirroring CrewChief's
 * `timeBetweenYellowFlagMessages`.
 */
export const WAVING_FLAG_COOLDOWN_MS = 30_000;

// Caution-waving variants (issue #480) — separate, more-urgent callouts than the
// base static yellows. The translator's reworked yellow detection guarantees a
// base yellow and its waving variant never double-fire. Both carry the 30 s
// cooldown (issue #671): the iRacing YellowWaving bit re-raises each time the
// player re-approaches a persistent incident, which replayed the callout on
// every pass.
const YELLOW_WAVING: Scenario = {
  ...flagScenario("yellow-waving", ["pool:flag-yellow-waving"]),
  cooldown: WAVING_FLAG_COOLDOWN_MS,
  when: { event: "flag.yellow-waving.raised" },
};

const CAUTION_WAVING: Scenario = {
  ...flagScenario("caution-waving", ["pool:flag-caution-waving"]),
  cooldown: WAVING_FLAG_COOLDOWN_MS,
  when: { event: "flag.caution-waving.raised" },
};

export const FLAG_ALERTS: readonly Scenario[] = [
  YELLOW_LOCAL,
  YELLOW_FULL,
  YELLOW_CLEARED,
  GREEN,
  BLUE,
  WHITE,
  RED,
  BLACK,
  CHECKERED,
  DEBRIS,
  MEATBALL,
  DISQUALIFY,
  FURLED,
  FURLED_CLEARED,
  DQ_SCORING_INVALID,
  CROSSED,
  ONE_PACE_LAP_TO_GO,
  GREEN_HELD,
  TEN_TO_GO,
  FIVE_TO_GO,
  YELLOW_WAVING,
  CAUTION_WAVING,
];

export const FLAG_SCENARIO_IDS: readonly string[] = FLAG_ALERTS.map((s) => s.id);

/**
 * Pool names referenced by the flag-alerts scenarios. Derived from the
 * single source of truth in `pools.ts` by filtering keys with the
 * `flag-` prefix, so adding or renaming a pool there automatically
 * flows through `registerPitCrew()` without a parallel list to keep
 * in sync.
 */
export const FLAG_POOL_NAMES: readonly string[] = Object.keys(POOLS).filter((name) => name.startsWith("flag-"));
