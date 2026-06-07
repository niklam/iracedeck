/**
 * Rolling-start family scenarios (issue #660).
 *
 * A single line spoken once at the start of a rolling-start formation lap, when
 * the field begins to roll behind the pace car. The callout wraps its clip in
 * the shared radio frame (`@pit-crew.radio-open` / `@pit-crew.radio-close`) so
 * the engineer voice matches every other Pit Crew message.
 *
 * **Pool-driven clips** (mirrors `start-lights.ts`): the scenario draws from a
 * pool defined in `pools.ts` under the `rolling-start-` prefix, so a future
 * variant pack is a one-line append there. Five random-pick variants today
 * (the pool picker is uniform-random with a no-immediate-repeat guard, not a
 * sequential rotation — see `pools.ts`).
 *
 * **Weight.** `WEIGHT.SAFETY` — pre-start situational information the driver
 * acts on (getting up to pace, closing the gap), but not a CRITICAL interrupt
 * like "lights are red".
 *
 * **Gating.** The scenario's `where:` reuses `liveRaceCar` (race session + live
 * in the car), so the line stays silent in qualifying/practice, in a replay, or
 * while the user is out of the car at the grid. This is a rolling-start concept
 * only — standing starts have their own start-light gantry/countdown family.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { Scenario } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { POOLS } from "./pools.js";
import { isRaceSession } from "./race-start.js";

// Rolling-start callouts are a race-only concept spoken to a driver in the car.
// Gate on the race session (iRacing can raise pace-car movement bits while
// forming the grid at the END of a qualifying session) and on `isLiveOnTrack`
// so the line stays silent while the user is out of the car at the grid or in a
// replay. Mirrors the start-light `liveRaceCar` predicate. Live-read at fire time.
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  isRaceSession(getSessionType()) && isLiveOnTrack(e.telemetry as TelemetryData | null);

const ROLLING_START_PACE_CAR: Scenario = {
  id: "pit-crew.rolling-start-pace-car",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.SAFETY,
  family: "rolling-start",
  sequence: ["@pit-crew.radio-open", "pool:rolling-start-pace-car", "@pit-crew.radio-close"],
  when: { event: "rollingStart.pace-car-moving.raised", where: liveRaceCar },
};

export const ROLLING_START_ALERTS: readonly Scenario[] = [ROLLING_START_PACE_CAR];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const ROLLING_START_SCENARIO_IDS: readonly string[] = ROLLING_START_ALERTS.map((s) => s.id);

/**
 * Pool names referenced by the rolling-start scenarios. Derived from the single
 * source of truth in `pools.ts` by filtering keys with the `rolling-start-`
 * prefix, so adding or renaming a pool there automatically flows through
 * `registerPitCrew()` without a parallel list to keep in sync.
 */
export const ROLLING_START_POOL_NAMES: readonly string[] = Object.keys(POOLS).filter((name) =>
  name.startsWith("rolling-start-"),
);
