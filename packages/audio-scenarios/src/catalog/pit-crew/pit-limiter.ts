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
 * All four use the default weight (`WEIGHT.NORMAL`) — informational callouts
 * that yield to higher-weight in-flight pit-lane messages.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { hasPitLimiter, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { Scenario } from "../../dsl.js";
import { POOL_REGISTRY } from "./pools.js";

export const LIMITER_ON_TRACK: Scenario = {
  id: "pit-crew.limiter-on-track",
  when: {
    event: "carControl.limiterToggled",
    where: (e) => {
      const ev = e as SimEventOf<"carControl.limiterToggled">;

      if (!ev.data.on) return false;

      // Toggling the limiter on while on pit road is the expected behavior.
      // Use the event's own telemetry snapshot to avoid drift near pit-entry.
      const telemetry = ev.telemetry as TelemetryData | null;

      // Suppress on cars without a pit limiter (issue #639).
      if (!hasPitLimiter(telemetry)) return false;

      return telemetry?.OnPitRoad !== true;
    },
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["@pit-crew.radio-open", "pool:pit-limiter-on-track", "@pit-crew.radio-close"],
};

export const LIMITER_MISSING: Scenario = {
  id: "pit-crew.limiter-missing",
  when: {
    event: "limiter.missing",
    // Cars without a pit limiter can't be "missing" one (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["@pit-crew.radio-open", "pool:pit-limiter-missing", "@pit-crew.radio-close"],
};

export const LIMITER_DROPPED: Scenario = {
  id: "pit-crew.limiter-dropped",
  when: {
    event: "limiter.dropped",
    // Cars without a pit limiter can't drop one (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["@pit-crew.radio-open", "pool:pit-limiter-dropped", "@pit-crew.radio-close"],
};

export const LIMITER_SPEEDING: Scenario = {
  id: "pit-crew.limiter-speeding",
  when: {
    event: "limiter.speeding",
    // A pit-limiter speeding warning is meaningless without a limiter (issue #639).
    where: (e) => hasPitLimiter(e.telemetry as TelemetryData | null),
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-crew",
  family: "limiter",
  sequence: ["@pit-crew.radio-open", "pool:pit-limiter-speeding", "@pit-crew.radio-close"],
};

export const PIT_LIMITER_SCENARIOS: readonly Scenario[] = [
  LIMITER_ON_TRACK,
  LIMITER_MISSING,
  LIMITER_DROPPED,
  LIMITER_SPEEDING,
];

export const PIT_LIMITER_SCENARIO_IDS: readonly string[] = PIT_LIMITER_SCENARIOS.map((s) => s.id);

/** Stable identifier for each user-toggleable pit-limiter callout (issue #1051). */
export type PitLimiterCalloutId = "on-track" | "missing" | "dropped" | "speeding";

/**
 * Canonical id -> plugin-global setting key. Plugins read the live opt-in
 * through this rather than duplicating the key strings.
 */
export const PIT_LIMITER_CALLOUT_SETTING_KEYS: Record<PitLimiterCalloutId, string> = {
  "on-track": "calloutEnabledLimiterOnTrack",
  missing: "calloutEnabledLimiterMissing",
  dropped: "calloutEnabledLimiterDropped",
  speeding: "calloutEnabledLimiterSpeeding",
};

/** Scenario id -> callout id, consumed by `wrapCalloutScenario` in `index.ts`. */
export const SCENARIO_ID_TO_PIT_LIMITER_ID: Record<string, PitLimiterCalloutId> = {
  "pit-crew.limiter-on-track": "on-track",
  "pit-crew.limiter-missing": "missing",
  "pit-crew.limiter-dropped": "dropped",
  "pit-crew.limiter-speeding": "speeding",
};

/**
 * Pool names referenced by these scenarios, derived from the single source of
 * truth in `pools.ts` so a rename there flows through without a parallel list.
 */
export const PIT_LIMITER_POOL_NAMES: readonly string[] = Object.keys(POOL_REGISTRY).filter((name) =>
  name.startsWith("pit-limiter-"),
);
