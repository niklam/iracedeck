/**
 * Pit limiter warnings — four scenarios covering the different limiter
 * anomaly states emitted by `@iracedeck/sim-events-iracing`:
 *
 *   - `carControl.limiterToggled`: limiter was engaged while the driver is
 *     on the track (not in pit lane). Suppressed when on pit road because
 *     that's the expected behavior.
 *   - `limiter.missing`: entered pit road without the limiter on.
 *   - `limiter.dropped`: limiter disengaged while still between pit cones.
 *   - `limiter.speeding`: above the pit speed limit.
 *
 * All four are `priority: "normal"` — informational callouts that defer to
 * in-flight pit-lane "high" messages.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { Scenario } from "../../dsl.js";

export const LIMITER_ON_TRACK: Scenario = {
  id: "pit-engineer.limiter-on-track",
  when: {
    event: "carControl.limiterToggled",
    where: (e) => {
      const ev = e as SimEventOf<"carControl.limiterToggled">;

      if (!ev.data.on) return false;

      // Toggling the limiter on while on pit road is the expected behavior.
      // Use the event's own telemetry snapshot to avoid drift near pit-entry.
      const telemetry = ev.telemetry as TelemetryData | null;

      return telemetry?.OnPitRoad !== true;
    },
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: ["@pit-engineer.radio-open", "pool:pit-limiter-on-track", "@pit-engineer.radio-close"],
};

export const LIMITER_MISSING: Scenario = {
  id: "pit-engineer.limiter-missing",
  when: { event: "limiter.missing" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: ["@pit-engineer.radio-open", "pool:pit-no-limiter", "@pit-engineer.radio-close"],
};

export const LIMITER_DROPPED: Scenario = {
  id: "pit-engineer.limiter-dropped",
  when: { event: "limiter.dropped" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: ["@pit-engineer.radio-open", "pool:pit-limiter-dropped", "@pit-engineer.radio-close"],
};

export const LIMITER_SPEEDING: Scenario = {
  id: "pit-engineer.limiter-speeding",
  when: { event: "limiter.speeding" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  priority: "normal",
  sequence: ["@pit-engineer.radio-open", "pool:pit-speeding", "@pit-engineer.radio-close"],
};

export const PIT_LIMITER_SCENARIOS: readonly Scenario[] = [
  LIMITER_ON_TRACK,
  LIMITER_MISSING,
  LIMITER_DROPPED,
  LIMITER_SPEEDING,
];

export const PIT_LIMITER_SCENARIO_IDS: readonly string[] = PIT_LIMITER_SCENARIOS.map((s) => s.id);
