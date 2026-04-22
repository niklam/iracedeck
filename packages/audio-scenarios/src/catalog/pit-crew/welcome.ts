/**
 * Welcome scenario — fires once when the driver first enters the car.
 *
 * Flow (matching the legacy pit-crew behavior):
 *   tick-open + ambient
 *     → (greeting ~60% of the time)
 *     → (driver-name clip if configured)
 *     → start-window tip
 *   → ambient stop + tick-close
 *
 * The 60% greeting decision is encoded as a conditional `if` step. When the
 * PI "Test" button is pressed the action fires this scenario imperatively
 * via `engine.fire("pit-crew.welcome")`.
 *
 * The `{{name}}` variable is resolved by the pit-crew action; it returns
 * `null` when the user hasn't picked a driver name, in which case the step
 * is a no-op.
 *
 * `driver.firstOnTrack` is already de-duped by `sim-events-iracing` (fires
 * once per translator lifetime), so a cooldown is unnecessary.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

const GREETING_PROBABILITY = 0.6;

export const WELCOME: Scenario = {
  id: "pit-crew.welcome",
  when: { event: "driver.firstOnTrack" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  priority: "normal",
  sequence: [
    "@pit-crew.radio-open",
    {
      if: () => Math.random() < GREETING_PROBABILITY,
      then: ["pool:greeting"],
    },
    "{{name}}",
    "pool:welcome-tip",
    "@pit-crew.radio-close",
  ],
};
