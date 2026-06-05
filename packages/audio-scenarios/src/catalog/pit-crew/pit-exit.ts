/**
 * Pit exit scenario — fires when the driver crosses back onto the track.
 *
 * Wrapped in the shared radio frame. `weight: WEIGHT.SAFETY` so service-reminder
 * fires pending at the time exit is triggered stay deferred until this
 * callout completes.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import { WEIGHT } from "../../dsl.js";
import type { Scenario } from "../../dsl.js";

export const PIT_EXIT: Scenario = {
  id: "pit-crew.pit-exit",
  when: { event: "pitLane.exited" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  weight: WEIGHT.SAFETY,
  sequence: ["@pit-crew.radio-open", "pool:pit-exit", "@pit-crew.radio-close"],
};
