/**
 * Damage-alert contract — fires when the sim translator publishes
 * `damage.repairNeeded.raised` after the rising-edge debounce on
 * `EngineWarnings & (MandRepNeeded | OptRepNeeded)` (issue #489; scripted
 * since #1065).
 *
 * One contract today (`pit-crew.damage-repair-needed`). The code below
 * decides WHEN it fires and how it is scheduled; WHAT is said lives in the
 * active voice's `callouts.json` under the same id, where the bundled script
 * draws the line from `pool:damage/repair-needed` — so adding a variant is a
 * clip-file change, and rephrasing it is a script change, neither touching
 * this file. No vocabulary is registered here — the line branches on nothing.
 *
 * Default weight (`WEIGHT.NORMAL`) — higher-weight callouts (a meatball flag
 * at `WEIGHT.CRITICAL`) still win the bus over a damage heads-up, which matches
 * the use case (the flag carries the same signal more authoritatively).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";

import type { ScenarioContract } from "../../dsl.js";

const DAMAGE_REPAIR_NEEDED: ScenarioContract = {
  id: "pit-crew.damage-repair-needed",
  when: { event: "damage.repairNeeded.raised" },
  description:
    "Your car takes damage that keeps the repair indicator lit for three seconds running, and again only after a repair has cleared it.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "damage",
};

export const DAMAGE_CONTRACTS: readonly ScenarioContract[] = [DAMAGE_REPAIR_NEEDED];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const DAMAGE_SCENARIO_IDS: readonly string[] = DAMAGE_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the damage script draws from. The completeness tests read
 * it: the bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's script
 * and every pack's clip folder.
 */
export const DAMAGE_CLIP_SOURCES: readonly { group: "damage"; base: string }[] = [
  { group: "damage", base: "repair-needed" },
];
