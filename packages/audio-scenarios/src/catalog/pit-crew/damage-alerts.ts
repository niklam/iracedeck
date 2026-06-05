/**
 * Damage-alert scenarios — fire when the sim translator publishes
 * `damage.repairNeeded.raised` after the rising-edge debounce on
 * `EngineWarnings & (MandRepNeeded | OptRepNeeded)` (issue #489).
 *
 * One scenario today (`pit-crew.damage-repair-needed`) drawing from a
 * single pool. The pool shape mirrors the flag pools so future variant
 * additions land as one-line appends in `pools.ts` without touching the
 * scenario.
 *
 * Default weight (`WEIGHT.NORMAL`) — higher-weight callouts (a meatball flag
 * at `WEIGHT.CRITICAL`) still win the bus over a damage heads-up, which matches
 * the use case (the flag carries the same signal more authoritatively).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { Scenario } from "../../dsl.js";

const DAMAGE_REPAIR_NEEDED: Scenario = {
  id: "pit-crew.damage-repair-needed",
  when: { event: "damage.repairNeeded.raised" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "damage",
  sequence: ["@pit-crew.radio-open", "pool:damage-repair-needed", "@pit-crew.radio-close"],
};

export const DAMAGE_ALERTS: readonly Scenario[] = [DAMAGE_REPAIR_NEEDED];
