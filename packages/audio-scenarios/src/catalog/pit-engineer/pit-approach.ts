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
  id: "pit-engineer.pit-approach",
  when: { event: "pitLane.approaching" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "high",
  sequence: ["@pit-engineer.radio-open", "pool:pit-approach", "@pit-engineer.radio-close"],
};
