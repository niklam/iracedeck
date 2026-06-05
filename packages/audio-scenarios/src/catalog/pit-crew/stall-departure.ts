/**
 * Stall-departure scenario — fires when the driver leaves the pit stall
 * while still on pit road. Reminds the driver to disengage the pit limiter.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import { WEIGHT } from "../../dsl.js";
import type { Scenario } from "../../dsl.js";

export const STALL_DEPARTURE: Scenario = {
  id: "pit-crew.stall-departure",
  when: { event: "pitStall.departed" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  weight: WEIGHT.SAFETY,
  sequence: ["@pit-crew.radio-open", "pool:stall-departure", "@pit-crew.radio-close"],
};
