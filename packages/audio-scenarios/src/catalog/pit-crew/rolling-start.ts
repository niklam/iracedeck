/**
 * Rolling-start contract (issue #660; scripted since #1065).
 *
 * A single line spoken once at the start of a rolling-start formation lap, when
 * the field begins to roll behind the pace car. The engine wraps the clip in the
 * active voice's `radio` frame (issue #1064) so the engineer voice matches every
 * other Pit Crew message.
 *
 * The code below decides WHEN the line is due and how it is scheduled; WHAT
 * is said lives in the active voice's `callouts.json` under the same id
 * (`scenarios["pit-crew.rolling-start-pace-car"]`), paired at `setScripts`
 * time. The line is one pool the script addresses directly as
 * `pool:rolling-start/pace-car-moving` — five random-pick variants in the
 * bundled voice (the pool picker is uniform-random with a no-immediate-repeat
 * guard, not a sequential rotation); no vocabulary is needed.
 *
 * **Weight.** `WEIGHT.SAFETY` — pre-start situational information the driver
 * acts on (getting up to pace, closing the gap), but not a CRITICAL interrupt
 * like "lights are red".
 *
 * **Gating.** The contract's `where:` reuses `liveRaceCar` (race session + live
 * in the car), so the line stays silent in qualifying/practice, in a replay, or
 * while the user is out of the car at the grid. This is a rolling-start concept
 * only — standing starts have their own start-light gantry/countdown family.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getSessionType } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import { isRaceSession } from "./race-start.js";

// Rolling-start callouts are a race-only concept spoken to a driver in the car.
// Gate on the race session (iRacing can raise pace-car movement bits while
// forming the grid at the END of a qualifying session) and on `isLiveOnTrack`
// so the line stays silent while the user is out of the car at the grid or in a
// replay. Mirrors the start-light `liveRaceCar` predicate. Live-read at fire time.
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  isRaceSession(getSessionType()) && isLiveOnTrack(e.telemetry as TelemetryData | null);

const ROLLING_START_PACE_CAR: ScenarioContract = {
  id: "pit-crew.rolling-start-pace-car",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.SAFETY,
  family: "rolling-start",
  when: { event: "rollingStart.pace-car-moving.raised", where: liveRaceCar },
};

export const ROLLING_START_CONTRACTS: readonly ScenarioContract[] = [ROLLING_START_PACE_CAR];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const ROLLING_START_SCENARIO_IDS: readonly string[] = ROLLING_START_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the rolling-start script draws from — every
 * `pool:rolling-start/<base>` the bundled script may write, as a literal
 * list, since nothing derives it. The completeness tests read it: the
 * bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's
 * script and every pack's clip folder.
 */
export const ROLLING_START_CLIP_SOURCES: readonly { group: "rolling-start"; base: string }[] = [
  { group: "rolling-start", base: "pace-car-moving" },
];
