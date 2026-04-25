/**
 * Pit approach scenario — fires when the driver enters the pit approach zone.
 *
 * Wrapped in the shared radio frame. Uses `priority: "high"` so a
 * low-priority service reminder is deferred until this callout finishes
 * (preserves the "finish approach before reminder" behavior without the
 * legacy 1500 ms fixed delay).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

export const PIT_APPROACH: Scenario = {
  id: "pit-crew.pit-approach",
  when: { event: "pitLane.approaching" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  priority: "high",
  sequence: ["@pit-crew.radio-open", "pool:pit-approach", "@pit-crew.radio-close"],
};
