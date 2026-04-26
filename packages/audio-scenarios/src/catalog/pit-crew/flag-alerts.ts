/**
 * Flag alert scenarios — one scenario per flag transition the translator
 * publishes. Each callout wraps a short clip in the shared radio frame
 * (`@pit-crew.radio-open` / `@pit-crew.radio-close`) so the engineer voice
 * sounds like every other Pit Crew message.
 *
 * **Pool-driven clips.** Every flag scenario draws from a pool defined in
 * `pools.ts` (e.g. `pool:flag-yellow-local`, `pool:flag-blue`) — even the
 * single-clip flags. The interpreter rotates multi-element pools and
 * resolves single-element pools deterministically, so behavior is
 * unchanged today, but adding a variant later is a one-line append in
 * `pools.ts` instead of a scenario rewrite.
 *
 * **Family preemption.** All non-meatball flag scenarios share
 * `family: "flag"` so a newer flag callout supersedes the in-flight one
 * (yellow → green at restart no longer plays both back-to-back; whichever
 * flag fires last wins). Meatball is intentionally excluded from the
 * family — we want it to preempt anything in flight (handled by
 * `priority: "urgent"` + `preempt: true`), but we do NOT want a routine
 * yellow to cancel a still-playing meatball.
 *
 * **Yellow scope.** `flag.yellow.raised` carries `data.scope` (`"local"` or
 * `"full"` — set by the translator from the iRacing SessionFlags bits).
 * Two scenarios filter on the scope so we get a meaningfully different
 * line for full-course yellows ("pace car deployed") vs local sector
 * yellows ("mind the slow cars").
 *
 * **Checkered session-aware.** The recorded checkered clip set has three
 * variants — practice, qualifying, race — because the engineer's wording
 * differs per session ("that's it for the race, well done" only fits
 * after a race). The scenario nests `if`-step branches on
 * `getSessionType()` to pick the right pool at fire time.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario, Step } from "../../dsl.js";

function flagSequence(steps: Step[]): Step[] {
  return ["@pit-crew.radio-open", ...steps, "@pit-crew.radio-close"];
}

function flagScenario(id: string, body: Step[]): Scenario {
  return {
    id: `pit-crew.flag-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
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

const YELLOW_CLEARED: Scenario = {
  ...flagScenario("yellow-cleared", ["pool:flag-yellow-cleared"]),
  when: { event: "flag.yellow.cleared" },
};

const GREEN: Scenario = {
  ...flagScenario("green", ["pool:flag-green"]),
  when: { event: "flag.green.raised" },
};

const BLUE: Scenario = {
  ...flagScenario("blue", ["pool:flag-blue"]),
  when: { event: "flag.blue.raised" },
};

const WHITE: Scenario = {
  ...flagScenario("white", ["pool:flag-white"]),
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
      then: ["pool:flag-checkered-practise"],
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
// pit on a meatball is a black-flag penalty. Mark it `urgent` with
// `preempt: true` so it cancels in-flight engineer chatter mid-message.
// Intentionally NOT in `family: "flag"`: a routine yellow must not cancel
// a still-playing meatball.
const MEATBALL: Scenario = {
  id: "pit-crew.flag-meatball",
  when: { event: "flag.meatball.raised" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  priority: "urgent",
  preempt: true,
  sequence: flagSequence(["pool:flag-meatball"]),
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
];

export const FLAG_SCENARIO_IDS: readonly string[] = FLAG_ALERTS.map((s) => s.id);

/**
 * Pool names referenced by the flag-alerts scenarios. `index.ts` registers
 * each via `engine.definePool(name, [...POOLS[name]])`. Keeping the list
 * here (rather than enumerating in `index.ts`) keeps the pool/scenario
 * surface in one place — adding a new flag scenario is two appends:
 * one pool entry in `pools.ts` and one name here.
 */
export const FLAG_POOL_NAMES: readonly string[] = [
  "flag-yellow-local",
  "flag-yellow-full",
  "flag-yellow-cleared",
  "flag-green",
  "flag-blue",
  "flag-white",
  "flag-red",
  "flag-black",
  "flag-debris",
  "flag-meatball",
  "flag-checkered-practise",
  "flag-checkered-qualifying",
  "flag-checkered-race",
];
