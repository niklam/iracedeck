/**
 * Pit exit scenario — fires when the driver crosses back onto the track.
 *
 * Wrapped in the shared radio frame. `priority: "high"` so service-reminder
 * fires pending at the time exit is triggered stay deferred until this
 * callout completes.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

export const PIT_EXIT: Scenario = {
  id: "pit-engineer.pit-exit",
  when: { event: "pitLane.exited" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "high",
  sequence: ["@pit-engineer.radio-open", "pool:pit-exit", "@pit-engineer.radio-close"],
};
