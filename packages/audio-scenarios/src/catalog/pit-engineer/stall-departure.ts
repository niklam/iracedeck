/**
 * Stall-departure scenario — fires when the driver leaves the pit stall
 * while still on pit road. Reminds the driver to disengage the pit limiter.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

export const STALL_DEPARTURE: Scenario = {
  id: "pit-engineer.stall-departure",
  when: { event: "pitStall.departed" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "high",
  sequence: ["@pit-engineer.radio-open", "pool:stall-departure", "@pit-engineer.radio-close"],
};
