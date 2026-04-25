/**
 * Flag alert scenarios — one scenario per flag colour.
 *
 * Each flag callout wraps a single clip in the shared radio frame. All
 * flag alerts share `priority: "normal"` so they defer to in-flight pit-lane
 * callouts (priority "high") but never preempt them.
 *
 * The meatball and debris flags don't have dedicated events in the current
 * `SimEventMap` — they're delivered as part of the black flag's bit in
 * iRacing SessionFlags, and would need a richer event payload to be
 * distinguished. They stay as dead-letter files in audio-assets for now.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

type FlagColor = "yellow" | "green" | "blue" | "black" | "red" | "white" | "checkered";

const FLAG_EVENT: Record<FlagColor, SimEventName> = {
  yellow: "flag.yellow.raised",
  green: "flag.green.raised",
  blue: "flag.blue.raised",
  black: "flag.black.raised",
  red: "flag.red.raised",
  white: "flag.white.raised",
  checkered: "flag.checkered.raised",
};

function flagScenario(color: FlagColor): Scenario {
  return {
    id: `pit-crew.flag-${color}`,
    when: { event: FLAG_EVENT[color] },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: "normal",
    sequence: [
      "@pit-crew.radio-open",
      `flags/IRD-flag-${color}-flag.mp3`,
      "@pit-crew.radio-close",
    ],
  };
}

export const FLAG_ALERTS: readonly Scenario[] = [
  flagScenario("yellow"),
  flagScenario("green"),
  flagScenario("blue"),
  flagScenario("black"),
  flagScenario("red"),
  flagScenario("white"),
  flagScenario("checkered"),
];

export const FLAG_SCENARIO_IDS: readonly string[] = FLAG_ALERTS.map((s) => s.id);
